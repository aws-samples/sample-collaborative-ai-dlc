import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Bot, Terminal } from 'lucide-react';
import { AgentOutputTranscript } from '@/components/agent-output/AgentOutputTranscript';
import type { IntentOutput } from '@/services/intents';
import '@/index.css';

interface AgentFixture {
  cli: string;
  label: string;
  source: string;
  raw: string;
  rows: IntentOutput[];
}

interface FixtureDocument {
  generatedAt: string;
  agents: AgentFixture[];
}

function Preview() {
  const [fixtures, setFixtures] = useState<FixtureDocument | null>(null);
  const [mode, setMode] = useState<'progress' | 'raw'>('progress');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/dev/agent-output-fixtures.json')
      .then((response) => {
        if (!response.ok) throw new Error(`Fixture request failed (${response.status})`);
        return response.json() as Promise<FixtureDocument>;
      })
      .then(setFixtures)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : 'Fixture request failed'),
      );
  }, []);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b bg-sidebar px-4 py-2">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-muted-foreground" />
          <h1 className="text-sm font-semibold">Agent output parser</h1>
        </div>
        <div className="flex h-7 items-center rounded-md border bg-background p-0.5">
          <button
            type="button"
            onClick={() => setMode('progress')}
            className={`h-6 rounded-sm px-2.5 text-[11px] font-medium ${
              mode === 'progress'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Progress
          </button>
          <button
            type="button"
            onClick={() => setMode('raw')}
            className={`h-6 rounded-sm px-2.5 text-[11px] font-medium ${
              mode === 'raw'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Raw
          </button>
        </div>
      </header>

      {error ? (
        <p className="p-4 text-sm text-destructive">{error}</p>
      ) : !fixtures ? (
        <p className="p-4 text-sm text-muted-foreground">Loading output...</p>
      ) : (
        <div className="grid min-h-[calc(100vh-3rem)] grid-cols-1 divide-y border-border xl:grid-cols-3 xl:divide-x xl:divide-y-0">
          {fixtures.agents.map((agent) => (
            <section key={agent.cli} className="min-w-0">
              <div className="flex h-10 items-center justify-between gap-3 border-b bg-sidebar/70 px-3">
                <div className="min-w-0">
                  <h2 className="truncate text-xs font-semibold">{agent.label}</h2>
                </div>
                <span className="shrink-0 text-[10px] text-muted-foreground">{agent.source}</span>
              </div>
              <div className="p-3">
                {mode === 'progress' ? (
                  <AgentOutputTranscript rows={agent.rows} hasRaw={agent.raw.trim().length > 0} />
                ) : (
                  <div className="flex items-start gap-2">
                    <Terminal className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <pre className="min-w-0 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
                      {agent.raw}
                    </pre>
                  </div>
                )}
              </div>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}

const rootElement = document.getElementById('root')!;
const root = import.meta.hot?.data.root ?? createRoot(rootElement);
if (import.meta.hot) import.meta.hot.data.root = root;

root.render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
