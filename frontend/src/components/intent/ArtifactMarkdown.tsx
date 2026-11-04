import {
  Fragment,
  isValidElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
} from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { PluggableList } from 'unified';

export interface MarkdownArtifactLink {
  id: string;
  title: string | null;
}

export interface MarkdownDerivedItemLink {
  id: string;
  slug?: string | null;
  label: string;
}

type MdastNode = {
  type: string;
  value?: string;
  children?: MdastNode[];
  url?: string;
  title?: string;
};

const WIKI_LINK_RE = /\[\[([^\]\r\n]+)\]\]/g;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Item slugs replace separators with '-', so text such as `FR2.4` or `FR_2`
// refers to the item slugged `fr2-4` or `fr-2`.
function referenceKey(value: string): string {
  return value.toLowerCase().replace(/[._]/g, '-');
}

export interface PreviewReferenceOptions {
  /** Keep the referencing text as the link text, with the target's title on hover. */
  preserveText?: boolean;
}

export type PreviewReferenceSegment = { text: string; href?: string; title?: string };

export interface PreviewReferenceIndex {
  split: (value: string) => PreviewReferenceSegment[];
}

export function buildPreviewReferenceIndex(
  artifacts: MarkdownArtifactLink[],
  derivedItems: MarkdownDerivedItemLink[],
  { preserveText = false }: PreviewReferenceOptions = {},
): PreviewReferenceIndex {
  const artifactsById = new Map(artifacts.map((artifact) => [artifact.id.toLowerCase(), artifact]));
  const itemsByKey = new Map(
    derivedItems.flatMap((item) =>
      [item.slug, item.id].filter(Boolean).map((key) => [referenceKey(key!), item] as const),
    ),
  );
  const derivedPattern =
    itemsByKey.size > 0
      ? new RegExp(
          `(?<![A-Za-z0-9_-])(${[...itemsByKey.keys()]
            .toSorted((a, b) => b.length - a.length)
            .map((key) => escapeRegex(key).replace(/-/g, '[-._]'))
            .join('|')})(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`,
          'gi',
        )
      : null;

  const splitDerivedItems = (value: string): PreviewReferenceSegment[] => {
    if (!derivedPattern) return [{ text: value }];

    const segments: PreviewReferenceSegment[] = [];
    let lastIndex = 0;
    for (const match of value.matchAll(derivedPattern)) {
      const start = match.index ?? 0;
      if (start > lastIndex) segments.push({ text: value.slice(lastIndex, start) });

      const item = itemsByKey.get(referenceKey(match[1]));
      if (item) {
        const title = item.label || item.slug || item.id;
        segments.push({
          href: `#item-${encodeURIComponent(item.id)}`,
          ...(preserveText ? { text: match[0], title } : { text: title }),
        });
      }
      lastIndex = start + match[0].length;
    }

    if (lastIndex === 0) return [{ text: value }];
    if (lastIndex < value.length) segments.push({ text: value.slice(lastIndex) });
    return segments;
  };

  const split = (value: string): PreviewReferenceSegment[] => {
    const segments: PreviewReferenceSegment[] = [];
    let lastIndex = 0;

    for (const match of value.matchAll(WIKI_LINK_RE)) {
      const start = match.index ?? 0;
      if (start > lastIndex) segments.push(...splitDerivedItems(value.slice(lastIndex, start)));

      const artifact = artifactsById.get(match[1].trim().toLowerCase());
      segments.push(
        artifact
          ? {
              href: `#artifact-${encodeURIComponent(artifact.id)}`,
              text: artifact.title || artifact.id,
            }
          : { text: match[0] },
      );
      lastIndex = start + match[0].length;
    }

    if (lastIndex === 0) return splitDerivedItems(value);
    if (lastIndex < value.length) segments.push(...splitDerivedItems(value.slice(lastIndex)));
    return segments;
  };

  return { split };
}

