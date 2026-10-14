import { Link, useLocation } from 'react-router';
import { ArtifactViewer } from './ArtifactViewer';
import { DiscussButton } from '@/components/discussion/DiscussButton';
import { Badge } from '@/components/ui/badge';
import { nativeArtifactRevisionId } from '@/lib/nativeCollaboration';
import { nativeHistorySearch } from '@/lib/nativeRevisionLinks';
import type { NativeFileContent, NativePublishedFile } from '@/services/nativeIntents';
import type { NativeRevisionFile } from '@/services/nativeHistory';

export function NativeFileView({
  file,
  descriptor,
  createdAt,
  publicationSequence,
}: {
  file: NativeFileContent | NativeRevisionFile;
  descriptor: NativePublishedFile;
  createdAt: string;
  publicationSequence: number;
}) {
  const { search } = useLocation();
  const markdown = file.mediaType.split(';')[0] === 'text/markdown' || /\.md$/i.test(file.path);
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
      <Link
        className="text-xs underline"
        to={{
          search: nativeHistorySearch(search, {
            revision: { publicationId: file.publicationId, publicationSequence },
            file,
          }),
        }}
      >
        Link to file revision
      </Link>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline">{descriptor.role}</Badge>
        <span>
          {file.bytes} bytes · {file.mediaType}
        </span>
        <span title={file.sha256}>SHA-256 {file.sha256.slice(0, 12)}…</span>
      </div>
      {file.encoding !== 'utf8' ? (
        <p className="rounded-md border p-4 text-sm text-muted-foreground">
          {file.encoding === 'too_large' ? 'File exceeds the 3 MiB inline limit.' : 'Binary file.'}{' '}
          Preview is not available. This file is preserved in the committed revision.
        </p>
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
