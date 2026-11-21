import { useEffect, useMemo, useRef } from 'react';
import { Link, useLocation } from 'react-router';
import { ArtifactViewer } from './ArtifactViewer';
import { DiscussButton } from '@/components/discussion/DiscussButton';
import { Badge } from '@/components/ui/badge';
import { nativeArtifactRevisionId } from '@/lib/nativeCollaboration';
import { nativeFileRevisionSearch } from '@/lib/nativeRevisionLinks';
import type {
  NativeFileContent,
  NativePublishedFile,
  NativePublication,
} from '@/services/nativeIntents';
import type { NativeRevisionFile } from '@/services/nativeHistory';
import { NativeResultDownload } from './NativeResultDownload';

export function NativeFilesystemNotice({
  policy,
}: {
  policy: NativePublication['filesystemPolicy'];
}) {
  if (!policy) return null;
  return (
    <p className="text-xs text-muted-foreground">
      Generated node_modules dependencies remain in the persistent workspace. Source files, package
      manifests and lockfiles are published below.
    </p>
  );
}

export function NativeFileView({
  file,
  descriptor,
  createdAt,
  publicationSequence,
  lineAnchor,
  resultScope,
}: {
  file: NativeFileContent | NativeRevisionFile;
  descriptor: NativePublishedFile;
  createdAt: string;
  publicationSequence: number;
  lineAnchor?: string;
  resultScope?: {
    projectId: string;
    executionId: string;
    onAccessFailure: (error: unknown) => void;
  };
}) {
  const { search } = useLocation();
  const markdown = file.mediaType.split(';')[0] === 'text/markdown' || /\.md$/i.test(file.path);
  const revisionSearch = nativeFileRevisionSearch(
    search,
    {
      publicationId: file.publicationId,
      publicationSequence,
    },
    file,
  );
  // The fragment selects lines within already verified bytes. It supplies no file identity.
  const excerpt = useMemo(() => {
    const range = /^#L([1-9]\d*)-L([1-9]\d*)$/.exec(lineAnchor ?? '');
    if (!range || file.encoding !== 'utf8' || file.content === null) return null;
    const start = Number(range[1]);
    const end = Number(range[2]);
    const lines = file.content.split(/\r?\n/);
    if (start > end || end > lines.length) return null;
    return { start, end, text: lines.slice(start - 1, end).join('\n') };
  }, [lineAnchor, file.encoding, file.content]);
  const rangeElement = useRef<HTMLElement>(null);
  useEffect(() => {
    if (excerpt) rangeElement.current?.scrollIntoView?.({ block: 'nearest' });
  }, [excerpt]);
  return (
    <section className="min-w-0 space-y-2" aria-label={`File ${file.path}`}>
      <div className="flex items-start gap-2">
        <h3 className="min-w-0 flex-1 break-all text-sm font-medium">{file.path}</h3>
        {/* Discussion and Quorum are bound to these exact verified bytes. */}
        <DiscussButton
          entityType="artifact"
          entityId={nativeArtifactRevisionId(file.id, file.sha256)}
          entityTitle={file.path}
          publicationId={file.publicationId}
          publicationSequence={publicationSequence}
        />
      </div>
      {resultScope && (
        <NativeResultDownload
          {...resultScope}
          target={{ publicationId: file.publicationId, publicationSequence }}
          file={descriptor}
        />
      )}
      {revisionSearch && (
        <Link
          className="text-xs underline"
          to={{ search: revisionSearch, hash: excerpt ? lineAnchor : undefined }}
        >
          Link to file revision
        </Link>
      )}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline">{descriptor.role}</Badge>
        <span>
          {file.bytes} bytes · {file.mediaType}
        </span>
        <span title={file.sha256}>SHA-256 {file.sha256.slice(0, 12)}…</span>
      </div>
      {excerpt && (
        <section
          id={lineAnchor?.slice(1)}
          ref={rangeElement}
          aria-label={`Lines ${excerpt.start}–${excerpt.end}`}
        >
          <h4 className="text-xs font-medium">
            Lines {excerpt.start}–{excerpt.end}
          </h4>
          <pre className="max-h-48 overflow-auto rounded-md border bg-muted/30 p-3 text-xs">
            <code>{excerpt.text}</code>
          </pre>
        </section>
      )}
      {file.encoding !== 'utf8' ? (
        <p className="rounded-md border p-4 text-sm text-muted-foreground">
          {file.encoding === 'too_large' ? 'File exceeds the 3 MiB inline limit.' : 'Binary file.'}{' '}
          Preview is not available. This file is preserved in the committed revision.
        </p>
      ) : file.bytes === 0 ? (
        <p className="rounded-md border p-4 text-sm text-muted-foreground">Empty file (0 bytes).</p>
      ) : markdown ? (
        <ArtifactViewer
          readOnly
          artifact={{
            id: file.id,
            title: file.path,
            artifactType: descriptor.role,
            content: file.content!,
            createdAt,
            createdByExecutionId: null,
            createdByStageInstanceId: null,
          }}
        />
      ) : (
        <pre className="max-h-[36rem] overflow-auto rounded-md border bg-muted/30 p-4 text-xs">
          <code>{file.content}</code>
        </pre>
      )}
    </section>
  );
}
