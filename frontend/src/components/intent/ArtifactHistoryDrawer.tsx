import { Fragment, useEffect, useId, useMemo, useState } from 'react';
import { History, LoaderCircle } from 'lucide-react';
import { useIntent } from '@/contexts/IntentContext';
import { useIntentGraph } from '@/hooks/useIntentGraph';
import { cn } from '@/lib/utils';
import { humanizeSlug } from '@/lib/displayNames';
import {
  intentsService,
  type ArtifactVersion,
  type ArtifactVersionSummary,
  type ArtifactVersions,
  type IntentArtifact,
  type IntentGraphNode,
} from '@/services/intents';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Disclosure } from '@/components/ui/disclosure';
import { KeyValueList, type KeyValueItem } from '@/components/ui/key-value-list';
import { RelativeTime } from '@/components/ui/relative-time';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { TechnicalDetails } from '@/components/ui/technical-details';
import { ArtifactContent } from '@/components/intent/ArtifactContent';
import { rendersAsHtml } from '@/components/intent/ArtifactHtmlFrame';
import {
  PreviewReferenceText,
  type MarkdownArtifactLink,
  type MarkdownDerivedItemLink,
} from '@/components/intent/ArtifactMarkdown';

export function ArtifactHistoryDrawer({
  artifact,
  className,
}: {
  artifact: IntentArtifact;
  className?: string;
}) {
  if ((artifact.versionCount ?? 0) < 1) return null;
  return <ArtifactHistoryDrawerContent artifact={artifact} className={className} />;
}

