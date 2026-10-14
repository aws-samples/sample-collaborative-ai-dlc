import { simpleDiffStringWithCursor } from 'lib0/diff';
import type { NativePublishedFile } from '@/services/nativeIntents';
import type { NativeRevisionFile } from '@/services/nativeHistory';

export function compareInventory(before: NativePublishedFile[], after: NativePublishedFile[]) {
  const old = new Map(before.map((file) => [file.path, file]));
  const next = new Map(after.map((file) => [file.path, file]));
  return [...new Set([...old.keys(), ...next.keys()])].toSorted().map((path) => {
    const a = old.get(path),
      b = next.get(path);
    return {
      path,
      before: a,
      after: b,
      status: !a
        ? 'added'
        : !b
          ? 'deleted'
          : a.sha256 === b.sha256 && a.bytes === b.bytes
            ? 'identical'
            : 'changed',
    };
  });
}

export function NativeFileComparison({
  before,
  after,
  added,
}: {
  before: NativeRevisionFile | null;
  after: NativeRevisionFile | null;
  added: boolean;
}) {
  if ((after && after.encoding !== 'utf8') || (before && before.encoding !== 'utf8'))
    return (
      <p>
        Complete text comparison unavailable: a file is binary, unsupported text, or exceeds the 3
        MiB inline limit. No partial diff is shown.
      </p>
    );
  if (!before && !added) return null;
  const old = before?.content ?? '',
    next = after?.content ?? '';
  if (old === next && before && after) return <p>Identical verified bytes.</p>;
  const change = simpleDiffStringWithCursor(old, next, 0);
  return (
    <section aria-label="Complete file comparison" className="space-y-2">
      <p className="text-sm">Complete text comparison. Removed text is red; added text is green.</p>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <h4>Before{added ? ' (file absent)' : ''}</h4>
          <pre className="max-h-[36rem] overflow-auto rounded-md border p-3 text-xs">
            {old.slice(0, change.index)}
            <del className="bg-red-100 text-red-950">
              {old.slice(change.index, change.index + change.remove)}
            </del>
            {old.slice(change.index + change.remove)}
          </pre>
        </div>
        <div>
          <h4>After{after === null ? ' (file absent)' : ''}</h4>
          <pre className="max-h-[36rem] overflow-auto rounded-md border p-3 text-xs">
            {next.slice(0, change.index)}
            <ins className="bg-green-100 text-green-950">{change.insert}</ins>
            {next.slice(change.index + change.insert.length)}
          </pre>
        </div>
      </div>
    </section>
  );
}
