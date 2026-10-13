import {
  canonicalJson,
  nativePendingInput,
  type NativePendingInput,
} from '@/lib/nativePendingInput';
import type { StructuredAnswer } from './questions';
import { api, ApiError } from './api';
import type { WorkflowPackageHarness } from './workflowSources';
import type {
  IntentActivityEvent,
  IntentGraphEdge,
  IntentGraphNode,
  IntentOutput,
} from './intents';

export interface NativeActivityEvent extends IntentActivityEvent {
  revision: number;
}
export interface NativeActivityPage {
  outputs: IntentOutput[];
  nextAfter: number | null;
  // Additive. Older controllers have no lifecycle ledger.
  events?: NativeActivityEvent[];
  nextEventAfter?: number | null;
}

function validHistoryCursor(value: unknown, after: number, last?: number): boolean {
  return value === null || (Number.isSafeInteger(value) && value === last && Number(value) > after);
}

function validEvents(value: NativeActivityPage, after: number): boolean {
  if (value.events === undefined) return value.nextEventAfter === undefined;
  let previous = after;
  if (
    !Array.isArray(value.events) ||
    value.events.some((event) => {
      if (
        !record(event) ||
        !Number.isSafeInteger(event.revision) ||
        event.revision <= previous ||
        event.eventId !== `native-${event.revision}` ||
        typeof event.type !== 'string' ||
        !event.type.startsWith('native.') ||
        typeof event.summary !== 'string' ||
        typeof event.timestamp !== 'string' ||
        !Number.isFinite(Date.parse(event.timestamp))
      )
        return true;
      previous = event.revision;
      return false;
    })
  )
    return false;
  return validHistoryCursor(value.nextEventAfter, after, value.events.at(-1)?.revision);
}

const executionStatuses = [
  'REQUESTED',
  'UPGRADING',
  'DISPATCHING',
  'RUNNING',
  'RECOVERY_REQUIRED',
  'RECOVERING',
  'WAITING_FOR_INPUT',
  'AWAITING_USER',
  'STOPPED',
  'FAILED',
  'CANCEL_REQUESTED',
  'CANCELLED',
] as const;

const recoveryReasons = [
  'SESSION_LOST',
  'RESTORE_FAILED',
  'CHECKPOINT_UNAVAILABLE',
  'DELIVERY_UNCERTAIN',
] as const;

export interface NativeRecovery {
  id: string;
  reason: (typeof recoveryReasons)[number];
  canRecover: boolean;
}

export interface NativeRecoveryRequest {
  requestId: string;
  recoveryId: string;
}

export interface NativeExecution {
  imageStatus?: 'current' | 'retained' | 'revoked' | 'unapproved' | 'unavailable';
  status: (typeof executionStatuses)[number];
  attemptId: string;
  epoch: number;
  startedAt: string;
  updatedAt: string;
  model: string | null;
  repository: {
    provider: string;
    repository: string;
    branch: string | null;
    commit: string | null;
  };
  failureCode?: string;
  publicationId: string | null;
  projectionStatus: 'pending' | 'complete' | null;
  // Absent on the preparation / first-turn API. Absence never enables replies.
  interactionId?: string | null;
  turnSequence?: number;
  responsePending?: boolean;
  revision?: number;
  recovery?: NativeRecovery | null;
}

export interface NativeInteractionView {
  id: string;
  sequence: number;
  kind: 'assistant_turn';
  harness: WorkflowPackageHarness;
  publicationId: string;
  messages: { type: 'text'; text: string }[];
  /** Task-3: the structured question this turn presented, or null for free text. */
  pendingInput?: NativePendingInput | null;
  contentSha256: string;
  createdAt: string;
  response?: NativeUserReply | null;
}

export interface NativeUserReply {
  id: string;
  kind: 'user_reply';
  interactionId: string;
  sequence: number;
  actorId: string;
  text: string;
  acceptedAt: string;
  deliveryStatus: 'pending' | 'delivered' | 'unknown';
}

export interface NativeReplyAcceptance {
  execution: NativeExecution;
  response: NativeUserReply;
}

export interface NativeReplyRequest {
  requestId: string;
  interactionId: string;
  contentSha256: string;
  text: string;
  /** The member's structured selection; text is its canonical rendering. */
  selection?: StructuredAnswer;
}

