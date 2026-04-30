import { useState, useEffect, useCallback } from 'react';
import { useSprint } from '@/contexts/SprintContext';
import { useAuth } from '@/contexts/AuthContext';
import { usePresence } from '@/hooks/usePresence';
import { useReviewAgents } from '@/hooks/useReviewAgents';
import { useSprintEvents } from '@/hooks/useSprintEvents';
import { projectsService, type Project } from '@/services/projects';
import { reviewsService } from '@/services/reviews';
import { questionsService } from '@/services/questions';
import { githubService, type PRComment } from '@/services/github';
import { sprintGraphService } from '@/services/sprintGraph';
import { realtimeService } from '@/services/realtime';
import { sprintsService } from '@/services/sprints';
import { agentsService } from '@/services/agents';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { AgentStatusBadge } from '@/components/domain/AgentStatusBadge';
import QuestionEditor from '@/components/QuestionEditor';
import ReviewEditor from '@/components/ReviewEditor';
import CodeFileViewer from '@/components/CodeFileViewer';
import { BranchSelector } from '@/components/BranchSelector';
import { PrCheckoutCommand } from '@/components/PrCheckoutCommand';
import { AgentStartErrorBanner } from '@/components/AgentStartErrorBanner';
import {
  Play, ExternalLink, Loader2, Wrench, Send,
  EyeOff, Eye, MessageCircleQuestion, CheckCircle2, XCircle, Code2, GitBranch, Link, AlertTriangle, ShieldAlert, X
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { StructuredAnswer } from '@/services/questions';

export default function ReviewPage() {
  const { user } = useAuth();
  const { sprint, requirements, userStories, tasks, codeFiles, questions, review, projectId, sprintId, reload, reloadReview } = useSprint();

  const [project, setProject] = useState<Project | null>(null);
  const [prComments, setPrComments] = useState<PRComment[]>([]);
  const [prBranch, setPrBranch] = useState('');
  const [prBaseBranch, setPrBaseBranch] = useState('main');
  const [newComment, setNewComment] = useState('');
  const [submittingComment, setSubmittingComment] = useState(false);
  const [showBlindReveal, setShowBlindReveal] = useState(false);
  const [showModifyModal, setShowModifyModal] = useState(false);
  const [modifyInstruction, setModifyInstruction] = useState('');
  const [activeTab, setActiveTab] = useState('blind');
  const [showLinkPrModal, setShowLinkPrModal] = useState(false);
  const [linkPrUrl, setLinkPrUrl] = useState('');
  const [linkPrNumber, setLinkPrNumber] = useState('');
  const [linkingPr, setLinkingPr] = useState(false);
  const [showCreatePrBranch, setShowCreatePrBranch] = useState(false);
  const [creatingPr, setCreatingPr] = useState(false);

  const currentUser = { id: user?.username || '', name: user?.displayName || user?.email || '', color: '#10b981' };
  const { setActivity } = usePresence(sprintId, currentUser);

  const { blindAgent, fullAgent, modifyAgent, launching, isAnyRunning, startBothReviews, startAgent, startError, clearStartError } = useReviewAgents({ projectId, sprintId });
  useSprintEvents(sprintId, useCallback(() => { reload(); }, [reload]));

  // Load project + graph
  useEffect(() => {
    if (projectId) projectsService.get(projectId).then(setProject).catch(() => {});
  }, [projectId]);

  useEffect(() => {
    if (sprintId) {
      sprintGraphService.get(sprintId).then(graph => {
        const prNode = graph.nodes.find(n => n.type === 'PullRequest');
        if (prNode) { setPrBranch((prNode as Record<string, string>).branch || ''); setPrBaseBranch((prNode as Record<string, string>).base_branch || 'main'); }
        // Fall back to sprint branch if no PR node yet
        else if (sprint?.branch) { setPrBranch(sprint.branch); setPrBaseBranch(sprint.baseBranch || 'main'); }
      }).catch(() => {});
    }
  }, [sprintId, sprint?.branch, sprint?.baseBranch]);

  // Load PR comments
  useEffect(() => {
    if (!sprint?.prNumber || !project?.gitRepo) return;
    const [owner, repo] = project.gitRepo.split('/');
    if (owner && repo) githubService.getPRComments(owner, repo, parseInt(sprint.prNumber)).then(res => setPrComments(res.comments)).catch(() => {});
  }, [sprint?.prNumber, project?.gitRepo]);

  const pendingQuestions = questions.filter(q => !q.structuredAnswer).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const blindOutput = review?.blindReview || blindAgent.completedOutput || blindAgent.streamingText;
  const fullOutput = review?.fullReview || fullAgent.completedOutput || fullAgent.streamingText;
  const hasReviewResults = !!blindOutput || !!fullOutput;

  const handleKickOffReviews = async () => {
    if (!review) { try { await reviewsService.create(sprintId); await reloadReview(); } catch { /* */ } }
    startBothReviews(prBranch, prBaseBranch);
  };

  const handleLinkPr = async () => {
    if (!linkPrUrl.trim()) return;
    setLinkingPr(true);
    try {
      // Extract PR number from URL if not manually entered
      const extractedNumber = linkPrNumber.trim() || linkPrUrl.match(/\/pull\/(\d+)/)?.[1] || '';
      await sprintsService.update(projectId, sprintId, { prUrl: linkPrUrl.trim(), prNumber: extractedNumber });
      await reload();
      setShowLinkPrModal(false);
      setLinkPrUrl('');
      setLinkPrNumber('');
    } catch (err) { alert('Failed to link PR: ' + (err instanceof Error ? err.message : 'Unknown error')); }
    finally { setLinkingPr(false); }
  };

  const handleCreatePr = async (branch: string, baseBranch: string) => {
    setCreatingPr(true);
    setShowCreatePrBranch(false);
    try {
      // Re-kick the orchestrator — it will see all tasks done and call trigger_pr_creation
      await agentsService.startWorkflow(projectId, {
        phase: 'construction-orchestrator', sprintId, branch, baseBranch, event: { event: 'start' },
      });
      await reload();
    } catch (err) { alert('Failed to create PR: ' + (err instanceof Error ? err.message : 'Unknown error')); }
    finally { setCreatingPr(false); }
  };

  const handleModifyCode = () => {
    if (!modifyInstruction.trim()) return;
    startAgent('review-modify', { branch: prBranch, baseBranch: prBaseBranch, description: modifyInstruction });
    setShowModifyModal(false);
    setModifyInstruction('');
  };

  const handleAddComment = async () => {
    if (!newComment.trim() || !sprint?.prNumber || !project?.gitRepo) return;
    setSubmittingComment(true);
    try {
      const [owner, repo] = project.gitRepo.split('/');
      await githubService.addPRComment(owner, repo, parseInt(sprint.prNumber), { body: newComment });
      setNewComment('');
      const comments = await githubService.getPRComments(owner, repo, parseInt(sprint.prNumber));
      setPrComments(comments.comments);
    } catch (err) { alert('Failed to add comment: ' + (err instanceof Error ? err.message : 'Unknown error')); }
    finally { setSubmittingComment(false); }
  };

  const handleAnswerQuestion = async (questionId: string, answer: StructuredAnswer) => {
    try {
      await questionsService.update(sprintId, questionId, { structuredAnswer: answer });
      realtimeService.send('broadcastToDocument', { documentId: `sprint:${sprintId}`, action: 'question.answered', data: { questionId, answer } });
      await reload();
    } catch (err) { console.error('Failed to answer:', err); }
  };

  const handleDismissQuestion = async (questionId: string) => {
    const dismissed: StructuredAnswer = { answers: [{ selectedOptions: [], freeText: '(dismissed — agent no longer running)' }] };
    try {
      await questionsService.update(sprintId, questionId, { structuredAnswer: dismissed });
      await reload();
    } catch (err) { console.error('Failed to dismiss question:', err); }
  };

  return (
    <div className="flex flex-col h-full">

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto p-6 space-y-6">
          <div>
            <h1 className="text-xl font-bold">{sprint?.name || 'Loading...'}</h1>
            <p className="text-sm text-muted-foreground">Review Phase -- Validate and approve</p>
          </div>

          {/* Pending questions */}
          {pendingQuestions.map(pq => (
            <Card key={pq.id} className="border-agent-waiting bg-agent-waiting/5">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <MessageCircleQuestion className="h-4 w-4 text-agent-waiting" />
                    <CardTitle className="text-sm">Agent Question</CardTitle>
                  </div>
                  <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive" onClick={() => handleDismissQuestion(pq.id)} title="Dismiss question">
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <QuestionEditor question={pq} sprintId={sprintId} userName={user?.displayName || user?.email || ''}
                  onAnswer={(answer) => handleAnswerQuestion(pq.id, answer)}
                  onAutoSave={async (draft) => { questionsService.update(sprintId, pq.id, { draftAnswer: draft }).catch(() => {}); }}
                  onFocus={() => setActivity('question', pq.id)} onBlur={() => setActivity('idle')}
                />
              </CardContent>
            </Card>
          ))}

          {/* Agent streaming cards */}
          {modifyAgent.status === 'RUNNING' && (
            <Card className="bg-zinc-950 text-zinc-300 border-phase-inception/30">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Wrench className="h-3.5 w-3.5 text-phase-inception" />
                  <span className="text-xs font-medium text-zinc-400">Code Modification Agent</span>
                  <AgentStatusBadge compact status="running" className="ml-auto" />
                </div>
                {/* Active tool call */}
                {modifyAgent.activeToolCall && (
                  <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 mb-2">
                    <Loader2 className="h-3 w-3 text-amber-400 animate-spin shrink-0" />
                    <span className="text-xs font-mono text-amber-400 truncate">{modifyAgent.activeToolCall}</span>
                  </div>
                )}
                {/* Tool call summary */}
                {modifyAgent.toolCalls.length > 0 && (
                  <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 mb-2">
                    <Wrench className="h-2.5 w-2.5" />
                    <span>{modifyAgent.toolCalls.filter(t => t.status === 'completed').length}/{modifyAgent.toolCalls.length} tools completed</span>
                  </div>
                )}
                <div className="prose prose-invert prose-sm max-w-none max-h-[200px] overflow-y-auto">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{modifyAgent.streamingText}</ReactMarkdown>
                  <span className="inline-block w-1.5 h-3.5 bg-zinc-400 animate-pulse ml-0.5 align-middle" />
                </div>
              </CardContent>
            </Card>
          )}

          {/* Review controls */}
          <div className="flex items-center gap-3 flex-wrap">
            <Button onClick={handleKickOffReviews} disabled={isAnyRunning || !!launching || !sprint?.prUrl} className="gap-2">
              {launching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {launching ? 'Starting...' : 'Kick-Off Review Agents'}
            </Button>
            <Button variant="outline" size="sm" className="gap-1.5"
              onClick={() => setShowModifyModal(true)} disabled={isAnyRunning || !sprint?.prUrl}>
              <Wrench className="h-3.5 w-3.5" /> Modify Code
            </Button>
            {sprint?.prUrl && (
              <Button variant="outline" size="sm" className="gap-1.5 ml-auto"
                onClick={() => window.open(sprint.prUrl!, '_blank')}>
                <ExternalLink className="h-3.5 w-3.5" /> View PR
              </Button>
            )}

            {/* Review status */}
            {review && (
              <Badge variant={review.status === 'PASSED' ? 'review' : review.status === 'FAILED' ? 'destructive' : 'outline'}
                className="gap-1">
                {review.status === 'PASSED' ? <CheckCircle2 className="h-3 w-3" /> : review.status === 'FAILED' ? <XCircle className="h-3 w-3" /> : null}
                {review.status}
              </Badge>
            )}

            {/* Risk score badge */}
            {review?.riskScore && !review.stale && (() => {
              const score = parseInt(review.riskScore);
              const color = score <= 2 ? 'text-agent-success' : score <= 4 ? 'text-green-400' : score <= 6 ? 'text-amber-400' : score <= 8 ? 'text-orange-500' : 'text-agent-error';
              const bg = score <= 2 ? 'bg-agent-success/10 border-agent-success/30' : score <= 4 ? 'bg-green-400/10 border-green-400/30' : score <= 6 ? 'bg-amber-400/10 border-amber-400/30' : score <= 8 ? 'bg-orange-500/10 border-orange-500/30' : 'bg-agent-error/10 border-agent-error/30';
              return (
                <Badge variant="outline" className={`gap-1 ${color} ${bg}`} title={review.riskReasoning}>
                  <ShieldAlert className="h-3 w-3" /> Risk {score}/10
                </Badge>
              );
            })()}
          </div>

          {startError && (
            <AgentStartErrorBanner error={startError} onDismiss={clearStartError} />
          )}

          {/* Local checkout command */}
          {sprint?.prUrl && sprint?.prNumber && (
            <PrCheckoutCommand prNumber={sprint.prNumber} branch={sprint.branch} baseBranch={sprint.baseBranch} gitRepo={project?.gitRepo} />
          )}

          {/* Missing PR warning */}
          {!sprint?.prUrl && (
            <Card className="border-amber-500/50 bg-amber-500/5">
              <CardContent className="p-4 space-y-3">
                <p className="text-sm text-amber-600 dark:text-amber-400">
                  No Pull Request found. AI review agents and code modification require an open PR.
                </p>
                <div className="flex gap-2 flex-wrap">
                  <Button size="sm" className="gap-1.5" disabled={creatingPr}
                    onClick={() => setShowCreatePrBranch(true)}>
                    {creatingPr ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitBranch className="h-3.5 w-3.5" />}
                    {creatingPr ? 'Creating PR...' : 'Create PR'}
                  </Button>
                  <Button size="sm" variant="outline" className="gap-1.5"
                    onClick={() => setShowLinkPrModal(true)}>
                    <Link className="h-3.5 w-3.5" /> Link Existing PR
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Agent status row */}
          {(blindAgent.status || fullAgent.status || modifyAgent.status) && (
            <div className="flex items-center gap-4">
              {blindAgent.status && <AgentStatusBadge status={blindAgent.status === 'SUCCEEDED' ? 'completed' : blindAgent.status === 'RUNNING' ? 'running' : blindAgent.status === 'FAILED' ? 'failed' : 'idle'} agentType="blind review" />}
              {fullAgent.status && <AgentStatusBadge status={fullAgent.status === 'SUCCEEDED' ? 'completed' : fullAgent.status === 'RUNNING' ? 'running' : fullAgent.status === 'FAILED' ? 'failed' : 'idle'} agentType="full review" />}
              {modifyAgent.status && <AgentStatusBadge status={modifyAgent.status === 'SUCCEEDED' ? 'completed' : modifyAgent.status === 'RUNNING' ? 'running' : modifyAgent.status === 'FAILED' ? 'failed' : 'idle'} agentType="modify" />}
            </div>
          )}

          {/* Stale review warning */}
          {review?.stale && (
            <Card className="border-amber-500/50 bg-amber-500/5">
              <CardContent className="p-3 flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>This review is <strong>stale</strong> — the construction agent was re-run after it was created. Kick off new review agents to get a fresh review.</span>
              </CardContent>
            </Card>
          )}

          {/* Review tabs */}
          {hasReviewResults && (
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList>
                <TabsTrigger value="blind" className="gap-1.5 text-xs">
                  <EyeOff className="h-3 w-3" /> Blind Review
                  {blindAgent.status === 'RUNNING' && <span className="h-1.5 w-1.5 rounded-full bg-agent-running animate-pulse" />}
                </TabsTrigger>
                <TabsTrigger value="full" className="gap-1.5 text-xs">
                  <Eye className="h-3 w-3" /> Full Review
                  {fullAgent.status === 'RUNNING' && <span className="h-1.5 w-1.5 rounded-full bg-agent-running animate-pulse" />}
                </TabsTrigger>
                <TabsTrigger value="comments" className="gap-1.5 text-xs">
                  PR Comments {prComments.length > 0 && <Badge variant="secondary" className="h-4 px-1 text-[9px]">{prComments.length}</Badge>}
                </TabsTrigger>
                <TabsTrigger value="code" className="gap-1.5 text-xs">
                  <Code2 className="h-3 w-3" /> Files {codeFiles.length > 0 && <Badge variant="secondary" className="h-4 px-1 text-[9px]">{codeFiles.length}</Badge>}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="blind">
                <Card>
                  <CardContent className="p-4">
                    {/* Show streaming activity while blind review agent is running */}
                    {blindAgent.status === 'RUNNING' && (
                      <div className="mb-4 space-y-2">
                        {blindAgent.activeToolCall && (
                          <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5">
                            <Loader2 className="h-3 w-3 text-amber-400 animate-spin shrink-0" />
                            <span className="text-xs font-mono text-amber-400 truncate">{blindAgent.activeToolCall}</span>
                          </div>
                        )}
                        {blindAgent.toolCalls.length > 0 && (
                          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                            <Wrench className="h-2.5 w-2.5" />
                            <span>{blindAgent.toolCalls.filter(t => t.status === 'completed').length}/{blindAgent.toolCalls.length} tools completed</span>
                          </div>
                        )}
                        <Separator />
                      </div>
                    )}
                    {blindOutput ? (
                      <>
                        <div className="prose prose-sm max-w-none dark:prose-invert">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{blindOutput}</ReactMarkdown>
                        </div>
                        <Separator className="my-4" />
                        <Button variant="outline" size="sm" onClick={() => setShowBlindReveal(!showBlindReveal)} className="gap-1.5">
                          {showBlindReveal ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                          {showBlindReveal ? 'Hide' : 'Reveal'} Requirements
                        </Button>
                        {showBlindReveal && (
                          <div className="mt-3 space-y-2">
                            {requirements.map(r => <div key={r.id} className="text-xs border rounded p-2"><strong>{r.title}</strong> -- {r.description}</div>)}
                          </div>
                        )}
                      </>
                    ) : (
                      <p className="text-sm text-muted-foreground">Blind review not yet available. Kick off review agents to start.</p>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="full">
                <Card>
                  <CardContent className="p-4">
                    {/* Show streaming activity while full review agent is running */}
                    {fullAgent.status === 'RUNNING' && (
                      <div className="mb-4 space-y-2">
                        {fullAgent.activeToolCall && (
                          <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5">
                            <Loader2 className="h-3 w-3 text-amber-400 animate-spin shrink-0" />
                            <span className="text-xs font-mono text-amber-400 truncate">{fullAgent.activeToolCall}</span>
                          </div>
                        )}
                        {fullAgent.toolCalls.length > 0 && (
                          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                            <Wrench className="h-2.5 w-2.5" />
                            <span>{fullAgent.toolCalls.filter(t => t.status === 'completed').length}/{fullAgent.toolCalls.length} tools completed</span>
                          </div>
                        )}
                        <Separator />
                      </div>
                    )}
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
                      </>
                    ) : (
                      <p className="text-sm text-muted-foreground">Full review not yet available.</p>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="comments">
                <Card>
                  <CardContent className="p-4 space-y-4">
                    {prComments.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No PR comments yet.</p>
                    ) : (
                      prComments.map(comment => (
                        <div key={comment.id} className="border rounded-lg p-3">
                          <div className="flex items-center gap-2 mb-2">
                            <img src={comment.user.avatarUrl} alt="" className="h-5 w-5 rounded-full" />
                            <span className="text-xs font-medium">{comment.user.login}</span>
                            <span className="text-[10px] text-muted-foreground">{new Date(comment.createdAt).toLocaleString()}</span>
                            {comment.path && <Badge variant="outline" className="text-[9px] h-4">{comment.path}</Badge>}
                          </div>
                          <div className="prose prose-sm max-w-none dark:prose-invert">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{comment.body}</ReactMarkdown>
                          </div>
                        </div>
                      ))
                    )}
                    <Separator />
                    <div className="space-y-2">
                      <Textarea placeholder="Add a comment..." value={newComment} onChange={e => setNewComment(e.target.value)} rows={3} />
                      <Button size="sm" onClick={handleAddComment} disabled={submittingComment || !newComment.trim()} className="gap-1.5">
                        <Send className="h-3 w-3" /> {submittingComment ? 'Posting...' : 'Post Comment'}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="code">
                <Card>
                  <CardContent className="p-4 space-y-2">
                    {codeFiles.map(file => <CodeFileViewer key={file.id} codeFile={file} />)}
                    {codeFiles.length === 0 && <p className="text-sm text-muted-foreground">No code files yet.</p>}
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          )}

          {/* Human review */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Your Review</CardTitle>
            </CardHeader>
            <CardContent>
              <ReviewEditor
                review={review} sprintId={sprintId} userName={user?.displayName || user?.email || ''}
                onCreate={async () => { await reviewsService.create(sprintId); await reloadReview(); }}
                onSave={async (updates) => { await reviewsService.update(sprintId, updates); await reloadReview(); }}
              />
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Modify Code Dialog */}
      <Dialog open={showModifyModal} onOpenChange={setShowModifyModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Modify Code</DialogTitle>
            <DialogDescription>Describe the changes you want the AI agent to make to the code.</DialogDescription>
          </DialogHeader>
          <Textarea placeholder="e.g., Fix error handling in the auth middleware..." value={modifyInstruction}
            onChange={e => setModifyInstruction(e.target.value)} rows={5} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowModifyModal(false)}>Cancel</Button>
            <Button onClick={handleModifyCode} disabled={!modifyInstruction.trim()} className="gap-1.5">
              <Wrench className="h-3.5 w-3.5" /> Submit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Link Existing PR Dialog */}
      <Dialog open={showLinkPrModal} onOpenChange={setShowLinkPrModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Link Existing Pull Request</DialogTitle>
            <DialogDescription>
              Paste the URL of an existing GitHub PR. The PR number will be extracted automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="pr-url">PR URL</Label>
              <Input id="pr-url" placeholder="https://github.com/owner/repo/pull/42"
                value={linkPrUrl} onChange={e => setLinkPrUrl(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pr-number">PR Number <span className="text-muted-foreground text-xs">(optional — auto-extracted from URL)</span></Label>
              <Input id="pr-number" placeholder="42" value={linkPrNumber}
                onChange={e => setLinkPrNumber(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowLinkPrModal(false)}>Cancel</Button>
            <Button onClick={handleLinkPr} disabled={!linkPrUrl.trim() || linkingPr} className="gap-1.5">
              {linkingPr ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link className="h-3.5 w-3.5" />}
              {linkingPr ? 'Linking...' : 'Link PR'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Branch selector for manual PR creation */}
      {showCreatePrBranch && project && (
        <BranchSelector
          gitRepo={project.gitRepo}
          onSelect={(branch, baseBranch) => handleCreatePr(branch, baseBranch)}
          onCancel={() => setShowCreatePrBranch(false)}
        />
      )}
    </div>
  );
}
