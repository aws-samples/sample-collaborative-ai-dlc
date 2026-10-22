import { api } from './api';
import {
  decodeNativeInteraction,
  decodeNativePublication,
  nativeReplyTextValid,
  type NativeInteractionView,
  type NativePublication,
  type NativePublishedFile,
} from './nativeIntents';

export const NATIVE_INLINE_BYTES = 3 * 1024 * 1024;
export interface NativeRevisionTarget {
  publicationId: string;
  publicationSequence: number;
}
export interface NativeRevision extends Omit<NativePublication, 'projectionStatus'> {
  context: {
    projectId: string;
    executionId: string;
    attemptId: string;
    epoch: number;
    packageId: string;
  };
  outcome: 'STOPPED' | 'WAITING_FOR_INPUT';
  interactionId: string | null;
}
export interface NativeRevisionFile
  extends Omit<NativePublishedFile, 'role'>, NativeRevisionTarget {
  encoding: 'utf8' | 'binary' | 'too_large';
  content: string | null;
  truncated: false;
}
export interface NativeSourceBaseline {
  id: string;
  repository: { commit: string; branch: string };
  inventory: 'native-public-files';
  files: NativePublishedFile[];
}
export interface NativePublicationPage {
  items: {
    id: string;
    sequence: number;
    filesCount: number;
    outcome: string;
    epoch: number;
    admittedAt: number | null;
    interactionId: string | null;
  }[];
  nextBefore: number | null;
  gaps: { from: number; to: number }[];
}
export interface NativeAnswerHistory {
  id: string;
  interactionId: string;
  sequence: number;
  actorId: string;
  text: string;
  acceptedAt: string;
  context: NativeRevisionTarget & {
    contentSha256: string;
    epoch: number;
    membershipRecorded: boolean;
  };
  deliveryStatus: 'pending' | 'delivered' | 'uncertain' | 'unknown';
  deliveredAt: string | null;
  uncertainAt: string | null;
  resultingPublication: (NativeRevisionTarget & { recordedAt: string }) | null;
  resumeRetention?: {
    recordedAt: string;
    delivery: 'delivered' | 'uncertain' | 'undelivered';
  };
  applicationStatus: 'not_recorded';
  rejectionStatus: 'not_recorded';
  approvalStatus: 'not_recorded';
}
export interface NativeDecisionHistory {
  interaction: NativeInteractionView | null;
  answer: NativeAnswerHistory | null;
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const date = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
function invalid(): never {
  throw new Error('The named revision or its history could not be verified.');
}
const base = (projectId: string, intentId: string) =>
  `/projects/${encodeURIComponent(projectId)}/native-intents/${encodeURIComponent(intentId)}`;
const query = (target: NativeRevisionTarget) => {
  if (!sha(target.publicationId) || !positive(target.publicationSequence)) invalid();
  return new URLSearchParams({
    publicationId: target.publicationId,
    publicationSequence: String(target.publicationSequence),
  }).toString();
};

function answerHistory(
  value: unknown,
  turn: NativeInteractionView,
  target: NativeRevisionTarget,
): NativeAnswerHistory | null {
  if (value === null) return null;
  if (
    !record(value) ||
    !record(value.context) ||
    typeof value.id !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(value.id) ||
    value.interactionId !== turn.id ||
    value.sequence !== turn.sequence + 1 ||
    typeof value.actorId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/.test(value.actorId) ||
    typeof value.text !== 'string' ||
    !nativeReplyTextValid(value.text) ||
    !date(value.acceptedAt) ||
    value.context.publicationId !== target.publicationId ||
    value.context.publicationSequence !== target.publicationSequence ||
    value.context.contentSha256 !== turn.contentSha256 ||
    !positive(value.context.epoch) ||
    typeof value.context.membershipRecorded !== 'boolean' ||
    !['pending', 'delivered', 'uncertain', 'unknown'].includes(String(value.deliveryStatus)) ||
    ![value.deliveredAt, value.uncertainAt].every((v) => v === null || date(v)) ||
    value.applicationStatus !== 'not_recorded' ||
    value.rejectionStatus !== 'not_recorded' ||
    value.approvalStatus !== 'not_recorded'
  )
    invalid();
  const result = value.resultingPublication;
  if (
    result !== null &&
    (!record(result) ||
      !sha(result.publicationId) ||
      result.publicationSequence !== value.sequence ||
      !date(result.recordedAt))
  )
    invalid();
  if (value.deliveredAt && value.deliveryStatus !== 'delivered') invalid();
  if (
    value.resumeRetention !== undefined &&
    (!record(value.resumeRetention) ||
      !date(value.resumeRetention.recordedAt) ||
      !['delivered', 'uncertain', 'undelivered'].includes(String(value.resumeRetention.delivery)))
  )
    invalid();
  return value as unknown as NativeAnswerHistory;
}

export const nativeHistoryService = {
  async source(
    projectId: string,
    intentId: string,
    revision: NativeRevisionTarget,
  ): Promise<NativeSourceBaseline | null> {
    const value = await api.get<unknown>(
      `${base(projectId, intentId)}/publication?${query(revision)}&source=1`,
    );
    if (
      !record(value) ||
      value.projectId !== projectId ||
      value.executionId !== intentId ||
      value.publicationId !== revision.publicationId ||
      value.publicationSequence !== revision.publicationSequence
    )
      invalid();
    if (value.status === 'not_retained' && value.baseline === null) return null;
    const b = value.baseline;
    if (
      value.status !== 'captured' ||
      !record(b) ||
      !sha(b.id) ||
      b.inventory !== 'native-public-files' ||
      !record(b.repository) ||
      typeof b.repository.commit !== 'string' ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(b.repository.commit) ||
      typeof b.repository.branch !== 'string' ||
      !b.repository.branch
    )
      invalid();
    const inventory = decodeNativePublication({
      id: b.id,
      sequence: 1,
      createdAt: '1980-01-01T00:00:00.000Z',
      files: b.files,
      question: null,
      projectionStatus: 'pending',
    });
    return {
      id: b.id,
      repository: b.repository as NativeSourceBaseline['repository'],
      inventory: 'native-public-files',
      files: inventory.files,
    };
  },
  async list(
    projectId: string,
    intentId: string,
    before: number | null = null,
  ): Promise<NativePublicationPage> {
    if (before !== null && !positive(before)) invalid();
    const value = await api.get<unknown>(
      `${base(projectId, intentId)}/publication?history=1${before === null ? '' : `&beforeSequence=${before}`}`,
    );
    if (
      !record(value) ||
      !Array.isArray(value.items) ||
      value.items.length > 32 ||
      !Array.isArray(value.gaps)
    )
      invalid();
    let previous = before ?? Number.MAX_SAFE_INTEGER;
    for (const item of value.items) {
      if (
        !record(item) ||
        !sha(item.id) ||
        !positive(item.sequence) ||
        item.sequence >= previous ||
        !Number.isSafeInteger(item.filesCount) ||
        Number(item.filesCount) < 0 ||
        Number(item.filesCount) > 1000 ||
        !positive(item.epoch) ||
        !['STOPPED', 'WAITING_FOR_INPUT'].includes(String(item.outcome)) ||
        (item.admittedAt !== null &&
          (!Number.isSafeInteger(item.admittedAt) ||
            !Number.isFinite(new Date(Number(item.admittedAt)).getTime()))) ||
        (item.interactionId !== null && !sha(item.interactionId))
      )
        invalid();
      previous = item.sequence;
    }
    if (value.nextBefore !== null && (value.nextBefore !== previous || !value.items.length))
      invalid();
    for (const gap of value.gaps)
      if (!record(gap) || !positive(gap.from) || !positive(gap.to) || gap.from > gap.to) invalid();
    return value as unknown as NativePublicationPage;
  },
  async revision(
    projectId: string,
    intentId: string,
    target: NativeRevisionTarget,
  ): Promise<NativeRevision> {
    const value = await api.get<unknown>(
      `${base(projectId, intentId)}/publication?${query(target)}`,
    );
    // Reuse the inventory decoder; historical reads deliberately carry no
    // current graph projection status.
    if (!record(value)) invalid();
    const { projectionStatus: _projectionStatus, ...publication } = decodeNativePublication({
      ...value,
      projectionStatus: 'pending',
    });
    if (
      !record(value) ||
      !record(value.context) ||
      publication.id !== target.publicationId ||
      publication.sequence !== target.publicationSequence ||
      value.context.projectId !== projectId ||
      value.context.executionId !== intentId ||
      typeof value.context.attemptId !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(value.context.attemptId) ||
      !positive(value.context.epoch) ||
      typeof value.context.packageId !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(value.context.packageId) ||
      (value.interactionId !== null && !sha(value.interactionId)) ||
      !['STOPPED', 'WAITING_FOR_INPUT'].includes(String(value.outcome))
    )
      invalid();
    return {
      ...publication,
      context: value.context as unknown as NativeRevision['context'],
      outcome: value.outcome as NativeRevision['outcome'],
      interactionId: value.interactionId as string | null,
    };
  },
  async decision(
    projectId: string,
    intentId: string,
    revision: NativeRevision,
  ): Promise<NativeDecisionHistory> {
    const target = { publicationId: revision.id, publicationSequence: revision.sequence };
    const value = await api.get<unknown>(
      `${base(projectId, intentId)}/interaction?${query(target)}`,
    );
    if (!record(value)) invalid();
    if (value.interaction === null) {
      if (revision.interactionId !== null || value.answer !== null) invalid();
      return { interaction: null, answer: null };
    }
    const turn = await decodeNativeInteraction(value.interaction);
    if (
      turn.id !== revision.interactionId ||
      turn.publicationId !== revision.id ||
      turn.sequence !== revision.sequence ||
      turn.response
    )
      invalid();
    return { interaction: turn, answer: answerHistory(value.answer, turn, target) };
  },
  async file(
    projectId: string,
    intentId: string,
    revision: Pick<NativePublication, 'id' | 'sequence'>,
    file: NativePublishedFile,
    sourceBaselineId?: string,
  ): Promise<NativeRevisionFile> {
    const target = { publicationId: revision.id, publicationSequence: revision.sequence };
    if (!/^nf-[a-f0-9]{64}$/.test(file.id) || !sha(file.sha256)) invalid();
    const value = await api.get<unknown>(
      `${base(projectId, intentId)}/files/${encodeURIComponent(file.id)}?${query(target)}&sha256=${file.sha256}${sourceBaselineId ? '&source=1' : ''}`,
    );
    if (
      !record(value) ||
      value.fileId !== file.id ||
      value.path !== file.path ||
      value.sha256 !== file.sha256 ||
      value.bytes !== file.bytes ||
      value.mediaType !== file.mediaType ||
      value.publicationId !== revision.id ||
      value.publicationSequence !== revision.sequence ||
      value.truncated !== false ||
      (sourceBaselineId !== undefined && value.sourceBaselineId !== sourceBaselineId) ||
      !['utf8', 'binary', 'too_large'].includes(String(value.encoding))
    )
      invalid();
    if (value.encoding === 'utf8') {
      if (typeof value.content !== 'string' || value.content.includes('\0')) invalid();
      const bytes = new TextEncoder().encode(value.content);
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      if (
        bytes.length !== file.bytes ||
        bytes.length > NATIVE_INLINE_BYTES ||
        digest !== file.sha256
      )
        invalid();
    } else if (
      value.content !== null ||
      (value.encoding === 'too_large') !== file.bytes > NATIVE_INLINE_BYTES
    )
      invalid();
    return { ...value, id: file.id } as unknown as NativeRevisionFile;
  },
};