export const NATIVE_REPLY_MAX_BYTES = 16 * 1024;
const encoder = new TextEncoder();
const ordinaryText = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  !Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 9 || code === 11 || code === 12 || (code > 13 && code < 32) || code === 127;
  }) &&
  new TextDecoder('utf-8', { ignoreBOM: true }).decode(encoder.encode(value)) === value;
export const nativeReplyTextValid = (value: string): boolean =>
  ordinaryText(value) &&
  value.trim().length > 0 &&
  encoder.encode(value).length <= NATIVE_REPLY_MAX_BYTES;

export interface NativePublishedFile {
  id: string;
  path: string;
  bytes: number;
  sha256: string;
  role: 'artifact' | 'code' | 'state' | 'question';
  mediaType: string;
}

export interface NativePublication {
  id: string;
  sequence: number;
  createdAt: string;
  files: NativePublishedFile[];
  question: { fileId: string; path: string; sha256: string } | null;
  projectionStatus: 'pending' | 'complete';
}

export interface NativeFileContent extends Omit<NativePublishedFile, 'role'> {
  encoding: 'utf8' | 'base64';
  content: string;
  publicationId: string;
}

export interface NativeGraph {
  publicationId: string;
  nodes: (IntentGraphNode & { interactionId?: string | null })[];
  edges: IntentGraphEdge[];
  traceability?: {
    contract: string;
    enrichment: 'off';
    relationships?: 'indexed' | 'structure_limit';
    files: {
      fileId: string;
      status: 'generic' | 'extracted' | 'incompatible' | 'byte_limit' | 'structure_limit';
    }[];
  };
}

export interface NativeDraftRequest {
  intentId: string;
  title: string;
  prompt: string;
  harness: WorkflowPackageHarness;
  sourceId: string;
  packageJobId: string;
  bindingRevision: string;
}

// The generic INVALID code also covers stored-row validation after a write.
// This marker describes only the current POST, never earlier uncertain attempts.
export const nativeDraftInputRejected = (error: unknown): boolean =>
  error instanceof ApiError &&
  error.body?.draftInputRejected === true &&
  ((error.status === 400 && error.body.code === 'NATIVE_PREPARATION_INVALID') ||
    (error.status === 413 && error.body.code === 'NATIVE_PREPARATION_BODY_TOO_LARGE'));

export interface NativePromptRequest {
  requestId: string;
  expectedRevision: number;
  prompt: string;
}
export const nativePromptValid = (prompt: string) =>
  Boolean(prompt.trim()) &&
  encoder.encode(prompt).length <= 65536 &&
  !prompt.includes('\0') &&
  new TextDecoder('utf-8', { ignoreBOM: true }).decode(encoder.encode(prompt)) === prompt;

export interface NativeIntent {
  id: string;
  projectId: string;
  executionBackend: 'native';
  title: string;
  prompt: string;
  // Absent on APIs predating prompt correction; those remain read-only.
  promptRevision?: number;
  harness: WorkflowPackageHarness;
  status: 'DRAFT' | 'PREPARING' | 'READY' | 'FAILED';
  package: {
    version: string;
    source: { provider: string; repository: string; release: string };
  };
  failureCode?: string;
  createdAt: string;
  updatedAt: string;
  // Optional only for compatibility with the preparation-only API.
  executionAvailable?: boolean;
  execution?: NativeExecution | null;
}

export type NativeIntentSummary = Omit<
  NativeIntent,
  'prompt' | 'promptRevision' | 'executionAvailable' | 'execution'
>;
export interface NativeIntentPage {
  items: NativeIntentSummary[];
  nextCursor: string | null;
}
export const NATIVE_INTENT_PAGE_SIZE = 25;
const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
const validCursor = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 2048 &&
  /^[A-Za-z0-9_-]+$/.test(value);

