import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { requiredScopeForYjsDoc } from './realtime-token.js';

export const isTransientTransactionCancellation = (error) => {
  if (error.name !== 'TransactionCanceledException') return false;
  const codes = error.CancellationReasons?.map((reason) => reason.Code);
  const transient = new Set([
    'TransactionConflict',
    'ProvisionedThroughputExceeded',
    'ThrottlingError',
  ]);
  return (
    !!codes?.some((code) => transient.has(code)) &&
    codes.every((code) => code === 'None' || transient.has(code))
  );
};

export const scopeKey = (docName) => {
  const scope = requiredScopeForYjsDoc(docName);
  if (!scope) throw new Error('Unknown document scope');
  return `scope#${scope}`;
};

export const snapshotPrefix = (docName) => {
  const scope = requiredScopeForYjsDoc(docName);
  if (!scope) throw new Error('Unknown document scope');
  const [type, id] = scope.split(':');
  return `yjs-documents/${type}/${id}/${createHash('sha256').update(docName).digest('hex')}/`;
};

export const ownerFor = (docName, members) =>
  members
    .filter((member) => !member.draining)
    .map((member) => ({
      member,
      score: createHash('sha256').update(`${docName}\0${member.id}`).digest('hex'),
    }))
    .toSorted((a, b) => (a.score < b.score ? 1 : a.score > b.score ? -1 : 0))[0]?.member;

export const routeHeader = (secret, docName, target, now = Date.now()) => {
  const timestamp = Math.floor(now / 1000);
  const signature = createHmac('sha256', secret)
    .update(`${docName}\0${target}\0${timestamp}`)
    .digest('hex');
  return `${timestamp}.${signature}`;
};

export const verifyRoute = (header, secret, docName, target, now = Date.now()) => {
  if (typeof header !== 'string' || !/^\d{10}\.[a-f0-9]{64}$/.test(header)) return false;
  const timestamp = Number(header.split('.')[0]);
  if (Math.abs(now / 1000 - timestamp) > 15) return false;
  const expected = routeHeader(secret, docName, target, timestamp * 1000);
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
};

export class ClusterCoordinator {
  constructor({
    store,
    id = randomUUID(),
    address,
    clock = Date.now,
    leaseMs = 30_000,
    safetyMs = 5000,
    heartbeatMs = 10_000,
    logger = console,
  }) {
    this.store = store;
    this.id = id;
    this.address = address;
    this.clock = clock;
    this.leaseMs = leaseMs;
    this.safetyMs = safetyMs;
    this.heartbeatMs = heartbeatMs;
    this.logger = logger;
    this.leases = new Map();
    this.members = [];
    this.available = false;
    this.readyAt = 0;
    this.draining = false;
    this.tickPromise = null;
    this.timer = null;
    this.resolving = new Map();
  }

  get ready() {
    return this.available && this.readyAt + this.leaseMs > this.clock() + this.safetyMs;
  }

  async start(manager) {
    this.manager = manager;
    await this.tick();
    this.timer = setInterval(() => {
      this.tick().catch((error) =>
        this.logger.error('Yjs cluster heartbeat failed:', error.message),
      );
    }, this.heartbeatMs);
    this.timer.unref?.();
  }

  async tick() {
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = this.refresh().finally(() => {
      this.tickPromise = null;
    });
    return this.tickPromise;
  }

