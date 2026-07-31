import {
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
};

const WIKI_LINK_RE = /\[\[([^\]\r\n]+)\]\]/g;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function remarkPreviewLinks(
  artifacts: MarkdownArtifactLink[],
  derivedItems: MarkdownDerivedItemLink[],
) {
  const artifactsById = new Map(artifacts.map((artifact) => [artifact.id.toLowerCase(), artifact]));
  const itemsBySlug = new Map(
    derivedItems.flatMap((item) =>
      [item.slug, item.id].filter(Boolean).map((key) => [key!.toLowerCase(), item] as const),
    ),
  );
  const derivedPattern =
    itemsBySlug.size > 0
      ? new RegExp(
          `(?<![A-Za-z0-9_-])(${[...itemsBySlug.keys()]
            .toSorted((a, b) => b.length - a.length)
            .map(escapeRegex)
            .join('|')})(?![A-Za-z0-9_-])`,
          'gi',
        )
      : null;

  const expandDerivedItems = (value: string): MdastNode[] => {
    if (!derivedPattern) return [{ type: 'text', value }];

    const nodes: MdastNode[] = [];
    let lastIndex = 0;
    for (const match of value.matchAll(derivedPattern)) {
      const start = match.index ?? 0;
      if (start > lastIndex) nodes.push({ type: 'text', value: value.slice(lastIndex, start) });

      const item = itemsBySlug.get(match[1].toLowerCase());
      if (item) {
        nodes.push({
          type: 'link',
          url: `#item-${encodeURIComponent(item.id)}`,
          children: [{ type: 'text', value: item.label || item.slug || item.id }],
        });
      }
      lastIndex = start + match[0].length;
    }

    if (lastIndex === 0) return [{ type: 'text', value }];
    if (lastIndex < value.length) nodes.push({ type: 'text', value: value.slice(lastIndex) });
    return nodes;
  };

  const expandText = (value: string): MdastNode[] => {
    const nodes: MdastNode[] = [];
    let lastIndex = 0;

    for (const match of value.matchAll(WIKI_LINK_RE)) {
      const start = match.index ?? 0;
      if (start > lastIndex) nodes.push(...expandDerivedItems(value.slice(lastIndex, start)));

      const artifact = artifactsById.get(match[1].trim().toLowerCase());
      nodes.push(
        artifact
          ? {
              type: 'link',
              url: `#artifact-${encodeURIComponent(artifact.id)}`,
              children: [{ type: 'text', value: artifact.title || artifact.id }],
            }
          : { type: 'text', value: match[0] },
      );
      lastIndex = start + match[0].length;
    }

    if (lastIndex === 0) return expandDerivedItems(value);
    if (lastIndex < value.length) nodes.push(...expandDerivedItems(value.slice(lastIndex)));
    return nodes;
  };

  return (tree: MdastNode) => {
    const visit = (node: MdastNode) => {
      if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'link') return;
      if (!node.children) return;

      const children: MdastNode[] = [];
      for (const child of node.children) {
        if (child.type === 'text' && child.value) {
          children.push(...expandText(child.value));
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

function makePreviewLinkComponent(
  onOpenArtifact?: (artifactId: string) => void,
  onOpenItem?: (itemId: string) => void,
): NonNullable<Components['a']> {
  return function PreviewLink({ href, children, ...props }: MarkdownLinkProps) {
    const artifactId = href?.startsWith('#artifact-')
      ? decodeURIComponent(href.slice('#artifact-'.length))
      : null;
    const itemId = href?.startsWith('#item-')
      ? decodeURIComponent(href.slice('#item-'.length))
      : null;

    return (
      <a
        {...props}
        href={href}
        onClick={(event) => {
          if (artifactId && onOpenArtifact) {
            event.preventDefault();
            onOpenArtifact(artifactId);
          } else if (itemId && onOpenItem) {
            event.preventDefault();
            onOpenItem(itemId);
          }
        }}
      >
        {children}
      </a>
    );
  };
}

export function ArtifactMarkdown({
  content,
  artifacts = [],
  derivedItems = [],
  onOpenArtifact,
  onOpenItem,
}: {
  content: string;
  artifacts?: MarkdownArtifactLink[];
  derivedItems?: MarkdownDerivedItemLink[];
  onOpenArtifact?: (artifactId: string) => void;
  onOpenItem?: (itemId: string) => void;
}) {
  const remarkPlugins = useMemo<PluggableList>(
    () => [
      remarkGfm,
      [remarkPreviewLinks, artifacts, derivedItems] as [
        typeof remarkPreviewLinks,
        MarkdownArtifactLink[],
        MarkdownDerivedItemLink[],
      ],
    ],
    [artifacts, derivedItems],
  );
  const components = useMemo(
    () => ({
      ...markdownComponents,
      a: makePreviewLinkComponent(onOpenArtifact, onOpenItem),
    }),
    [onOpenArtifact, onOpenItem],
  );

  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
      {content}
    </ReactMarkdown>
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