function ArtifactHistoryDrawerContent({
  artifact,
  className,
}: {
  artifact: IntentArtifact;
  className?: string;
}) {
  const { projectId, intentId } = useIntent();
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<ArtifactVersions | null>(null);
  const [selectedId, setSelectedId] = useState('current');
  const [selectedVersion, setSelectedVersion] = useState<ArtifactVersion | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const versionCount = artifact.versionCount!;
  const title = artifact.title || humanizeSlug(artifact.artifactType ?? 'document');

  useEffect(() => {
    if (!open || history) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    intentsService
      .artifactVersions(projectId, intentId, artifact.id)
      .then((result) => {
        if (!cancelled) setHistory(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load history');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [artifact.id, history, intentId, open, projectId]);

  const selectVersion = async (version: ArtifactVersionSummary) => {
    setSelectedId(version.versionId);
    if (version.current) {
      setSelectedVersion(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setSelectedVersion(
        await intentsService.artifactVersion(projectId, intentId, artifact.id, version.versionId),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load version');
    } finally {
      setLoading(false);
    }
  };

  const selectedSummary =
    selectedId === 'current'
      ? history?.current
      : history?.versions.find((version) => version.versionId === selectedId);
  const content = selectedId === 'current' ? artifact.content : selectedVersion?.content;
  const currentUnavailable =
    selectedId === 'current' ? (artifact.contentUnavailable ?? null) : null;
  const currentLoading =
    selectedId === 'current' && artifact.content === undefined && !currentUnavailable;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn('h-7 w-7 shrink-0', className)}
        title="Document history"
        aria-label={`History for ${artifact.title || artifact.id}`}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
      >
        <History className="h-3.5 w-3.5" />
      </Button>
      <SheetContent className="flex w-full flex-col p-0 sm:max-w-3xl">
        <SheetHeader className="border-b px-5 py-4 pr-12">
          <SheetTitle className="text-base">{title}</SheetTitle>
          <SheetDescription>
            Generation {artifact.generation ?? 1} with {versionCount} archived version
            {versionCount === 1 ? '' : 's'}
          </SheetDescription>
        </SheetHeader>
        <div className="grid min-h-0 flex-1 grid-cols-1 sm:grid-cols-[minmax(150px,220px)_minmax(0,1fr)]">
          <ScrollArea className="max-h-40 border-b sm:max-h-none sm:border-b-0 sm:border-r">
            <nav className="space-y-1 p-2" aria-label="Versions">
              {history && (
                <>
                  {history.current && (
                    <VersionButton
                      version={history.current}
                      selected={selectedId === 'current'}
                      onClick={() => selectVersion(history.current!)}
                    />
                  )}
                  {history.versions.map((version) => (
                    <VersionButton
                      key={version.versionId}
                      version={version}
                      selected={selectedId === version.versionId}
                      onClick={() => selectVersion(version)}
                    />
                  ))}
                </>
              )}
            </nav>
          </ScrollArea>
          <ScrollArea>
            <div className="px-5 py-4">
              {(loading || currentLoading) && !content && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                  Loading version
                </div>
              )}
              {error && (
                <Alert tone="danger" title="This version couldn't be loaded" className="mb-4">
                  {error}
                </Alert>
              )}
              {selectedSummary && (
                <VersionHeader summary={selectedSummary} artifactId={artifact.id} />
              )}
              {content ? (
                <VersionContent
                  artifactType={selectedSummary?.artifactType ?? artifact.artifactType}
                  content={content}
                  title={title}
                />
              ) : (
                !loading &&
                !currentLoading && (
                  <p className="text-sm text-muted-foreground">
                    {currentUnavailable === 'too_large'
                      ? 'This version is too large to display here.'
                      : currentUnavailable === 'error'
                        ? "This version couldn't be loaded. Reload the intent to try again."
                        : 'No content recorded.'}
                  </p>
                )
              )}
            </div>
          </ScrollArea>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function VersionHeader({
  summary,
  artifactId,
}: {
  summary: ArtifactVersionSummary;
  artifactId: string;
}) {
  const when = summary.current ? summary.createdAt : summary.archivedAt;
  return (
    <div className="mb-4 space-y-1 border-b pb-3">
      <p className="text-sm font-medium">
        {summary.current
          ? `Current generation ${summary.generation}`
          : `Generation ${summary.generation}`}
      </p>
      <p className="text-xs text-muted-foreground">
        <RelativeTime value={when} prefix={summary.current ? 'Created' : 'Archived'} />
        {summary.actor ? ` by ${summary.actor}` : ''}
        {summary.unitSlug ? ` · ${humanizeSlug(summary.unitSlug)}` : ''}
      </p>
      {summary.restartReason && (
        <p className="text-xs text-muted-foreground">{summary.restartReason}</p>
      )}
      <TechnicalDetails
        className="pt-1"
        items={[
          { label: 'Version id', value: summary.versionId, copy: true },
          { label: 'Artifact id', value: artifactId, copy: true },
          { label: 'Stage instance', value: summary.stageInstanceId, copy: true },
          { label: 'Content hash', value: summary.contentHash, copy: true },
        ]}
      />
    </div>
  );
}

function VersionButton({
  version,
  selected,
  onClick,
}: {
  version: ArtifactVersionSummary;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'w-full rounded-md px-2.5 py-2 text-left text-xs hover:bg-muted',
        selected && 'bg-muted',
      )}
      onClick={onClick}
    >
      <span className="block font-medium">
        {version.current ? 'Current' : `Generation ${version.generation}`}
      </span>
      <span className="mt-0.5 block text-muted-foreground">
        <RelativeTime value={version.current ? version.createdAt : version.archivedAt} />
      </span>
      {version.unitSlug && (
        <span className="mt-0.5 block truncate text-muted-foreground">
          {humanizeSlug(version.unitSlug)}
        </span>
      )}
    </button>
  );
}

// ── Version body: prose with linked references, structured YAML blocks as lists ──

type Segment =
  | { kind: 'markdown'; text: string }
  | { kind: 'block'; key: string; items: StructuredItem[] };

type StructuredValue = string | string[] | Record<string, string>;
type StructuredItem = Record<string, StructuredValue>;

const FENCE_RE = /^```[ \t]*(\w+)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;
const WIKI_LINK_RE = /\[\[([^\]\r\n]+)\]\]/g;

const referenceKey = (value: string) => value.trim().toLowerCase().replace(/[._]/g, '-');

/**
 * `[[slug]]` references: derived items become markdown links the preview opens;
 * document references are left for ArtifactMarkdown to link; anything unknown
 * is shown as the bare identifier so no raw wiki syntax reaches the reader.
 */
function linkItemReferences(
  markdown: string,
  derivedItems: readonly MarkdownDerivedItemLink[],
  artifacts: readonly MarkdownArtifactLink[] = [],
): string {
  if (!markdown.includes('[[')) return markdown;
  const byKey = new Map<string, MarkdownDerivedItemLink>();
  for (const item of derivedItems) {
    for (const key of [item.slug, item.id]) {
      if (key) byKey.set(referenceKey(key), item);
    }
  }
  const artifactIds = new Set(artifacts.map((a) => a.id.toLowerCase()));
  return markdown.replace(WIKI_LINK_RE, (match, slug: string) => {
    if (artifactIds.has(slug.trim().toLowerCase())) return match;
    const item = byKey.get(referenceKey(slug));
    return item ? `[${item.label}](#item-${encodeURIComponent(item.id)})` : `\`${slug.trim()}\``;
  });
}

/** Splits markdown into prose and the fenced YAML blocks the platform parses into typed items. */
function splitStructuredBlocks(markdown: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  for (const match of markdown.matchAll(FENCE_RE)) {
    const [whole, lang, body] = match;
    if (lang && !/^ya?ml$/i.test(lang)) continue;
    const parsed = parseStructuredBlock(body);
    if (!parsed) continue;
    const start = match.index ?? 0;
    if (start > last) segments.push({ kind: 'markdown', text: markdown.slice(last, start) });
    segments.push({ kind: 'block', ...parsed });
    last = start + whole.length;
  }
  if (segments.length === 0) return [{ kind: 'markdown', text: markdown }];
  if (last < markdown.length) segments.push({ kind: 'markdown', text: markdown.slice(last) });
  return segments;
}

const KV_RE = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/;

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const lastChar = value[value.length - 1];
    if ((first === "'" && lastChar === "'") || (first === '"' && lastChar === '"')) {
      return value.slice(1, -1).replace(first === "'" ? /''/g : /\\"/g, first);
    }
  }
  return value;
}

function parseScalar(raw: string): StructuredValue | null {
  const value = raw.trim();
  if (value === '') return '';
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((part) => unquote(part))
      .filter(Boolean)
      .join(', ');
  }
  if (value === '|' || value === '>' || value.startsWith('{')) return null;
  return unquote(value);
}

