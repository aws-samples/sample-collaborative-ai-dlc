import { useState, useEffect, useCallback } from 'react';
import { useSprint } from '@/contexts/SprintContext';
import { useAuth } from '@/contexts/AuthContext';
import { useSprintEvents } from '@/hooks/useSprintEvents';
import { useQuestionAnchor } from '@/hooks/useQuestionAnchor';
import { questionAnchorId } from '@/lib/questionAnchor';
import { useProjectCache } from '@/hooks/useProjectsCache';
import {
  getGitProviderService,
  gitProviderTerminology,
  type GitComment,
} from '@/services/gitProvider';
import { sprintGraphService, extractPrs, type PrInfo } from '@/services/sprintGraph';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Separator } from '@/components/ui/separator';
import ReviewEditor from '@/components/ReviewEditor';
import CodeFileViewer from '@/components/CodeFileViewer';
import { PrCheckoutCommand } from '@/components/PrCheckoutCommand';
import {
  ExternalLink,
  EyeOff,
  Eye,
  MessageCircleQuestion,
  CheckCircle2,
  XCircle,
  Code2,
  GitPullRequest,
  AlertTriangle,
  ShieldAlert,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { DiscussButton } from '@/components/discussion';

// Last path segment of a repo ref (owner/repo → repo).
const repoShort = (repo: string) => repo.split('/').pop() || repo || '';

// PR state → status-dot color: open = emerald, merged = violet, closed = red,
// unknown = zinc.
const stateDotClass = (state: string) =>
  state === 'merged'
    ? 'bg-violet-500'
    : state === 'closed'
      ? 'bg-red-500'
      : state === 'open'
        ? 'bg-emerald-500'
        : 'bg-zinc-400';

function RiskBadge({ score, reasoning }: { score: string; reasoning: string }) {
  const n = parseInt(score);
  const color =
    n <= 2
      ? 'text-agent-success'
      : n <= 4
        ? 'text-green-400'
        : n <= 6
          ? 'text-amber-400'
          : n <= 8
            ? 'text-orange-500'
            : 'text-agent-error';
  const bg =
    n <= 2
      ? 'bg-agent-success/10 border-agent-success/30'
      : n <= 4
        ? 'bg-green-400/10 border-green-400/30'
        : n <= 6
          ? 'bg-amber-400/10 border-amber-400/30'
          : n <= 8
            ? 'bg-orange-500/10 border-orange-500/30'
            : 'bg-agent-error/10 border-agent-error/30';
  return (
    <Badge variant="outline" className={`gap-1 ${color} ${bg}`} title={reasoning}>
      <ShieldAlert className="h-3 w-3" /> Risk {n}/10
    </Badge>
  );
}

function ReviewStatusBar({
  status,
  riskScore,
  riskReasoning,
  stale,
}: {
  status?: string;
  riskScore?: string | null;
  riskReasoning?: string;
  stale?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 mb-3">
      {status && status !== 'PENDING' && (
        <Badge
          variant={
            status === 'PASSED'
              ? 'review'
              : status === 'FAILED'
                ? 'destructive'
                : status === 'PARTIAL'
                  ? 'warning'
                  : 'outline'
          }
          className="gap-1"
        >
          {status === 'PASSED' ? (
            <CheckCircle2 className="h-3 w-3" />
          ) : status === 'FAILED' ? (
            <XCircle className="h-3 w-3" />
          ) : status === 'PARTIAL' ? (
            <AlertTriangle className="h-3 w-3" />
          ) : null}
          {status}
        </Badge>
      )}
      {riskScore && !stale && <RiskBadge score={riskScore} reasoning={riskReasoning || ''} />}
    </div>
  );
}

// v1 projects are read-only: the v1 execution engine has been retired, so this
// page keeps all display functionality (review outputs, PR links/comments,
// artifacts, code files) but no write affordances (no review kick-offs,
// fix-findings, PR creation/linking, verdicts, or comment posting).
export default function ReviewPage() {
  const { user } = useAuth();
  const {
    sprint,
    requirements,
    userStories,
    tasks,
    codeFiles,
    questions,
    review,
    projectId,
    sprintId,
    reload,
  } = useSprint();

  const { project } = useProjectCache(projectId ?? null);
  const [prs, setPrs] = useState<PrInfo[]>([]);
  const [selectedPrId, setSelectedPrId] = useState<string>('');
  const [prComments, setPrComments] = useState<GitComment[]>([]);
  const [showBlindReveal, setShowBlindReveal] = useState(false);
  const [activeTab, setActiveTab] = useState('blind');

  useSprintEvents(
    sprintId,
    useCallback(() => {
      reload();
    }, [reload]),
  );

  // Fetch the sprint graph (and its PRs) on sprintId only — a full graph refetch
  // is expensive and must not be triggered by realtime branch/baseBranch updates.
  useEffect(() => {
    if (!sprintId) return;
    sprintGraphService
      .get(sprintId)
      .then((graph) => {
        const found = extractPrs(graph);
        setPrs(found);
        setSelectedPrId((prev) =>
          prev && found.some((p) => p.id === prev) ? prev : (found[0]?.id ?? ''),
        );
      })
      .catch((err) => {
        // Surface PR-loading failures instead of swallowing them — a silent catch
        // previously hid them (no PRs shown, no error).
        console.error('Failed to load sprint graph for PRs:', err);
      });
  }, [sprintId]);

  // Selected PR drives the View/checkout/comments below. Falls back to the
  // single PR copied onto the sprint vertex for backward compatibility.
  const selectedPr = prs.find((p) => p.id === selectedPrId) ?? prs[0] ?? null;
  const activePrUrl = selectedPr?.prUrl || sprint?.prUrl || '';
  const activePrNumber = selectedPr?.prNumber || sprint?.prNumber || '';
  const activeRepo = selectedPr?.repository || project?.gitRepo || '';

  // Provider-aware copy. Falls back to GitHub terminology before the project
  // loads (matches backend defaults).
  const prTerm = gitProviderTerminology(project?.gitProvider ?? 'github');

  const prTabLabel = (p: PrInfo) => `${repoShort(p.repository) || 'repo'} #${p.prNumber}`;
  const repoCount = new Set(prs.map((p) => p.repository)).size;
  const prCount = prs.length || (sprint?.prUrl ? 1 : 0);
  const viewPrLabel = selectedPr
    ? `View ${repoShort(selectedPr.repository) ? `${repoShort(selectedPr.repository)} #${selectedPr.prNumber}` : `${prTerm.changeRequestShort} #${selectedPr.prNumber}`}`
    : `View ${prTerm.changeRequestShort}`;

  // Load PR comments for the selected PR (display only)
  useEffect(() => {
    if (!activePrNumber || !activeRepo || !project) return;
    let cancelled = false;
    // Clear previous PR's comments so a slow response can't show them under the
    // newly selected PR, and guard against out-of-order resolution on fast switches.
    setPrComments([]);
    getGitProviderService(project.gitProvider)
      .getPullRequestComments(activeRepo, parseInt(activePrNumber))
      .then((res) => {
        if (!cancelled) setPrComments(res.comments);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activePrNumber, activeRepo, project]);

  const pendingQuestions = questions
    .filter((q) => !q.structuredAnswer)
    .toSorted((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  // Scroll to a question referenced by a #question-{id} URL hash (timeline links)
  useQuestionAnchor(questions.length > 0);

  const blindOutput = review?.blindReview;
  const fullOutput = review?.fullReview;
  const hasReviewResults = !!blindOutput || !!fullOutput;

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto p-6 space-y-6">
          <div>
            <h1 className="text-xl font-bold">{sprint?.name || 'Loading...'}</h1>
            <p className="text-sm text-muted-foreground">Review Phase -- Validate and approve</p>
          </div>

          <div className="rounded-lg border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
            This v1 space is read-only — agents can no longer be started and content can no longer
            be edited.
          </div>

          {/* Pending questions (static — answers can no longer be submitted) */}
          {pendingQuestions.map((pq) => (
            <Card
              key={pq.id}
              id={questionAnchorId(pq.id)}
              className="border-agent-waiting bg-agent-waiting/5"
            >
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <MessageCircleQuestion className="h-4 w-4 text-agent-waiting" />
                    <CardTitle className="text-sm">Agent Question</CardTitle>
                    <Badge variant="outline" className="text-[10px]">
                      Unanswered
                    </Badge>
                  </div>
                  <DiscussButton
                    entityType="question"
                    entityId={pq.id}
                    entityTitle={pq.questions[0]?.text || `${pq.agent} agent question`}
                  />
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  Asked by the {pq.agent} agent. The run has ended and answers can no longer be
                  submitted.
                </p>
                {pq.questions.map((sq, i) => (
                  <div key={i} className="border-l-2 border-primary/30 pl-3">
                    <div className="prose prose-sm dark:prose-invert max-w-none text-sm">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{sq.text}</ReactMarkdown>
                    </div>
                    {sq.options.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {sq.options.map((opt, oi) => (
                          <Badge
                            key={oi}
                            variant="outline"
                            className="text-[10px] text-muted-foreground"
                            title={opt.description}
                          >
                            {opt.label}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}

          {/* Pull requests — groups everything scoped to a single PR/repo:
              the repo tabs, the View PR link, and the local checkout command. */}
          {activePrUrl && (
            <div className="rounded-lg border bg-muted/30 p-3 space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                <GitPullRequest className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">Pull requests</span>
                <Badge variant="secondary" className="h-5 px-1.5">
                  {prCount}
                </Badge>
                {repoCount > 1 && (
                  <span className="text-xs text-muted-foreground">
                    across {repoCount} repositories
                  </span>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 ml-auto"
                  title={activeRepo ? `Open ${activeRepo} #${activePrNumber}` : 'Open pull request'}
                  onClick={() => window.open(activePrUrl, '_blank')}
                >
                  <ExternalLink className="h-3.5 w-3.5" /> {viewPrLabel}
                </Button>
              </div>
              {prs.length > 1 && (
                <ToggleGroup
                  type="single"
                  value={selectedPrId}
                  onValueChange={(v) => v && setSelectedPrId(v)}
                  className="flex-wrap justify-start"
                >
                  {prs.map((p) => (
                    <ToggleGroupItem
                      key={p.id}
                      value={p.id}
                      className="gap-1.5 text-xs"
                      title={p.repository}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${stateDotClass(p.state)}`} />
                      {prTabLabel(p)}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              )}
              {activePrNumber && (
                <PrCheckoutCommand
                  prNumber={activePrNumber}
                  branch={selectedPr?.branch || sprint?.branch}
                  baseBranch={selectedPr?.baseBranch || sprint?.baseBranch}
                  gitRepo={activeRepo || project?.gitRepo}
                />
              )}
            </div>
          )}

          {/* Review status */}
          {review &&
            (() => {
              const isCompleted = sprint?.phase === 'COMPLETED';
              const displayStatus = isCompleted ? 'COMPLETED' : review.status;
              const variant =
                isCompleted || review.status === 'PASSED'
                  ? 'review'
                  : review.status === 'FAILED'
                    ? 'destructive'
                    : 'outline';
              return (
                <div className="flex items-center gap-3 flex-wrap">
                  <Badge variant={variant} className="gap-1">
                    {isCompleted || review.status === 'PASSED' ? (
                      <CheckCircle2 className="h-3 w-3" />
                    ) : review.status === 'FAILED' ? (
                      <XCircle className="h-3 w-3" />
                    ) : null}
                    {displayStatus}
                  </Badge>
                </div>
              );
            })()}

          {/* Stale review warning */}
          {review?.stale && (
            <Card className="border-amber-500/50 bg-amber-500/5">
              <CardContent className="p-3 flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>
                  This review is <strong>stale</strong> — the construction agent was re-run after it
                  was created.
                </span>
              </CardContent>
            </Card>
          )}

          {/* Review tabs */}
          {hasReviewResults && (
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList>
                <TabsTrigger value="blind" className="gap-1.5 text-xs">
                  <EyeOff className="h-3 w-3" /> Technical Review
                </TabsTrigger>
                <TabsTrigger value="full" className="gap-1.5 text-xs">
                  <Eye className="h-3 w-3" /> Business Review
                </TabsTrigger>
                <TabsTrigger value="comments" className="gap-1.5 text-xs">
                  {prTerm.changeRequestShort} Comments{' '}
                  {prComments.length > 0 && (
                    <Badge variant="secondary" className="h-4 px-1 text-[9px]">
                      {prComments.length}
                    </Badge>
                  )}
                </TabsTrigger>
                <TabsTrigger value="code" className="gap-1.5 text-xs">
                  <Code2 className="h-3 w-3" /> Files{' '}
                  {codeFiles.length > 0 && (
                    <Badge variant="secondary" className="h-4 px-1 text-[9px]">
                      {codeFiles.length}
                    </Badge>
                  )}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="blind">
                <Card>
                  <CardContent className="p-4">
                    <ReviewStatusBar
                      status={review?.blindStatus}
                      riskScore={review?.blindRiskScore}
                      riskReasoning={review?.blindRiskReasoning}
                      stale={review?.stale}
                    />
                    {blindOutput ? (
                      <div className="prose prose-sm max-w-none dark:prose-invert">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{blindOutput}</ReactMarkdown>
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        No technical review was recorded for this sprint.
                      </p>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="full">
                <Card>
                  <CardContent className="p-4">
                    <ReviewStatusBar
                      status={review?.fullStatus}
                      riskScore={review?.fullRiskScore}
                      riskReasoning={review?.fullRiskReasoning}
                      stale={review?.stale}
                    />
                    {fullOutput ? (
                      <>
                        <div className="grid grid-cols-3 gap-3 mb-4">
                          <div className="text-center p-2 rounded-lg bg-muted">
                            <p className="text-lg font-bold">{requirements.length}</p>
                            <p className="text-[10px] text-muted-foreground">Requirements</p>
                          </div>
                          <div className="text-center p-2 rounded-lg bg-muted">
                            <p className="text-lg font-bold">{userStories.length}</p>
                            <p className="text-[10px] text-muted-foreground">User Stories</p>
                          </div>
                          <div className="text-center p-2 rounded-lg bg-muted">
                            <p className="text-lg font-bold">{tasks.length}</p>
                            <p className="text-[10px] text-muted-foreground">Tasks</p>
                          </div>
                        </div>
                        <div className="prose prose-sm max-w-none dark:prose-invert">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{fullOutput}</ReactMarkdown>
                        </div>
                        <Separator className="my-4" />
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setShowBlindReveal(!showBlindReveal)}
                          className="gap-1.5"
                        >
                          {showBlindReveal ? (
                            <EyeOff className="h-3 w-3" />
                          ) : (
                            <Eye className="h-3 w-3" />
                          )}
                          {showBlindReveal ? 'Hide' : 'Show'} All Requirements
                        </Button>
                        {showBlindReveal && (
                          <div className="mt-3 space-y-2">
                            {requirements.map((r) => (
                              <div key={r.id} className="text-xs border rounded p-2">
                                <strong>{r.title}</strong> -- {r.description}
                              </div>
                            ))}
                          </div>
                        )}
                      </>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        No business review was recorded for this sprint.
                      </p>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="comments">
                <Card>
                  <CardContent className="p-4 space-y-4">
                    {prComments.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No {prTerm.changeRequestShort} comments yet.
                      </p>
                    ) : (
                      prComments.map((comment) => (
                        <div key={comment.id} className="border rounded-lg p-3">
                          <div className="flex items-center gap-2 mb-2">
                            <img
                              src={comment.user.avatarUrl}
                              alt=""
                              className="h-5 w-5 rounded-full"
                            />
                            <span className="text-xs font-medium">{comment.user.login}</span>
                            <span className="text-[10px] text-muted-foreground">
                              {new Date(comment.createdAt).toLocaleString()}
                            </span>
                            {comment.path && (
                              <Badge variant="outline" className="text-[9px] h-4">
                                {comment.path}
                              </Badge>
                            )}
                          </div>
                          <div className="prose prose-sm max-w-none dark:prose-invert">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                              {comment.body}
                            </ReactMarkdown>
                          </div>
                        </div>
                      ))
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="code">
                <Card>
                  <CardContent className="p-4 space-y-2">
                    {codeFiles.map((file) => (
                      <CodeFileViewer key={file.id} codeFile={file} />
                    ))}
                    {codeFiles.length === 0 && (
                      <p className="text-sm text-muted-foreground">No code files yet.</p>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          )}

          {/* Human review (read-only) */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm">Your Review</CardTitle>
                {review && (
                  <DiscussButton
                    entityType="review"
                    entityId={review.id}
                    entityTitle="Sprint Review"
                  />
                )}
              </div>
            </CardHeader>
            <CardContent>
              <ReviewEditor
                review={review}
                sprintId={sprintId}
                userName={user?.displayName || user?.email || ''}
                gitProvider={project?.gitProvider ?? 'github'}
                readOnly
                onCreate={async () => {}}
                onSave={async () => {}}
                onSendToProvider={async () => {}}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
