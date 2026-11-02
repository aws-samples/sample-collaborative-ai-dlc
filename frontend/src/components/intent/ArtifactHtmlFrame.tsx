import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ChevronDown, Code, Eye } from 'lucide-react';

// Renders an HTML artifact as a page. The sandbox omits allow-scripts, so the
// markup can only be displayed. allow-same-origin is safe only while scripts are
// off; it lets the app measure the page height. Never combine the two.
// Keep HTML_DOCUMENT_RE in sync with lambda/shared/html-artifact.js.

const HTML_DOCUMENT_RE = /^\s*(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+html[\s>]|<html[\s>])/i;

export const isHtmlDocument = (content: string | null | undefined): boolean =>
  typeof content === 'string' && HTML_DOCUMENT_RE.test(content);

// Blocks every network fetch from the page: only inline CSS and data: URIs load.
export const ARTIFACT_HTML_CSP =
  "default-src 'none'; style-src 'unsafe-inline' data:; img-src data:; font-src data:; media-src data:";

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_HTML_CSP}">`;
const DOCTYPE_RE = /^\s*(?:<!--[\s\S]*?-->\s*)*<!doctype[^>]*>/i;

// After the doctype: anything before it would put the page in quirks mode.
export const withArtifactCsp = (html: string): string => {
  const doctype = DOCTYPE_RE.exec(html);
  if (!doctype) return `${CSP_META}${html}`;
  const end = doctype.index + doctype[0].length;
  return `${html.slice(0, end)}${CSP_META}${html.slice(end)}`;
};

const COLLAPSED_HEIGHT = 480;
const MIN_HEIGHT = 120;

export function ArtifactHtmlFrame({
  content,
  title,
  collapsible = false,
}: {
  content: string;
  title?: string | null;
  collapsible?: boolean;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [view, setView] = useState<'rendered' | 'source'>('rendered');
  const [height, setHeight] = useState(MIN_HEIGHT);
  const [expanded, setExpanded] = useState(false);

  const measure = useCallback(() => {
    const doc = frameRef.current?.contentDocument;
    if (!doc?.documentElement) return;
    const next = Math.max(
      MIN_HEIGHT,
      doc.documentElement.scrollHeight,
      doc.body?.scrollHeight ?? 0,
    );
    setHeight((prev) => (prev === next ? prev : next));
  }, []);

  // Re-measure on reflow after load (images, card width changes).
  const observerRef = useRef<ResizeObserver | null>(null);
  const handleLoad = useCallback(() => {
    measure();
    observerRef.current?.disconnect();
    observerRef.current = null;
    const root = frameRef.current?.contentDocument?.body;
    if (!root || typeof ResizeObserver === 'undefined') return;
    observerRef.current = new ResizeObserver(measure);
    observerRef.current.observe(root);
  }, [measure]);
  useEffect(() => () => observerRef.current?.disconnect(), []);

  const canCollapse = collapsible && height > COLLAPSED_HEIGHT;
  const shownHeight = canCollapse && !expanded ? COLLAPSED_HEIGHT : height;

  return (
    <div className="not-prose mt-2" data-testid="artifact-html">
      <div className="mb-1 flex items-center justify-end gap-1">
        <span className="mr-auto text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
          HTML
        </span>
        <Button
          size="sm"
          variant={view === 'rendered' ? 'secondary' : 'ghost'}
          className="h-6 gap-1 px-2 text-[11px]"
          aria-pressed={view === 'rendered'}
          onClick={() => setView('rendered')}
        >
          <Eye className="h-3 w-3" />
          Rendered
        </Button>
        <Button
          size="sm"
          variant={view === 'source' ? 'secondary' : 'ghost'}
          className="h-6 gap-1 px-2 text-[11px]"
          aria-pressed={view === 'source'}
          onClick={() => setView('source')}
        >
          <Code className="h-3 w-3" />
          Source
        </Button>
      </div>

      {view === 'rendered' ? (
        <iframe
          ref={frameRef}
          title={title ? `${title} (HTML artifact)` : 'HTML artifact'}
          sandbox="allow-same-origin"
          referrerPolicy="no-referrer"
          srcDoc={withArtifactCsp(content)}
          onLoad={handleLoad}
          className="block w-full rounded-md border bg-white"
          style={{ height: shownHeight }}
        />
      ) : (
        <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 text-xs">
          <code>{content}</code>
        </pre>
      )}

      {view === 'rendered' && canCollapse && (
        <Button
          size="sm"
          variant="ghost"
          className="mt-1 h-6 gap-1 px-2 text-[11px] text-muted-foreground"
          onClick={() => setExpanded((v) => !v)}
        >
          <ChevronDown className={cn('h-3 w-3 transition-transform', expanded && 'rotate-180')} />
          {expanded ? 'Show less' : 'Show more'}
        </Button>
      )}
    </div>
  );
}