const path = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/native-intents`;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function summary(value: unknown, projectId: string, intentId: string): NativeIntentSummary {
  if (
    !record(value) ||
    value.projectId !== projectId ||
    value.id !== intentId ||
    value.executionBackend !== 'native' ||
    typeof value.title !== 'string' ||
    !validId(value.id) ||
    typeof value.harness !== 'string' ||
    !['claude', 'codex', 'kiro', 'opencode'].includes(String(value.harness)) ||
    typeof value.status !== 'string' ||
    !['DRAFT', 'PREPARING', 'READY', 'FAILED'].includes(String(value.status)) ||
    !record(value.package) ||
    typeof value.package.version !== 'string' ||
    !record(value.package.source) ||
    typeof value.package.source.provider !== 'string' ||
    !['github', 'gitlab', 'bitbucket'].includes(String(value.package.source.provider)) ||
    typeof value.package.source.repository !== 'string' ||
    typeof value.package.source.release !== 'string' ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    (value.failureCode !== undefined && typeof value.failureCode !== 'string')
  ) {
    throw new Error('The native intent status could not be verified.');
  }
  return {
    id: intentId,
    projectId,
    executionBackend: 'native',
    title: value.title,
    harness: value.harness as WorkflowPackageHarness,
    status: value.status as NativeIntent['status'],
    package: {
      version: value.package.version,
      source: {
        provider: String(value.package.source.provider),
        repository: value.package.source.repository,
        release: value.package.source.release,
      },
    },
    ...(typeof value.failureCode === 'string' ? { failureCode: value.failureCode } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function view(value: unknown, projectId: string, intentId: string): NativeIntent {
  const item = summary(value, projectId, intentId);
  if (
    !record(value) ||
    typeof value.prompt !== 'string' ||
    (value.promptRevision !== undefined &&
      (!Number.isSafeInteger(value.promptRevision) || Number(value.promptRevision) < 0)) ||
    (value.executionAvailable !== undefined && typeof value.executionAvailable !== 'boolean')
  ) {
    throw new Error('The native intent status could not be verified.');
  }
  return {
    ...item,
    prompt: value.prompt,
    ...(value.promptRevision !== undefined ? { promptRevision: Number(value.promptRevision) } : {}),
    ...(value.executionAvailable !== undefined
      ? { executionAvailable: value.executionAvailable }
      : {}),
    ...(value.execution !== undefined ? { execution: execution(value.execution) } : {}),
  };
}

const timestamp = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));
const nullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const relativePath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  !value.includes('\\') &&
  !Array.from(value).some((character) => character.charCodeAt(0) < 32) &&
  !value.split('/').some((part) => part === '' || part === '.' || part === '..');

function execution(value: unknown): NativeExecution | null {
  if (value === null) return null;
  const turnSequence = record(value) ? (value.turnSequence ?? value.sequence) : undefined;
  if (
    !record(value) ||
    !executionStatuses.includes(value.status as NativeExecution['status']) ||
    !validId(value.attemptId) ||
    !Number.isSafeInteger(value.epoch) ||
    Number(value.epoch) < 0 ||
    !timestamp(value.startedAt) ||
    !timestamp(value.updatedAt) ||
    !nullableString(value.model) ||
    !record(value.repository) ||
    typeof value.repository.provider !== 'string' ||
    typeof value.repository.repository !== 'string' ||
    !nullableString(value.repository.branch) ||
    !nullableString(value.repository.commit) ||
    (value.failureCode !== undefined && typeof value.failureCode !== 'string') ||
    (value.publicationId !== null && !validId(value.publicationId)) ||
    (value.interactionId !== undefined &&
      value.interactionId !== null &&
      !digest(value.interactionId)) ||
    (turnSequence !== undefined &&
      (!Number.isSafeInteger(turnSequence) || Number(turnSequence) < 1)) ||
    (value.turnSequence !== undefined &&
      (!Number.isSafeInteger(value.turnSequence) || Number(value.turnSequence) < 1)) ||
    (value.sequence !== undefined &&
      (!Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1)) ||
    (value.turnSequence !== undefined &&
      value.sequence !== undefined &&
      value.turnSequence !== value.sequence) ||
    (value.responsePending !== undefined && typeof value.responsePending !== 'boolean') ||
    (value.revision !== undefined &&
      (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0)) ||
    (value.status === 'AWAITING_USER' &&
      (!digest(value.interactionId) ||
        !value.publicationId ||
        turnSequence === undefined ||
        value.responsePending === true)) ||
    ![null, 'pending', 'complete'].includes(value.projectionStatus as string | null)
  ) {
    throw new Error('The native execution could not be verified.');
  }
  let recovery: NativeRecovery | null | undefined;
  if (value.recovery === null) recovery = null;
  else if (value.recovery !== undefined) {
    const candidate = value.recovery;
    if (
      !record(candidate) ||
      !validId(candidate.id) ||
      !recoveryReasons.includes(candidate.reason as NativeRecovery['reason']) ||
      typeof candidate.canRecover !== 'boolean' ||
      (candidate.canRecover && value.status !== 'RECOVERY_REQUIRED')
    )
      throw new Error('The native recovery status could not be verified.');
    recovery = {
      id: candidate.id,
      reason: candidate.reason as NativeRecovery['reason'],
      canRecover: candidate.canRecover,
    };
  }
  return {
    status: value.status as NativeExecution['status'],
    ...(value.imageStatus !== undefined
      ? {
          imageStatus: ['current', 'retained', 'revoked', 'unapproved', 'unavailable'].includes(
            String(value.imageStatus),
          )
            ? (value.imageStatus as NativeExecution['imageStatus'])
            : ('unavailable' as const),
        }
      : {}),
    attemptId: value.attemptId,
    epoch: Number(value.epoch),
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    model: value.model,
    repository: {
      provider: value.repository.provider,
      repository: value.repository.repository,
      branch: value.repository.branch,
      commit: value.repository.commit,
    },
    ...(typeof value.failureCode === 'string' ? { failureCode: value.failureCode } : {}),
    publicationId: value.publicationId as string | null,
    projectionStatus: value.projectionStatus as NativeExecution['projectionStatus'],
    ...(value.interactionId !== undefined
      ? { interactionId: value.interactionId as string | null }
      : {}),
    ...(turnSequence !== undefined ? { turnSequence: Number(turnSequence) } : {}),
    ...(value.responsePending !== undefined
      ? { responsePending: value.responsePending as boolean }
      : {}),
    ...(value.revision !== undefined ? { revision: Number(value.revision) } : {}),
    ...(recovery !== undefined ? { recovery } : {}),
  };
}

function userReply(value: unknown): NativeUserReply {
  if (
    !record(value) ||
    !uuid(value.id) ||
    value.kind !== 'user_reply' ||
    !digest(value.interactionId) ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 2 ||
    !validId(value.actorId) ||
    typeof value.text !== 'string' ||
    !nativeReplyTextValid(value.text) ||
    !timestamp(value.acceptedAt) ||
    !['pending', 'delivered', 'unknown'].includes(String(value.deliveryStatus)) ||
    typeof value.deliveryStatus !== 'string'
  )
    throw new Error('The accepted native reply could not be verified.');
  return {
    id: value.id,
    kind: 'user_reply',
    interactionId: value.interactionId,
    sequence: Number(value.sequence),
    actorId: value.actorId,
    text: value.text,
    acceptedAt: value.acceptedAt,
    deliveryStatus: value.deliveryStatus as NativeUserReply['deliveryStatus'],
  };
}

const invalidInteraction = () => new Error('The published AI-DLC response could not be verified.');
async function interaction(value: unknown): Promise<NativeInteractionView> {
  if (
    !record(value) ||
    !digest(value.id) ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 1 ||
    value.kind !== 'assistant_turn' ||
    !['claude', 'codex', 'kiro', 'opencode'].includes(String(value.harness)) ||
    typeof value.harness !== 'string' ||
    !validId(value.publicationId) ||
    !timestamp(value.createdAt) ||
    !digest(value.contentSha256) ||
    !Array.isArray(value.messages) ||
    value.messages.length < 1 ||
    value.messages.length > 256
  )
    throw invalidInteraction();
  let bytes = 0;
  const messages = value.messages.map(
    (message: unknown): NativeInteractionView['messages'][number] => {
      if (
        !record(message) ||
        Object.keys(message).length !== 2 ||
        message.type !== 'text' ||
        !ordinaryText(message.text)
      )
        throw invalidInteraction();
      bytes += encoder.encode(message.text).length;
      if (bytes > 64 * 1024) throw invalidInteraction();
      return { type: 'text', text: message.text };
    },
  );
  if (!messages.some((message) => message.text.trim())) throw invalidInteraction();
  let pendingInput: NativePendingInput | null = null;
  if (value.pendingInput != null) {
    try {
      pendingInput = nativePendingInput(value.pendingInput);
    } catch {
      throw invalidInteraction();
    }
  }
  // The server hashes canonical JSON (sorted keys); v2 covers the presented
  // question too. Verify the displayed bytes and options before binding a reply.
  const canonical = pendingInput
    ? canonicalJson({ messages, pendingInput })
    : JSON.stringify(messages.map(({ text, type }) => ({ text, type })));
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(canonical))),
  )
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  if (hash !== value.contentSha256) throw invalidInteraction();
  const response = value.response == null ? value.response : userReply(value.response);
  if (
    response &&
    (response.interactionId !== value.id || response.sequence !== Number(value.sequence) + 1)
  )
    throw invalidInteraction();
  return {
    id: value.id,
    sequence: Number(value.sequence),
    kind: 'assistant_turn',
    harness: value.harness as WorkflowPackageHarness,
    publicationId: value.publicationId,
    messages,
    pendingInput,
    contentSha256: value.contentSha256,
    createdAt: value.createdAt,
    ...(response !== undefined ? { response } : {}),
  };
}

function fileMetadata(value: unknown): Omit<NativePublishedFile, 'role'> {
  if (
    !record(value) ||
    !validId(value.id) ||
    !relativePath(value.path) ||
    !Number.isSafeInteger(value.bytes) ||
    Number(value.bytes) < 0 ||
    !digest(value.sha256) ||
    typeof value.mediaType !== 'string'
  ) {
    throw new Error('The native file metadata could not be verified.');
  }
  return {
    id: value.id,
    path: value.path,
    bytes: Number(value.bytes),
    sha256: value.sha256,
    mediaType: value.mediaType,
  };
}

function publication(value: unknown): NativePublication {
  if (
    !record(value) ||
    !validId(value.id) ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 0 ||
    !timestamp(value.createdAt) ||
    !Array.isArray(value.files) ||
    typeof value.projectionStatus !== 'string' ||
    !['pending', 'complete'].includes(value.projectionStatus)
  ) {
    throw new Error('The native publication could not be verified.');
  }
  const ids = new Set<string>();
  const paths = new Set<string>();
  const files = value.files.map((file: unknown): NativePublishedFile => {
    const metadata = fileMetadata(file);
    if (
      !record(file) ||
      typeof file.role !== 'string' ||
      !['artifact', 'code', 'state', 'question'].includes(file.role) ||
      ids.has(metadata.id) ||
      paths.has(metadata.path)
    ) {
      throw new Error('The native publication contains invalid or duplicate files.');
    }
    ids.add(metadata.id);
    paths.add(metadata.path);
    return { ...metadata, role: file.role as NativePublishedFile['role'] };
  });
  let question: NativePublication['question'] = null;
  if (value.question !== null) {
    const candidate = value.question;
    if (
      !record(candidate) ||
      !validId(candidate.fileId) ||
      !relativePath(candidate.path) ||
      !digest(candidate.sha256) ||
      !files.some(
        (file) =>
          file.id === candidate.fileId &&
          file.path === candidate.path &&
          file.sha256 === candidate.sha256,
      )
    ) {
      throw new Error('The native question is not part of this publication.');
    }
    question = { fileId: candidate.fileId, path: candidate.path, sha256: candidate.sha256 };
  }
  return {
    id: value.id,
    sequence: Number(value.sequence),
    createdAt: value.createdAt,
    files,
    question,
    projectionStatus: value.projectionStatus as NativePublication['projectionStatus'],
  };
}

function fileContent(value: unknown, fileId: string): NativeFileContent {
  const metadata = fileMetadata(value);
  if (
    !record(value) ||
    metadata.id !== fileId ||
    !validId(value.publicationId) ||
    typeof value.encoding !== 'string' ||
    !['utf8', 'base64'].includes(value.encoding) ||
    typeof value.content !== 'string' ||
    (value.encoding === 'base64' &&
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.content))
  ) {
    throw new Error('The native file content could not be verified.');
  }
  return {
    ...metadata,
    publicationId: value.publicationId,
    encoding: value.encoding as NativeFileContent['encoding'],
    content: value.content,
  };
}

function graph(value: unknown): NativeGraph {
  if (
    !record(value) ||
    !validId(value.publicationId) ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.edges)
  ) {
    throw new Error('The native graph could not be verified.');
  }
  const ids = new Set<string>();
  const nodes = value.nodes.map((node: unknown): NativeGraph['nodes'][number] => {
    if (
      !record(node) ||
      typeof node.id !== 'string' ||
      !node.id ||
      ids.has(node.id) ||
      typeof node.type !== 'string' ||
      typeof node.label !== 'string' ||
      (node.artifactId !== undefined && !nullableString(node.artifactId)) ||
      (node.interactionId !== undefined &&
        node.interactionId !== null &&
        !digest(node.interactionId)) ||
      (node.interactionId && node.artifactId)
    ) {
      throw new Error('The native graph contains an invalid node.');
    }
    ids.add(node.id);
    return {
      ...node,
      id: node.id,
      type: node.type,
      label: node.label,
      ...(node.interactionId !== undefined
        ? { interactionId: node.interactionId as string | null }
        : {}),
    };
  });
  const edges = value.edges.map((edge: unknown): IntentGraphEdge => {
    if (
      !record(edge) ||
      typeof edge.source !== 'string' ||
      typeof edge.target !== 'string' ||
      typeof edge.label !== 'string' ||
      !ids.has(edge.source) ||
      !ids.has(edge.target)
    ) {
      throw new Error('The native graph contains an invalid edge.');
    }
    return { source: edge.source, target: edge.target, label: edge.label };
  });
  return { publicationId: value.publicationId, nodes, edges };
}

const itemPath = (projectId: string, intentId: string) =>
  `${path(projectId)}/${encodeURIComponent(intentId)}`;

export const nativeIntentsService = {
  async outputs(
    projectId: string,
    intentId: string,
    afterSeq = 0,
    afterEvent?: number,
  ): Promise<NativeActivityPage> {
    const value = await api.get<NativeActivityPage>(
      `${path(projectId)}/${encodeURIComponent(intentId)}/outputs?afterSeq=${afterSeq}${
        afterEvent === undefined ? '' : `&afterEvent=${afterEvent}`
      }`,
    );
    if (
      !record(value) ||
      !Array.isArray(value.outputs) ||
      value.outputs.some(
        (row) =>
          !record(row) ||
          !Number.isSafeInteger(row.seq) ||
          row.seq <= afterSeq ||
          typeof row.content !== 'string',
      ) ||
      value.outputs.some((row, index) => index > 0 && row.seq <= value.outputs[index - 1].seq) ||
      !validHistoryCursor(value.nextAfter, afterSeq, value.outputs.at(-1)?.seq) ||
      !validEvents(value, afterEvent ?? 0)
    )
      throw new Error('Invalid native output history');
    return value;
  },
  async list(projectId: string, cursor: string | null = null): Promise<NativeIntentPage> {
    if (!validId(projectId) || (cursor !== null && !validCursor(cursor))) {
      throw new Error('The native intent list request is invalid.');
    }
    const query = new URLSearchParams({ view: 'list', limit: String(NATIVE_INTENT_PAGE_SIZE) });
    if (cursor !== null) query.set('cursor', cursor);
    const value = await api.get<unknown>(`${path(projectId)}?${query}`);
    if (
      !record(value) ||
      !Array.isArray(value.items) ||
      value.items.length > NATIVE_INTENT_PAGE_SIZE ||
      (value.nextCursor !== null && !validCursor(value.nextCursor)) ||
      (cursor !== null && value.nextCursor === cursor)
    ) {
      throw new Error('The native intent list could not be verified.');
    }
    const ids = new Set<string>();
    const items = value.items.map((item: unknown) => {
      if (!record(item) || !validId(item.id) || ids.has(item.id)) {
        throw new Error('The native intent list contains an invalid or duplicate identity.');
      }
      ids.add(item.id);
      return summary(item, projectId, item.id);
    });
    return { items, nextCursor: value.nextCursor as string | null };
  },
  async canPrepare(projectId: string): Promise<boolean> {
    const result = await api.get<unknown>(path(projectId));
    return (
      record(result) &&
      result.preparationEnabled === true &&
      typeof result.executionEnabled === 'boolean'
    );
  },
  async create(projectId: string, request: NativeDraftRequest): Promise<NativeIntent> {
    return view(await api.post(path(projectId), request), projectId, request.intentId);
  },
  async get(projectId: string, intentId: string): Promise<NativeIntent> {
    return view(
      await api.get(`${path(projectId)}/${encodeURIComponent(intentId)}`),
      projectId,
      intentId,
    );
  },
  async prepare(projectId: string, intentId: string): Promise<NativeIntent> {
    return view(
      await api.post(`${path(projectId)}/${encodeURIComponent(intentId)}/prepare`, {}),
      projectId,
      intentId,
    );
  },
  async savePrompt(
    projectId: string,
    intentId: string,
    request: NativePromptRequest,
  ): Promise<NativeIntent> {
    if (
      !uuid(request.requestId) ||
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 0 ||
      request.expectedRevision >= Number.MAX_SAFE_INTEGER ||
      !nativePromptValid(request.prompt)
    )
      throw new Error('Enter a nonblank prompt of at most 64 KiB without null characters.');
    const value = await api.post<unknown>(`${itemPath(projectId, intentId)}/prompt`, request);
    const next = view(value, projectId, intentId);
    if (
      !record(value) ||
      !record(value.promptAcceptance) ||
      value.promptAcceptance.requestId !== request.requestId ||
      value.promptAcceptance.prompt !== request.prompt ||
      value.promptAcceptance.revision !== request.expectedRevision + 1 ||
      next.promptRevision === undefined ||
      next.promptRevision < request.expectedRevision + 1 ||
      (next.promptRevision === request.expectedRevision + 1 && next.prompt !== request.prompt)
    )
      throw new Error('Prompt saving could not be confirmed. Retry the same save.');
    return next;
  },
  async start(
    projectId: string,
    intentId: string,
    requestId: string,
    promptRevision?: number,
  ): Promise<NativeIntent> {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestId) ||
      (promptRevision !== undefined &&
        (!Number.isSafeInteger(promptRevision) || promptRevision < 0))
    ) {
      throw new Error('The native start request identity is invalid.');
    }
    return view(
      await api.post(`${itemPath(projectId, intentId)}/start`, {
        requestId,
        ...(promptRevision !== undefined ? { promptRevision } : {}),
      }),
      projectId,
      intentId,
    );
  },
  async cancel(projectId: string, intentId: string): Promise<NativeIntent> {
    return view(await api.post(`${itemPath(projectId, intentId)}/cancel`, {}), projectId, intentId);
  },
  async recover(
    projectId: string,
    intentId: string,
    request: NativeRecoveryRequest,
  ): Promise<NativeIntent> {
    if (!uuid(request.requestId) || !validId(request.recoveryId))
      throw new Error('The native recovery request is invalid.');
    const next = view(
      await api.post(`${itemPath(projectId, intentId)}/recover`, {
        requestId: request.requestId,
        recoveryId: request.recoveryId,
      }),
      projectId,
      intentId,
    );
    if (
      !next.execution ||
      next.execution.revision === undefined ||
      (next.execution.recovery && next.execution.recovery.id !== request.recoveryId)
    )
      throw new Error('Native recovery acceptance could not be verified.');
    return next;
  },
  async publication(projectId: string, intentId: string): Promise<NativePublication> {
    return publication(await api.get(`${itemPath(projectId, intentId)}/publication`));
  },
  async interaction(projectId: string, intentId: string): Promise<NativeInteractionView> {
    return interaction(await api.get(`${itemPath(projectId, intentId)}/interaction`));
  },
  async respond(
    projectId: string,
    intentId: string,
    request: NativeReplyRequest,
  ): Promise<NativeReplyAcceptance> {
    if (
      !uuid(request.requestId) ||
      !digest(request.interactionId) ||
      !digest(request.contentSha256) ||
      !nativeReplyTextValid(request.text)
    ) {
      throw new Error('The native reply request is invalid.');
    }
    const value = await api.post<unknown>(`${itemPath(projectId, intentId)}/response`, {
      requestId: request.requestId,
      interactionId: request.interactionId,
      contentSha256: request.contentSha256,
      text: request.text,
      ...(request.selection ? { selection: request.selection } : {}),
    });
    if (
      !record(value) ||
      value.executionAvailable !== true ||
      (value.projectId !== undefined && value.projectId !== projectId) ||
      (value.id !== undefined && value.id !== intentId)
    ) {
      throw new Error('Native reply acceptance could not be verified.');
    }
    const next = execution(value.execution);
    const response = userReply(value.response);
    if (
      !next ||
      next.turnSequence === undefined ||
      next.turnSequence < response.sequence ||
      response.interactionId !== request.interactionId ||
      response.text !== request.text
    )
      throw new Error('Native reply acceptance could not be verified.');
    return { execution: next, response };
  },
  async file(projectId: string, intentId: string, fileId: string): Promise<NativeFileContent> {
    if (!validId(fileId)) throw new Error('The native file request is invalid.');
    return fileContent(
      await api.get(`${itemPath(projectId, intentId)}/files/${encodeURIComponent(fileId)}`),
      fileId,
    );
  },
  async graph(projectId: string, intentId: string): Promise<NativeGraph> {
    return graph(await api.get(`${itemPath(projectId, intentId)}/graph`));
  },
};
