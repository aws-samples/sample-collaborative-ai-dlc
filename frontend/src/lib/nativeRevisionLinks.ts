import type { NativePublishedFile } from '@/services/nativeIntents';
import type { NativeRevisionTarget } from '@/services/nativeHistory';

export interface NativeHistoryLocation {
  mode: 'current' | 'history' | 'revision' | 'invalid';
  revision?: NativeRevisionTarget;
  compare?: NativeRevisionTarget;
  file?: { id: string; sha256: string };
  discussion?: boolean;
}
const keys = ['nativeHistory', 'nativeRevision', 'nativeFile', 'nativeCompare', 'nativeDiscussion'];
const encode = (value: NativeRevisionTarget) =>
  `${value.publicationSequence}.${value.publicationId}`;
const revision = (value: string): NativeRevisionTarget | null => {
  const match = /^([1-9][0-9]{0,15})\.([a-f0-9]{64})$/.exec(value);
  return match && Number.isSafeInteger(Number(match[1]))
    ? { publicationSequence: Number(match[1]), publicationId: match[2] }
    : null;
};
export const parseNativeHistoryLocation = (search: string): NativeHistoryLocation => {
  const params = new URLSearchParams(search);
  const present = [...params.keys()].filter((key) => key.startsWith('native'));
  if (!present.length) return { mode: 'current' };
  if (present.some((key) => !keys.includes(key) || params.getAll(key).length !== 1))
    return { mode: 'invalid' };
  if (present.length === 1 && params.get('nativeHistory') === '1') return { mode: 'history' };
  const target = revision(params.get('nativeRevision') ?? '');
  const comparison = params.has('nativeCompare')
    ? revision(params.get('nativeCompare')!)
    : undefined;
  const file = params.has('nativeFile')
    ? /^(nf-[a-f0-9]{64}):([a-f0-9]{64})$/.exec(params.get('nativeFile')!)
    : undefined;
  if (
    !target ||
    params.has('nativeHistory') ||
    comparison === null ||
    file === null ||
    (params.has('nativeDiscussion') && (params.get('nativeDiscussion') !== '1' || !file))
  )
    return { mode: 'invalid' };
  return {
    mode: 'revision',
    revision: target,
    compare: comparison,
    ...(file ? { file: { id: file[1], sha256: file[2] } } : {}),
    discussion: params.get('nativeDiscussion') === '1',
  };
};

export const nativeHistorySearch = (
  search: string,
  target: {
    history?: boolean;
    revision?: NativeRevisionTarget;
    compare?: NativeRevisionTarget;
    file?: Pick<NativePublishedFile, 'id' | 'sha256'>;
    discussion?: boolean;
  } = {},
): string => {
  const params = new URLSearchParams(search);
  const remove = [...params.keys()].filter((key) => key.startsWith('native'));
  for (const key of remove) params.delete(key);
  if (target.history) params.set('nativeHistory', '1');
  if (target.revision) params.set('nativeRevision', encode(target.revision));
  if (target.compare) params.set('nativeCompare', encode(target.compare));
  if (target.file) params.set('nativeFile', `${target.file.id}:${target.file.sha256}`);
  if (target.discussion) params.set('nativeDiscussion', '1');
  return params.size ? `?${params}` : '';
};
