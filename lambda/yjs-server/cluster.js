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
    this.claimsInFlight = 0;
    this.operations = new Map();
  }

  get ready() {
    return this.available && this.readyAt + this.leaseMs > this.clock() + this.safetyMs;
  }

  async start(manager) {
    this.manager = manager;
    await this.tick();
    this.timer = setInterval(() => {
      // Each lane is single-flight, but a slow checkpoint/transfer or lease
      // renewal must not stall the next membership heartbeat.
      for (const [name, work] of [
        ['membership', () => this.refreshMembership()],
        ['renewals', () => this.renewLeases()],
        ['transfers', () => this.rebalance()],
      ])
        this.singleFlight(name, work).catch((error) =>
          this.logger.error(`Yjs ${name} failed:`, error.message),
        );
    }, this.heartbeatMs);
    this.timer.unref?.();
  }

  singleFlight(name, work) {
    if (this.operations.has(name)) return this.operations.get(name);
    const operation = Promise.resolve()
      .then(work)
      .finally(() => this.operations.delete(name));
    this.operations.set(name, operation);
    return operation;
  }

  async tick() {
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = Promise.all([
      this.singleFlight('membership', () => this.refreshMembership()),
      this.singleFlight('renewals', () => this.renewLeases()),
    ])
      .then(() => this.singleFlight('transfers', () => this.rebalance()))
      .finally(() => {
        this.tickPromise = null;
      });
    return this.tickPromise;
  }

  async refreshMembership() {
    try {
      const now = this.clock();
      await this.store.register({
        id: this.id,
        address: this.address,
        draining: this.draining,
        documents: this.leases.size + this.claimsInFlight,
        maxDocuments: this.manager.config.maxDocuments,
        acceptingDocuments: this.acceptingDocuments(),
        expiresAt: Math.ceil((now + this.leaseMs) / 1000),
      });
      this.members = await this.store.members(now);
      this.available = true;
      this.readyAt = now;
    } catch (error) {
      this.available = false;
      throw error;
    }
  }

  async renewLeases() {
    // Earliest deadline first. Sixteen independent consumers avoid a slow
    // request holding up an entire batch of otherwise healthy documents.
    const leases = [...this.leases.values()].toSorted((a, b) => a.leaseUntil - b.leaseUntil);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(16, leases.length) }, async () => {
        while (next < leases.length) {
          const lease = leases[next++];
          if (this.leases.get(lease.documentId) !== lease) continue;
          try {
            const now = this.clock();
            const until = now + this.leaseMs;
            await this.store.renew(lease, until, now);
            lease.leaseUntil = until;
          } catch (error) {
            if (
              error.name === 'ConditionalCheckFailedException' ||
              (error.name === 'TransactionCanceledException' &&
                !isTransientTransactionCancellation(error))
            )
              lease.leaseUntil = 0;
            if (!this.owns(lease)) {
              if (this.leases.get(lease.documentId) === lease) this.leases.delete(lease.documentId);
              const room = this.manager?.rooms.get(lease.documentId);
              if (room?.lease === lease) this.manager.destroy(room);
            }
            this.logger.warn(
              'Yjs lease renewal failed:',
              error.name,
              error.CancellationReasons?.map((reason) => reason.Code).join(',') ?? '',
            );
          }
        }
      }),
    );
  }

  acceptingDocuments() {
    if (this.leases.size + this.claimsInFlight >= this.manager.config.maxDocuments) return false;
    try {
      this.manager.checkCapacity(0);
      return true;
    } catch {
      return false;
    }
  }

  hasRoom(member) {
    if (member.id === this.id) return this.acceptingDocuments();
    return (
      member.acceptingDocuments !== false &&
      (member.documents ?? 0) < (member.maxDocuments ?? Infinity)
    );
  }

  async rebalance() {
    if (this.draining || !this.ready || !this.manager) return;
    const moves = [...this.manager.rooms.values()]
      .filter((room) => {
        const destination = ownerFor(room.name, this.members);
        return destination && destination.id !== this.id && this.hasRoom(destination);
      })
      .slice(0, 4);
    await Promise.all(
      moves.map((room) =>
        this.manager.evict(room).catch((error) => {
          this.logger.warn('Yjs ownership transfer deferred:', error.message);
        }),
      ),
    );
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
    if ((await this.store.get(scopeKey(docName)))?.deletedAt)
      throw new Error('Document scope was deleted');
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
      this.members.filter(
        (member) => member.expiresAt * 1000 > this.clock() && this.hasRoom(member),
      ),
    );
    if (!candidate) throw new Error('No document owner available');
    if (!routed && candidate.id !== this.id) return { remote: candidate };
    if (!this.acceptingDocuments()) {
      throw Object.assign(new Error('Document owner at capacity'), { code: 'YJS_OWNER_CAPACITY' });
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
    // Reserve a slot before awaiting DynamoDB so simultaneous cold joins
    // cannot all pass the same last-slot check.
    this.claimsInFlight++;
    try {
      const acquired = await this.store.claim(lease, this.clock());
      if (acquired?.leaseToken !== lease.leaseToken) throw new Error('Document ownership changed');
      Object.assign(lease, acquired);
      this.leases.set(docName, lease);
      return { lease };
    } finally {
      this.claimsInFlight--;
    }
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
    await Promise.allSettled(this.operations.values());
    await this.store.unregister(this.id).catch(() => {});
    this.available = false;
    return result;
  }
}
