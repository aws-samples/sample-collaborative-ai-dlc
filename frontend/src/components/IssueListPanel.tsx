import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertCircle,
  CircleDot,
  CheckCircle2,
  Github,
  Loader2,
  Play,
  Search,
} from 'lucide-react';
import { githubIssuesService, type GitHubIssue } from '@/services/githubIssues';
import { sprintsService, type Sprint } from '@/services/sprints';
import type { Project } from '@/services/projects';

interface Props {
  project: Project;
  sprints: Sprint[];
  onSprintCreated: (sprint: Sprint) => void;
}

const parseRepo = (gitRepo: string): { owner: string; repo: string } | null => {
  const parts = gitRepo.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return { owner: parts[0], repo: parts[1] };
};

export function IssueListPanel({ project, sprints, onSprintCreated }: Props) {
  const navigate = useNavigate();
  const [state, setState] = useState<'open' | 'closed'>('open');
  const [searchInput, setSearchInput] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [issues, setIssues] = useState<GitHubIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [startingNumber, setStartingNumber] = useState<number | null>(null);

  const repoInfo = useMemo(() => parseRepo(project.gitRepo), [project.gitRepo]);

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => setDebouncedQuery(searchInput.trim()), 300);
    return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current); };
  }, [searchInput]);

  const loadIssues = useCallback(async () => {
    if (!repoInfo) return;
    setLoading(true);
    setError(null);
    try {
      const data = await githubIssuesService.list(repoInfo.owner, repoInfo.repo, state, debouncedQuery || undefined);
      setIssues(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load issues');
      setIssues([]);
    } finally {
      setLoading(false);
    }
  }, [repoInfo, state, debouncedQuery]);

  useEffect(() => { loadIssues(); }, [loadIssues]);

  const sprintByIssue = useMemo(() => {
    const map = new Map<string, Sprint>();
    for (const s of sprints) {
      if (s.issueNumber) map.set(s.issueNumber, s);
    }
    return map;
  }, [sprints]);

  const handleStartSprint = async (issue: GitHubIssue) => {
    if (!project.id) return;
    const existing = sprintByIssue.get(String(issue.number));
    if (existing) {
      navigate(`/project/${project.id}/sprint/${existing.id}`);
      return;
    }
    setStartingNumber(issue.number);
    try {
      const sprint = await sprintsService.create(project.id, {
        name: issue.title,
        description: `# ${issue.title}\n\n${issue.body ?? ''}`,
        issueNumber: issue.number,
        issueUrl: issue.htmlUrl,
      });
      onSprintCreated(sprint);
      navigate(`/project/${project.id}/sprint/${sprint.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create sprint');
    } finally {
      setStartingNumber(null);
    }
  };

  if (!repoInfo) {
    return (
      <Card className="border-dashed mb-6">
        <CardContent className="p-4 text-sm text-muted-foreground">
          Issue integration is enabled, but the project's git repository is not in <code className="font-mono">owner/repo</code> format.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="mb-6">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Github className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-sm">Issues</CardTitle>
            <span className="text-xs text-muted-foreground">{repoInfo.owner}/{repoInfo.repo}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center border rounded-md text-xs">
              <Button
                variant={state === 'open' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 rounded-r-none gap-1"
                onClick={() => setState('open')}
              >
                <CircleDot className="h-3 w-3" /> Open
              </Button>
              <Button
                variant={state === 'closed' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 rounded-l-none gap-1"
                onClick={() => setState('closed')}
              >
                <CheckCircle2 className="h-3 w-3" /> Closed
              </Button>
            </div>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search issues..."
                className="pl-8 h-7 w-48 text-xs"
              />
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {error ? (
          <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/5 border border-destructive/20 rounded-md p-3">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <div className="flex-1">
              <p>{error}</p>
              {error.toLowerCase().includes('not connected') && (
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs"
                  onClick={() => navigate(`/project/${project.id}/settings`)}
                >
                  Connect GitHub in project settings
                </Button>
              )}
            </div>
          </div>
        ) : loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map(i => (
              <div key={i} className="border rounded-md p-3">
                <Skeleton className="h-4 w-2/3 mb-2" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            ))}
          </div>
        ) : issues.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">
            {debouncedQuery ? `No ${state} issues match "${debouncedQuery}".` : `No ${state} issues.`}
          </p>
        ) : (
          <div className="space-y-2">
            {issues.map(issue => {
              const existingSprint = sprintByIssue.get(String(issue.number));
              const isStarting = startingNumber === issue.number;
              return (
                <div
                  key={issue.number}
                  className="border rounded-md p-3 flex items-start justify-between gap-3 hover:bg-accent/30 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <a
                        href={issue.htmlUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm font-medium hover:underline truncate"
                      >
                        #{issue.number} {issue.title}
                      </a>
                      {issue.labels.slice(0, 3).map(l => (
                        <Badge
                          key={l.name}
                          variant="outline"
                          className="text-[9px] h-4 px-1.5"
                          style={{ borderColor: `#${l.color}`, color: `#${l.color}` }}
                        >
                          {l.name}
                        </Badge>
                      ))}
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      Opened by {issue.user.login} · {new Date(issue.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant={existingSprint ? 'outline' : 'default'}
                    className="gap-1.5 shrink-0"
                    onClick={() => handleStartSprint(issue)}
                    disabled={isStarting}
                  >
                    {isStarting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Play className="h-3.5 w-3.5" />
                    )}
                    {existingSprint ? 'Open sprint' : 'Start sprint'}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