function referenceNode({ text, href, title }: PreviewReferenceSegment): MdastNode {
  return href
    ? { type: 'link', url: href, title, children: [{ type: 'text', value: text }] }
    : { type: 'text', value: text };
}

function remarkPreviewLinks(index: PreviewReferenceIndex) {
  return (tree: MdastNode) => {
    const visit = (node: MdastNode) => {
      if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'link') return;
      if (!node.children) return;

      const children: MdastNode[] = [];
      for (const child of node.children) {
        if (child.type === 'text' && child.value) {
          children.push(...index.split(child.value).map(referenceNode));
        } else {
          children.push(child);
          visit(child);
        }
      }
      node.children = children;
    };
    visit(tree);
  };
}

type MermaidState =
  | { status: 'idle' | 'loading'; svg?: undefined; error?: undefined }
  | { status: 'ready'; svg: string; error?: undefined }
  | { status: 'error'; svg?: undefined; error: string };

const markdownComponents: Components = {
  pre(props) {
    const { children, node, ...rest } = props;
    void node;
    const child = Array.isArray(children) ? children[0] : children;

    if (isValidElement(child) && child.type === MermaidDiagram) {
      return <>{children}</>;
    }

    return <pre {...rest}>{children}</pre>;
  },
  code(props) {
    const { className, children, node, ...rest } = props;
    void node;

    const language = /language-(\w+)/.exec(className ?? '')?.[1]?.toLowerCase();
    if (language === 'mermaid') {
      return <MermaidDiagram source={String(children).replace(/\n$/, '')} />;
    }

    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  },
};

type MarkdownLinkProps = ComponentPropsWithoutRef<'a'> & { node?: MdastNode };

function previewTarget(href?: string): { kind: 'artifact' | 'item'; id: string } | null {
  if (href?.startsWith('#artifact-')) {
    return { kind: 'artifact', id: decodeURIComponent(href.slice('#artifact-'.length)) };
  }
  if (href?.startsWith('#item-')) {
    return { kind: 'item', id: decodeURIComponent(href.slice('#item-'.length)) };
  }
  return null;
}

// Opens a preview link's target, returning whether a handler took it.
function openPreviewTarget(
  href: string | undefined,
  onOpenArtifact?: (artifactId: string) => void,
  onOpenItem?: (itemId: string) => void,
): boolean {
  const target = previewTarget(href);
  if (target?.kind === 'artifact' && onOpenArtifact) {
    onOpenArtifact(target.id);
    return true;
  }
  if (target?.kind === 'item' && onOpenItem) {
    onOpenItem(target.id);
    return true;
  }
  return false;
}

function makePreviewLinkComponent(
  onOpenArtifact?: (artifactId: string) => void,
  onOpenItem?: (itemId: string) => void,
  stopPropagation = false,
): NonNullable<Components['a']> {
  return function PreviewLink({ href, children, node, ...props }: MarkdownLinkProps) {
    void node;
    return (
      <a
        {...props}
        href={href}
        onClick={(event) => {
          if (stopPropagation && previewTarget(href)) event.stopPropagation();
          if (openPreviewTarget(href, onOpenArtifact, onOpenItem)) event.preventDefault();
        }}
      >
        {children}
      </a>
    );
  };
}

interface PreviewLinkProps {
  artifacts?: MarkdownArtifactLink[];
  derivedItems?: MarkdownDerivedItemLink[];
  onOpenArtifact?: (artifactId: string) => void;
  onOpenItem?: (itemId: string) => void;
  /** Keep the referencing text as the link text, with the target's title on hover. */
  preserveReferenceText?: boolean;
  /** Stop preview-link clicks reaching enclosing handlers, such as a selectable row. */
  stopLinkPropagation?: boolean;
}

const EMPTY_ARTIFACTS: MarkdownArtifactLink[] = [];
const EMPTY_ITEMS: MarkdownDerivedItemLink[] = [];