/**
 * Parses the subset of YAML the structure contracts emit: one top-level key
 * holding a list of flat mappings (scalars, inline lists, nested string lists
 * or one-level mappings). Anything else returns null so the raw block stays.
 */
function parseStructuredBlock(source: string): { key: string; items: StructuredItem[] } | null {
  const lines = source
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'));
  const head = lines[0] ? KV_RE.exec(lines[0].trim()) : null;
  if (!head || head[2] !== undefined || lines[0].search(/\S/) !== 0) return null;
  const key = head[1];
  const items: StructuredItem[] = [];
  let item: StructuredItem | null = null;
  let itemIndent = -1;
  let fieldIndent = -1;
  let pendingField: string | null = null;

  const setField = (target: StructuredItem, k: string, raw: string): boolean => {
    const value = parseScalar(raw ?? '');
    if (value === null) return false;
    target[k] = value;
    pendingField = value === '' ? k : null;
    return true;
  };

  for (const line of lines.slice(1)) {
    const indent = line.search(/\S/);
    const text = line.trim();
    const isListEntry = text === '-' || text.startsWith('- ');
    if (isListEntry && (itemIndent === -1 || indent === itemIndent)) {
      itemIndent = indent;
      item = {};
      items.push(item);
      pendingField = null;
      fieldIndent = -1;
      const rest = text.slice(1).trim();
      if (rest) {
        const kv = KV_RE.exec(rest);
        if (!kv || !setField(item, kv[1], kv[2] ?? '')) return null;
        fieldIndent = indent + 2;
      }
      continue;
    }
    if (!item) return null;
    if (isListEntry) {
      if (!pendingField || indent <= fieldIndent) return null;
      const current = item[pendingField];
      const value = unquote(text.slice(1).trim());
      if (Array.isArray(current)) current.push(value);
      else if (current === '') item[pendingField] = [value];
      else return null;
      continue;
    }
    const kv = KV_RE.exec(text);
    if (!kv) return null;
    if (fieldIndent === -1 && indent > itemIndent) fieldIndent = indent;
    if (indent === fieldIndent) {
      if (!setField(item, kv[1], kv[2] ?? '')) return null;
      continue;
    }
    if (pendingField && indent > fieldIndent) {
      const current = item[pendingField];
      const nested =
        typeof current === 'object' && !Array.isArray(current)
          ? current
          : current === ''
            ? {}
            : null;
      if (!nested) return null;
      const value = parseScalar(kv[2] ?? '');
      if (typeof value !== 'string') return null;
      nested[kv[1]] = value;
      item[pendingField] = nested;
      continue;
    }
    return null;
  }
  return items.length > 0 ? { key, items } : null;
}

const TITLE_FIELDS = ['title', 'name', 'label', 'summary'];

function itemTitle(item: StructuredItem, index: number): { title: string; field: string | null } {
  for (const field of TITLE_FIELDS) {
    const value = item[field];
    if (typeof value === 'string' && value.trim()) return { title: value, field };
  }
  const id = item.id;
  if (typeof id === 'string' && id.trim()) return { title: humanizeSlug(id), field: 'id' };
  return { title: `Item ${index + 1}`, field: null };
}

function fieldLabel(name: string): string {
  return humanizeSlug(name)
    .split(' ')
    .map((word, index) => (index > 0 && word !== word.toUpperCase() ? word.toLowerCase() : word))
    .join(' ');
}

