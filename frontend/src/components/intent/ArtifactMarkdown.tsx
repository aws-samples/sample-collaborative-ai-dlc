import { isValidElement, useEffect, useId, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

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

export function ArtifactMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
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