export function ArtifactMarkdown({
  content,
  artifacts = EMPTY_ARTIFACTS,
  derivedItems = EMPTY_ITEMS,
  onOpenArtifact,
  onOpenItem,
  preserveReferenceText = false,
  stopLinkPropagation = false,
}: PreviewLinkProps & { content: string }) {
  const remarkPlugins = useMemo<PluggableList>(
    () => [
      remarkGfm,
      [
        remarkPreviewLinks,
        buildPreviewReferenceIndex(artifacts, derivedItems, {
          preserveText: preserveReferenceText,
        }),
      ] as [typeof remarkPreviewLinks, PreviewReferenceIndex],
    ],
    [artifacts, derivedItems, preserveReferenceText],
  );
  const components = useMemo(
    () => ({
      ...markdownComponents,
      a: makePreviewLinkComponent(onOpenArtifact, onOpenItem, stopLinkPropagation),
    }),
    [onOpenArtifact, onOpenItem, stopLinkPropagation],
  );

  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
      {content}
    </ReactMarkdown>
  );
}

/**
 * Plain text (not Markdown) with the same artifact and derived-item references
 * linked as in ArtifactMarkdown.
 */
export function PreviewReferenceText({
  text,
  artifacts = EMPTY_ARTIFACTS,
  derivedItems = EMPTY_ITEMS,
  onOpenArtifact,
  onOpenItem,
  preserveReferenceText = false,
  stopLinkPropagation = false,
  linkClassName,
}: PreviewLinkProps & { text: string; linkClassName?: string }) {
  const index = useMemo(
    () =>
      buildPreviewReferenceIndex(artifacts, derivedItems, {
        preserveText: preserveReferenceText,
      }),
    [artifacts, derivedItems, preserveReferenceText],
  );
  const Link = useMemo(
    () => makePreviewLinkComponent(onOpenArtifact, onOpenItem, stopLinkPropagation),
    [onOpenArtifact, onOpenItem, stopLinkPropagation],
  );

  return (
    <>
      {index.split(text).map((segment, i) =>
        segment.href ? (
          <Link key={i} href={segment.href} title={segment.title} className={linkClassName}>
            {segment.text}
          </Link>
        ) : (
          <Fragment key={i}>{segment.text}</Fragment>
        ),
      )}
    </>
  );
}

function MermaidDiagram({ source }: { source: string }) {
  const reactId = useId();
  const diagramId = `mermaid-${reactId.replace(/:/g, '')}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<MermaidState>({ status: 'idle' });

  useEffect(() => {
    let cancelled = false;
    const isDark = document.documentElement.classList.contains('dark');

    setState({ status: 'loading' });

    import('mermaid')
      .then(({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: isDark ? 'dark' : 'default',
        });
        return mermaid.render(diagramId, source);
      })
      .then(({ svg, bindFunctions }) => {
        if (cancelled) return;
        setState({ status: 'ready', svg });
        window.requestAnimationFrame(() => {
          if (!cancelled && containerRef.current) bindFunctions?.(containerRef.current);
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: 'error',
          error: error instanceof Error ? error.message : 'Unable to render Mermaid diagram',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [diagramId, source]);

  if (state.status === 'error') {
    return (
      <div className="not-prose my-3 rounded-md border border-destructive/30 bg-destructive/5 p-3">
        <p className="mb-2 text-xs font-medium text-destructive">
          Mermaid diagram failed to render
        </p>
        <pre className="overflow-x-auto whitespace-pre-wrap text-xs text-muted-foreground">
          {state.error}
        </pre>
      </div>
    );
  }

  return (
    <div className="not-prose my-3 overflow-x-auto rounded-md border bg-background p-3">
      {state.status === 'ready' ? (
        <div
          ref={containerRef}
          className="mermaid-diagram"
          dangerouslySetInnerHTML={{ __html: state.svg }}
        />
      ) : (
        <p className="text-xs text-muted-foreground">Rendering diagram...</p>
      )}
    </div>
  );
}