function VersionContent({
  artifactType,
  content,
  title,
}: {
  artifactType: string | null | undefined;
  content: string;
  title: string;
}) {
  const { detail, openArtifactPreview, openItemPreview, projectId, intentId } = useIntent();
  const { derivedItems } = useIntentGraph(projectId, intentId);
  const artifacts: MarkdownArtifactLink[] = useMemo(
    () => (detail?.artifacts ?? []).map((a) => ({ id: a.id, title: a.title })),
    [detail?.artifacts],
  );
  const itemLinks: MarkdownDerivedItemLink[] = useMemo(
    () =>
      (derivedItems ?? []).map((item: IntentGraphNode) => ({
        id: item.id,
        slug: item.slug,
        label: item.label,
      })),
    [derivedItems],
  );
  const segments = useMemo<Segment[]>(
    () =>
      rendersAsHtml(artifactType, content)
        ? [{ kind: 'markdown', text: content }]
        : splitStructuredBlocks(content).map((segment) =>
            segment.kind === 'markdown'
              ? { kind: 'markdown', text: linkItemReferences(segment.text, itemLinks, artifacts) }
              : segment,
          ),
    [artifactType, content, itemLinks, artifacts],
  );

  return (
    <div className="prose prose-sm dark:prose-invert max-w-none">
      {segments.map((segment, index) =>
        segment.kind === 'markdown' ? (
          <ArtifactContent
            key={index}
            artifactType={artifactType}
            content={segment.text}
            title={title}
            artifacts={artifacts}
            derivedItems={itemLinks}
            onOpenArtifact={openArtifactPreview}
            onOpenItem={openItemPreview}
          />
        ) : (
          <StructuredBlock
            key={index}
            blockKey={segment.key}
            items={segment.items}
            artifacts={artifacts}
            derivedItems={itemLinks}
            onOpenArtifact={openArtifactPreview}
            onOpenItem={openItemPreview}
          />
        ),
      )}
    </div>
  );
}

function StructuredBlock({
  blockKey,
  items,
  artifacts,
  derivedItems,
  onOpenArtifact,
  onOpenItem,
}: {
  blockKey: string;
  items: StructuredItem[];
  artifacts: MarkdownArtifactLink[];
  derivedItems: MarkdownDerivedItemLink[];
  onOpenArtifact?: (artifactId: string) => void;
  onOpenItem?: (itemId: string) => void;
}) {
  const headingId = useId();
  const renderValue = (value: StructuredValue) => {
    if (Array.isArray(value)) {
      return (
        <ul className="m-0 list-disc space-y-0.5 pl-4">
          {value.map((entry, i) => (
            <li key={i}>
              <PreviewReferenceText
                text={entry}
                artifacts={artifacts}
                derivedItems={derivedItems}
                onOpenArtifact={onOpenArtifact}
                onOpenItem={onOpenItem}
              />
            </li>
          ))}
        </ul>
      );
    }
    if (typeof value === 'object') {
      return (
        <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
          {Object.entries(value).map(([k, v]) => (
            <Fragment key={k}>
              <dt className="text-muted-foreground">{fieldLabel(k)}</dt>
              <dd className="m-0">{v}</dd>
            </Fragment>
          ))}
        </dl>
      );
    }
    return (
      <PreviewReferenceText
        text={value}
        artifacts={artifacts}
        derivedItems={derivedItems}
        onOpenArtifact={onOpenArtifact}
        onOpenItem={onOpenItem}
      />
    );
  };

  return (
    <section
      aria-labelledby={headingId}
      className="not-prose my-4 overflow-hidden rounded-lg border bg-card text-card-foreground"
    >
      <h3 id={headingId} className="border-b bg-muted/40 px-3 py-2 text-sm font-semibold">
        {humanizeSlug(blockKey)}{' '}
        <span className="font-normal text-muted-foreground">({items.length})</span>
      </h3>
      <div className="divide-y">
        {items.map((item, index) => {
          const { title, field } = itemTitle(item, index);
          const status = typeof item.status === 'string' ? item.status : null;
          const rows: KeyValueItem[] = Object.entries(item)
            .filter(([k, v]) => k !== field && k !== 'status' && k !== 'id' && v !== '')
            .map(([k, v]) => ({ label: fieldLabel(k), value: renderValue(v) }));
          if (typeof item.id === 'string' && field !== 'id') {
            rows.push({
              label: 'Id',
              value: <code className="rounded bg-muted px-1 py-0.5 text-xs">{item.id}</code>,
            });
          }
          return (
            <Disclosure
              key={`${index}-${title}`}
              title={title}
              headingLevel={4}
              defaultOpen={items.length <= 3}
              status={
                status ? (
                  <Badge variant="outline" size="sm" className="font-normal">
                    {status}
                  </Badge>
                ) : undefined
              }
              className="px-1"
              contentClassName="px-2 pb-3 pt-1"
            >
              <KeyValueList items={rows} className="gap-y-2 text-sm" />
            </Disclosure>
          );
        })}
      </div>
    </section>
  );
}