  async refresh() {
    try {
      const now = this.clock();
      await this.store.register({
        id: this.id,
        address: this.address,
        draining: this.draining,
        expiresAt: Math.ceil((now + this.leaseMs) / 1000),
      });
      this.members = await this.store.members(now);
      // Bound concurrent requests so a busy task doesn't flood DynamoDB at each
      // heartbeat. Writes are per owner/document, never per connected peer.
      const leases = [...this.leases.values()];
      for (let offset = 0; offset < leases.length; offset += 16) {
        await Promise.all(
          leases.slice(offset, offset + 16).map(async (lease) => {
            try {
              const until = this.clock() + this.leaseMs;
              await this.store.renew(lease, until, this.clock());
              lease.leaseUntil = until;
            } catch (error) {
              // A conflict does not revoke the last confirmed lease. Keep its
              // deadline unchanged; the normal safety margin still stops edits
              // if renewal cannot succeed before that deadline.
              if (
                error.name === 'ConditionalCheckFailedException' ||
                (error.name === 'TransactionCanceledException' &&
                  !isTransientTransactionCancellation(error))
              ) {
                lease.leaseUntil = 0;
              }
              if (!this.owns(lease)) {
                this.leases.delete(lease.documentId);
                const room = this.manager?.rooms.get(lease.documentId);
                if (room?.lease === lease) this.manager.destroy(room);
              }
              this.logger.warn(
                'Yjs lease renewal failed:',
                error.name,
                error.CancellationReasons?.map((reason) => reason.Code).join(',') ?? '',
              );
            }
          }),
        );
      }
      this.available = true;
      this.readyAt = now;
      if (!this.draining && this.manager) {
        // Stable ownership changes only through checkpoint + release. Limit
        // transfers per heartbeat to avoid reconnecting the whole fleet at once.
        const moves = [...this.manager.rooms.values()]
          .filter((room) => ownerFor(room.name, this.members)?.id !== this.id)
          .slice(0, 4);
        await Promise.all(
          moves.map((room) =>
            this.manager.evict(room).catch((error) => {
              this.logger.warn('Yjs ownership transfer deferred:', error.message);
            }),
          ),
        );
      }
    } catch (error) {
      this.available = false;
      throw error;
    }
  }

  owns(lease) {
    return (
      !!lease &&
      lease.ownerId === this.id &&
      this.leases.get(lease.documentId) === lease &&
      lease.leaseUntil > this.clock() + this.safetyMs
    );
  }

  async resolve(docName, routed = false) {
    if (this.resolving.has(docName)) return this.resolving.get(docName);
    const resolving = this.resolveOwner(docName, routed).finally(() => {
      this.resolving.delete(docName);
    });
    this.resolving.set(docName, resolving);
    return resolving;
  }

  async resolveOwner(docName, routed) {
    if (!this.ready || this.draining) throw new Error('Cluster is not ready');
    const local = this.leases.get(docName);
    if (this.owns(local)) return { lease: local };
    const record = await this.store.get(docName);
    if (record?.leaseUntil > this.clock()) {
      if (record.ownerId === this.id) {
        // A lease may have been acquired by another simultaneous join.
        const acquired = this.leases.get(docName);
        if (this.owns(acquired)) return { lease: acquired };
        throw new Error('Ownership is being established');
      }
      return { remote: { id: record.ownerId, address: record.ownerAddress } };
    }
    const candidate = ownerFor(
      docName,
      this.members.filter((member) => member.expiresAt * 1000 > this.clock()),
    );
    if (!candidate) throw new Error('No document owner available');
    if (!routed && candidate.id !== this.id) return { remote: candidate };
    if (this.leases.size >= this.manager.config.maxDocuments) {
      throw new Error('Document owner at capacity');
    }
    const lease = {
      documentId: docName,
      ownerId: this.id,
      ownerAddress: this.address,
      leaseToken: randomUUID(),
      leaseUntil: this.clock() + this.leaseMs,
    };
    // The store fences acquisition against both an existing lease and a
    // deleted scope. A conditional conflict is retried on a later connection.
    const acquired = await this.store.claim(lease, this.clock());
    if (acquired?.leaseToken !== lease.leaseToken) throw new Error('Document ownership changed');
    Object.assign(lease, acquired);
    this.leases.set(docName, lease);
    return { lease };
  }

  load(lease) {
    if (!this.owns(lease)) throw new Error('Lease expired before recovery');
    return this.store.load(lease);
  }

  async save(lease, snapshot) {
    if (!this.owns(lease)) throw new Error('Lease expired before checkpoint');
    const stored = await this.store.save(lease, snapshot, this.clock());
    Object.assign(lease, stored);
  }

  async release(lease) {
    // A lost response may still mean the release committed. Relinquish local
    // authority before the request, so we cannot serve beside a new owner.
    if (this.leases.get(lease.documentId) === lease) this.leases.delete(lease.documentId);
    await this.store.release(lease);
  }

  async stop() {
    this.draining = true;
    // Finish any renewal before releasing leases. Otherwise it could extend a
    // lease after the drain, delaying failover unnecessarily.
    await this.tickPromise?.catch(() => {});
    await this.store
      .register({
        id: this.id,
        address: this.address,
        draining: true,
        expiresAt: Math.ceil((this.clock() + this.leaseMs) / 1000),
      })
      .catch(() => {});
    const result = await this.manager.drain();
    clearInterval(this.timer);
    await this.tickPromise?.catch(() => {});
    await this.store.unregister(this.id).catch(() => {});
    this.available = false;
    return result;
  }
}
