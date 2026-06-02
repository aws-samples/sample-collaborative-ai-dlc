// Pool worker - long-running ECS task that polls for agent jobs
//
// SECURITY NOTE (for ASH/semgrep reviewers)
// -----------------------------------------------------------------------------
// This file intentionally uses `spawn`, `execSync`, and `path.join` to invoke
// agent CLIs (Kiro, Claude, OpenCode) and to prepare per-job workspaces. These
// patterns trigger three semgrep rules which are suppressed for this file
// (see `.ash/ash.yaml` suppressions):
//
//   - javascript.lang.security.detect-child-process
//   - javascript.lang.security.audit.path-traversal.path-join-resolve-traversal
//   - javascript.lang.security.audit.unsafe-formatstring
//
// Rationale:
//   * All CLI arguments come from server-controlled DynamoDB job records and
//     pre-defined file paths under `/opt/aidlc-rules/` and `/workspace/<jobId>`.
//     No HTTP-bound user input reaches these child_process calls.
//   * `path.join(base, phaseDir, file)` arguments are enumerated from our own
//     read-only rule directory at build time; no user-controlled segments.
//   * The ECS task runs in a private subnet with no inbound access, scoped IAM
//     role, and a dedicated workspace per job. Even if an agent CLI were
//     somehow coerced, the blast radius is one job's `/workspace/<jobId>`.
//
// See docs/SECURITY_REVIEW_PREP.md and threat-model/ for the full analysis.
// -----------------------------------------------------------------------------
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
  PutCommand,
  DeleteCommand,
} = require('@aws-sdk/lib-dynamodb');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const gremlin = require('gremlin');
const { fromNodeProviderChain } = require('@aws-sdk/credential-providers');
const { getUrlAndHeaders } = require('gremlin-aws-sigv4/lib/utils');
const { cleanupMergedTaskBranch } = require('./branch-cleanup');
const { buildConstructionOrchestratorPrompt } = require('./construction-orchestrator-prompt');

// ---------------------------------------------------------------------------
// Driver — pluggable agent CLI abstraction
// At startup, discoverInstalledDrivers() probes which CLI binaries are present
// on PATH. Only installed CLIs are attempted — no env var or deploy-time config.
// _availableClis is populated with whichever ones authenticate successfully.
// ---------------------------------------------------------------------------
const { getDriver, discoverInstalledDrivers } = require('./drivers');
let _availableClis = []; // populated by main() at startup
let _cliAuthErrors = {}; // populated by main() at startup

// Prevent unhandled exceptions/rejections from killing the ECS task.
// Each pool worker is a long-lived ECS task; a crash wastes the entire container.
process.on('uncaughtException', (err) => {
  console.error('[pool-worker] UNCAUGHT EXCEPTION (process kept alive):', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[pool-worker] UNHANDLED REJECTION (process kept alive):', reason);
});

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambda = new LambdaClient({});

const env = {
  workerId: process.env.WORKER_ID || 'unknown',
  poolTable: process.env.POOL_TABLE,
  agentOutputsTable: process.env.AGENT_OUTPUTS_TABLE,
  region: process.env.AWS_REGION || 'us-east-1',
  version: process.env.POOL_VERSION || process.env.IMAGE_TAG || 'unknown',
};

const POLL_INTERVAL = 3000;
const HEARTBEAT_INTERVAL = 30000;

// Mark this worker as idle, advertising which CLIs it has authenticated.
async function setIdle() {
  await ddb.send(
    new UpdateCommand({
      TableName: env.poolTable,
      Key: { workerId: env.workerId },
      UpdateExpression:
        'SET #s = :s, lastHeartbeat = :t, version = :v, availableClis = :clis, cliAuthErrors = :errs REMOVE job',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':s': 'idle',
        ':t': Date.now(),
        ':v': env.version,
        ':clis': _availableClis,
        ':errs': _cliAuthErrors,
      },
    }),
  );
}

// Poll for assigned job, or check if we've been drained
async function pollForJob() {
  const result = await ddb.send(
    new GetCommand({
      TableName: env.poolTable,
      Key: { workerId: env.workerId },
    }),
  );
  const item = result.Item;
  if (!item) return { action: 'exit' };
  if (item.status === 'draining') return { action: 'exit' };
  if (item.status === 'assigned' && item.job) return { action: 'job', job: item.job };
  return { action: 'wait' };
}

async function saveStatus(executionId, agentType, projectId, status) {
  if (!env.agentOutputsTable) return;
  await ddb
    .send(
      new PutCommand({
        TableName: env.agentOutputsTable,
        Item: {
          executionId,
          agentType,
          projectId,
          status,
          expiresAt: Math.floor(Date.now() / 1000) + 86400,
        },
      }),
    )
    .catch((e) => console.error('Failed to save status:', e.message));
}

// Update the AgentRun node in Neptune on job completion/failure.
// This is best-effort — failures are logged but do not crash the worker.
async function updateAgentRunStatus(job, status) {
  if (!job.sprintId || job.taskId) return; // only top-level agents have AgentRun nodes
  const neptuneEndpoint = process.env.NEPTUNE_ENDPOINT;
  if (!neptuneEndpoint) return;
  try {
    const creds = await fromNodeProviderChain()();
    creds.region = env.region;
    const info = getUrlAndHeaders(neptuneEndpoint, '8182', creds, '/gremlin', 'wss');
    const conn = new gremlin.driver.DriverRemoteConnection(info.url, { headers: info.headers });
    const g = gremlin.process.AnonymousTraversalSource.traversal().withRemote(conn);
    const { cardinality } = gremlin.process;
    try {
      await g
        .V()
        .has('AgentRun', 'execution_id', job.executionId)
        .property(cardinality.single, 'status', status)
        .property(cardinality.single, 'completed_at', new Date().toISOString())
        .next();
    } finally {
      await conn.close();
    }
  } catch (e) {
    console.error('[pool-worker] Failed to update AgentRun status:', e.message);
  }
}

const RULES_DIR = '/opt/aidlc-rules';

// Copy embedded steering files into workspace for the given phase.
// After writing to the canonical .kiro/steering/ location, the active driver's
// getAdditionalSteeringPaths() is called to propagate the same content to any
// CLI-specific locations (e.g. .claude/CLAUDE.md, .opencode/instructions.md).
function fetchSteeringFiles(phase, agentCli) {
  const workspaceDir = '/workspace';
  const dest = `${workspaceDir}/.kiro/steering`;
  execSync(`mkdir -p ${dest}`, { stdio: 'ignore' });

  // Construction orchestrator should NOT load steering files — it only dispatches sub-agents
  // Bugfix agents are general-purpose and don't follow the AI-DLC workflow
  if (phase === 'construction-orchestrator' || phase === 'bugfix') return;

  // Review agents use operations steering rules
  const effectivePhase = phase.startsWith('review') ? 'review' : phase;

  // Core workflow
  try {
    fs.copyFileSync(`${RULES_DIR}/aws-aidlc-rules/core-workflow.md`, `${dest}/core-workflow.md`);
  } catch {
    console.error('[pool-worker] Missing core-workflow.md');
  }

  // Common rules
  const commonDir = `${RULES_DIR}/aws-aidlc-rule-details/common`;
  try {
    for (const f of fs.readdirSync(commonDir).filter((f) => f.endsWith('.md'))) {
      fs.copyFileSync(path.join(commonDir, f), `${dest}/common-${f}`);
    }
  } catch {
    console.error('[pool-worker] Could not copy common rules');
  }

  // Phase-specific rules
  const phaseDir = effectivePhase === 'review' ? 'operations' : effectivePhase;
  const phasePath = `${RULES_DIR}/aws-aidlc-rule-details/${phaseDir}`;
  try {
    for (const f of fs.readdirSync(phasePath).filter((f) => f.endsWith('.md'))) {
      fs.copyFileSync(path.join(phasePath, f), `${dest}/${phaseDir}-${f}`);
    }
  } catch {
    console.error(`[pool-worker] Could not copy phase rules for ${phaseDir}`);
  }

  // ---------------------------------------------------------------------------
  // Driver-specific steering paths
  // Propagate the .kiro/steering/ content to any CLI-specific locations
  // (e.g. .claude/CLAUDE.md, .opencode/instructions.md).
  // ---------------------------------------------------------------------------
  const additionalPaths = getDriver(agentCli).getAdditionalSteeringPaths(workspaceDir);
  for (const entry of additionalPaths) {
    try {
      if (entry.type === 'concat-dir') {
        // Concatenate all .md files from src dir into a single dest file
        execSync(`mkdir -p "${path.dirname(entry.dest)}"`, { stdio: 'ignore' });
        const files = fs
          .readdirSync(entry.src)
          .filter((f) => f.endsWith('.md'))
          .sort();
        const combined = files
          .map((f) => fs.readFileSync(path.join(entry.src, f), 'utf8'))
          .join('\n\n---\n\n');
        fs.writeFileSync(entry.dest, combined, 'utf8');
        console.log(`[pool-worker] Wrote ${files.length} steering files to ${entry.dest}`);
      } else if (entry.type === 'copy-file') {
        execSync(`mkdir -p "${path.dirname(entry.dest)}"`, { stdio: 'ignore' });
        fs.copyFileSync(entry.src, entry.dest);
      } else if (entry.type === 'dir') {
        execSync(`mkdir -p "${entry.dest}"`, { stdio: 'ignore' });
        const files = fs.readdirSync(entry.src).filter((f) => f.endsWith('.md'));
        for (const f of files) {
          fs.copyFileSync(path.join(entry.src, f), path.join(entry.dest, f));
        }
      }
    } catch (err) {
      console.error(
        `[pool-worker] Failed to write additional steering path "${entry.dest}":`,
        err.message,
      );
    }
  }
}

// Setup workspace for a job (git clone, steering files)
function setupWorkspace(job) {
  execSync('rm -rf /workspace/* /workspace/.* 2>/dev/null || true', { stdio: 'ignore' });
  execSync('mkdir -p /workspace', { stdio: 'ignore' });

  if (job.gitRepo) {
    try {
      const auth = job.gitToken ? `x-access-token:${job.gitToken}@` : '';

      // Try to clone - may fail if repo is empty
      try {
        execSync(`git clone "https://${auth}github.com/${job.gitRepo}.git" /workspace`, {
          stdio: 'inherit',
        });
      } catch {
        // If clone fails (empty repo), initialize new repo
        console.log('[pool-worker] Clone failed (likely empty repo), initializing...');
        execSync(`git init /workspace`, { stdio: 'inherit' });
        execSync(
          `cd /workspace && git remote add origin "https://${auth}github.com/${job.gitRepo}.git"`,
          { stdio: 'inherit' },
        );
      }

      // Configure git
      execSync(`cd /workspace && git config user.email "ai-dlc@example.com"`, { stdio: 'inherit' });
      execSync(`cd /workspace && git config user.name "AI-DLC Agent"`, { stdio: 'inherit' });

      // For construction (sub-agents + orchestrator) and review phases, checkout/create the working branch
      const needsBranch = [
        'construction',
        'construction-orchestrator',
        'review-blind',
        'review-full',
        'review-modify',
        'bugfix',
      ].includes(job.agentType);
      if (needsBranch && job.branch) {
        try {
          // Check if we have any commits
          const hasCommits =
            execSync(`cd /workspace && git rev-parse HEAD 2>/dev/null || echo "no"`, {
              encoding: 'utf8',
            }).trim() !== 'no';

          if (!hasCommits) {
            // Empty repo - create initial commit on the repo's default branch (typically main)
            const defaultBranch = 'main';
            execSync(`cd /workspace && git checkout -b ${defaultBranch}`, { stdio: 'inherit' });
            execSync(`cd /workspace && echo "# ${job.gitRepo}" > README.md`, { stdio: 'inherit' });
            execSync(`cd /workspace && git add README.md`, { stdio: 'inherit' });
            execSync(`cd /workspace && git commit -m "Initial commit"`, { stdio: 'inherit' });
            try {
              execSync(`cd /workspace && git push -u origin ${defaultBranch}`, {
                stdio: 'inherit',
              });
            } catch (pushErr) {
              console.error(
                `[pool-worker] Failed to push initial commit to ${defaultBranch}: ${pushErr.message}`,
              );
            }
          }

          // Determine which base to branch from.
          // For construction sub-agents, baseBranch is the sprint branch.
          // We need to verify it exists on the remote; if not, fall back to main.
          const desiredBase = job.baseBranch || 'main';
          const baseExistsOnRemote = execSync(
            `cd /workspace && git ls-remote --heads origin ${desiredBase}`,
            { encoding: 'utf8' },
          ).trim();
          const effectiveBase = baseExistsOnRemote ? desiredBase : 'main';
          if (!baseExistsOnRemote && desiredBase !== 'main') {
            console.log(
              `[pool-worker] Base branch "${desiredBase}" not found on remote, falling back to "main"`,
            );
          }

          // Now create/checkout working branch
          const branchExists = execSync(
            `cd /workspace && git ls-remote --heads origin ${job.branch}`,
            { encoding: 'utf8' },
          ).trim();

          if (branchExists) {
            // Branch exists on remote — fetch and check it out
            execSync(`cd /workspace && git fetch origin ${job.branch}`, { stdio: 'inherit' });
            execSync(`cd /workspace && git checkout ${job.branch}`, { stdio: 'inherit' });
          } else {
            // Branch does not exist on remote — create it from the effective base
            console.log(
              `[pool-worker] Creating new branch ${job.branch} from origin/${effectiveBase}`,
            );
            execSync(`cd /workspace && git fetch origin ${effectiveBase}`, { stdio: 'inherit' });
            execSync(`cd /workspace && git checkout -b ${job.branch} origin/${effectiveBase}`, {
              stdio: 'inherit',
            });
          }

          // Verify we're on the right branch
          const currentBranch = execSync('cd /workspace && git branch --show-current', {
            encoding: 'utf8',
          }).trim();
          console.log(`[pool-worker] Workspace ready on branch: ${currentBranch}`);
          if (currentBranch !== job.branch) {
            console.error(
              `[pool-worker] WARNING: Expected branch ${job.branch} but on ${currentBranch}`,
            );
          }
        } catch (err) {
          console.error(`[pool-worker] Git branch setup failed for ${job.branch}: ${err.message}`);
        }
      }
    } catch (gitErr) {
      console.error('[pool-worker] Git setup failed:', gitErr.message);
    }
  }

  const phase = (job.agentType || 'inception').toLowerCase();
  fetchSteeringFiles(phase, job.agentCli);

  // Write project-level config to override any repo-level settings (e.g.
  // a .opencode/opencode.json that points at the wrong provider/model).
  // This must run AFTER cloning so it overwrites whatever the repo ships.
  const activeDriver = getDriver(job.agentCli);
  if (typeof activeDriver.writeProjectConfig === 'function') {
    activeDriver.writeProjectConfig('/workspace', process.env);
  }
}

// Build phase-specific prompt
function buildPrompt(job) {
  const phase = (job.agentType || 'inception').toLowerCase();
  if (phase === 'inception') return buildInceptionPrompt(job);
  if (phase === 'construction') return buildConstructionPrompt(job);
  if (phase === 'construction-orchestrator') return buildConstructionOrchestratorPrompt(job);
  if (phase === 'review-blind') return buildBlindReviewPrompt(job);
  if (phase === 'review-full') return buildFullReviewPrompt(job);
  if (phase === 'review-modify') return buildReviewModifyPrompt(job);
  if (phase === 'bugfix') return buildBugfixPrompt(job);
  // Default prompt for other phases
  return (
    `You are an AI-DLC agent running the "${phase}" phase. Read the steering files in .kiro/steering/ for your workflow rules.\n\n` +
    (job.description ? `PROJECT DESCRIPTION:\n${job.description}\n\n` : '') +
    `Begin the ${phase} phase. Use the graph MCP tools to read and write all artifacts to Neptune. Do NOT create or modify markdown files as output.`
  );
}

function buildInceptionPrompt(job) {
  const isRerun = (job.runNumber || 1) > 1;

  if (isRerun) {
    return `You are the Inception Agent for the AI-DLC platform — RE-RUN #${job.runNumber}.

## CONTEXT: THIS IS A RE-RUN

The team has previously completed an inception phase for this sprint. They have reviewed the generated artifacts and want to make changes. The original project description and the artifacts already in the graph remain intact.

**Your task**: Understand what the team wants to change (see RE-RUN INSTRUCTIONS below), then update the Neptune graph accordingly — modifying, adding, or removing Requirements, UserStories, and Tasks as needed.

## CRITICAL RULES (these override everything else)

1. **USE \`ask_question\` FOR ALL HUMAN INPUT.** This is the ONLY way to communicate with the team. NEVER create question files.

2. **READ EXISTING ARTIFACTS FIRST.** Call \`get_sprint_graph\` to understand what already exists before making any changes.

3. **WRITE ALL ARTIFACTS TO NEPTUNE.** Use \`add_node\`, \`update_node\`, or delete operations as appropriate. ALWAYS pass the \`edges\` parameter on \`add_node\` to maintain BREAKS_INTO links.

4. **DO NOT WRITE MARKDOWN FILES AS OUTPUT.** The graph database is your only artifact output channel.

## STEERING FILES

Read the steering files in .kiro/steering/ for detailed workflow rules:
- \`core-workflow.md\` — Master workflow with phase/stage structure
- \`common-question-format-guide.md\` — How to use \`ask_question\` (CRITICAL)
- \`inception-*.md\` — Detailed steps for each inception stage

## QUICK START

1. Call \`get_sprint_graph\` to see what already exists.
2. Read the original description and re-run instructions below.
3. Make targeted changes — do not regenerate everything from scratch unless explicitly asked.
4. Ensure Task nodes exist for every UserStory (construction phase depends on them).

## ORIGINAL PROJECT DESCRIPTION

${job.description || '(No description provided.)'}

## RE-RUN INSTRUCTIONS (what the team wants to change)

${job.changeRequest || '(No specific change instructions provided — review the existing artifacts and ask the team what they want to improve.)'}
`;
  }

  return `You are the Inception Agent for the AI-DLC platform.

YOUR GOAL: Follow the AI-DLC workflow defined in the steering files (.kiro/steering/) to analyze the project, ask clarifying questions, and produce Requirements, User Stories, and Tasks — all stored in the Neptune graph database.

## CRITICAL RULES (these override everything else)

1. **USE \`ask_question\` FOR ALL HUMAN INPUT.** This is the ONLY way to communicate with the team. It sends the question via WebSocket and BLOCKS until someone answers. NEVER create question files. NEVER use \`add_node\` with label "Question" — that creates a silent graph node nobody sees.

2. **WRITE ALL ARTIFACTS TO NEPTUNE.** Use \`add_node\` for Requirements, UserStories, and Tasks. ALWAYS pass the \`edges\` parameter on \`add_node\` to create BREAKS_INTO links atomically (see Artifact Guidelines below). The frontend reads from Neptune — if you don't write there, nothing shows up.

3. **DO NOT WRITE MARKDOWN FILES AS OUTPUT.** The graph database is your only artifact output channel. Application source code (when generated) goes to the workspace filesystem.

## STEERING FILES

Read the steering files in .kiro/steering/ for detailed workflow rules:
- \`core-workflow.md\` — Master workflow with phase/stage structure
- \`common-question-format-guide.md\` — How to use \`ask_question\` (CRITICAL)
- \`common-process-overview.md\` — Workflow overview
- \`inception-*.md\` — Detailed steps for each inception stage

## QUICK START

1. Call \`get_sprint_graph\` to see what already exists.
2. Read the project description below.
3. Follow the inception workflow from core-workflow.md:
   - Workspace Detection → Reverse Engineering (if brownfield) → Requirements Analysis → User Stories → Workflow Planning → Application Design → **Units Generation (MANDATORY)**
4. At each stage, use \`ask_question\` for clarification and approval gates.
5. Store all artifacts via \`add_node\` — ALWAYS pass the \`edges\` parameter when creating UserStories and Tasks to link them to their parent.
6. **You MUST always execute Units Generation and create Task nodes for every UserStory.** Tasks are the work items the Construction phase loops over — without them, no construction work happens.
7. Use descriptive ids like \`req-auth\`, \`story-login-form\`, \`task-jwt-middleware\`.

## ARTIFACT GUIDELINES

- **Requirement**: Use \`add_node\` with \`title\`, \`description\`, \`acceptance_criteria\`, \`category\`, \`priority\`.
- **UserStory**: Use \`add_node\` with \`edges: [{ direction: "from", label: "Requirement", id: "req-xxx", edgeLabel: "BREAKS_INTO" }]\` to atomically create the story AND link it to its parent Requirement. Set \`title\`, \`description\` ("As a … I want … so that …"), optionally \`story_points\`.
- **Task**: Use \`add_node\` with \`edges: [{ direction: "from", label: "UserStory", id: "story-xxx", edgeLabel: "BREAKS_INTO" }]\` to atomically create the task AND link it to its parent UserStory. Set \`title\`, \`description\`, \`status\` ("todo").
- **Task Dependencies**: After creating all Tasks, add \`DEPENDS_ON\` edges using \`add_edge\` for any task that must wait for another to complete first. Example: if task-api-routes needs task-data-model to be done first, call \`add_edge(fromLabel: "Task", fromId: "task-api-routes", edgeLabel: "DEPENDS_ON", toLabel: "Task", toId: "task-data-model")\`. Tasks with no dependencies can run in parallel during construction.

## PROJECT DESCRIPTION

${job.description || '(No description provided — ask the team what they want to build.)'}
`;
}

function buildConstructionPrompt(job) {
  const taskId = job.taskId;
  const taskSection = taskId
    ? `## YOUR TASK\n\nTask ID: ${taskId}\nBranch: ${job.branch || 'main'}\n\nCall \`get_node\` with label "Task" and id="${taskId}" to read the task details, then implement it.`
    : `## YOUR TASKS\n\nBranch: ${job.branch || 'main'}\n\nNo specific task ID was assigned. You must discover tasks yourself:\n1. Call \`get_sprint_graph\` to see all nodes.\n2. Find all Task nodes with status "todo".\n3. Implement them one by one in a logical order (respect dependencies).`;

  return `You are the Construction Agent for the AI-DLC platform.

YOUR GOAL: Implement tasks by writing code to the git workspace, updating Neptune with progress, and committing your changes.

## CRITICAL RULES

1. **WRITE CODE TO THE FILESYSTEM.** You're working in a git repository at /workspace. Write all code files there using standard file operations.

2. **UPDATE NEPTUNE WITH PROGRESS.** Use \`update_node\` to update each Task status:
   - Start: Set status to "in_progress"
   - Complete: Set status to "done"
   - Failed: Set status to "failed"

3. **FOLLOW AI-DLC CONSTRUCTION WORKFLOW.** Read the steering files in .kiro/steering/ for detailed rules:
   - \`core-workflow.md\` — Master workflow
   - \`construction-*.md\` — Construction phase stages

4. **USE \`ask_question\` FOR CLARIFICATION.** If you need input from the team, use the \`ask_question\` tool.

5. **COMMIT YOUR CHANGES.** After implementing each task, stage and commit with a descriptive message.

${taskSection}

## WORKFLOW

1. Read the steering files in .kiro/steering/ to understand the construction workflow
2. Call \`get_sprint_graph\` to understand the project context and discover tasks
3. For each task (status "todo"):
   a. Update task status to "in_progress"
   b. Implement the task following AI-DLC construction stages
   c. Write code files to /workspace
   d. Update task status to "done" (or "failed" if issues arise)
   e. Stage and commit: \`git add . && git commit -m "Implement <task-id>: <short description>"\`

## GIT CONTRACT — READ CAREFULLY

**Your branch**: \`${job.branch || 'main'}\`

**Your responsibilities (MUST DO)**:
1. **COMMIT all changes** before you finish. Use \`git add -A && git commit -m "Implement <task-id>: <short description>"\`.
2. **Verify your commit exists** — run \`git log --oneline -3\` to confirm your work is committed.
3. If you make multiple rounds of changes, commit after each round. Never leave uncommitted work.
4. **Before exiting**: Run \`git status\` — if it shows ANY uncommitted changes, commit them immediately.

**System responsibilities (DO NOT DO THESE)**:
- **DO NOT push** — the system pushes your branch to the remote immediately after you exit.
- **DO NOT merge** — the orchestrator merges your branch into the sprint branch.
- **DO NOT create PRs** — the system creates a PR after all tasks are merged.

**WHY THIS MATTERS**: If you exit with uncommitted changes, that work is LOST. The system can only push what is committed. Commit early, commit often, and always verify before finishing.

## FINAL STEP (MANDATORY — do this last, right before you stop)

Run these commands as the very last thing you do:
\`\`\`
git add -A
git status
\`\`\`
If git status shows ANY staged or unstaged changes, commit them:
\`\`\`
git commit -m "Implement ${taskId || '<task-id>'}: final changes"
\`\`\`
Then verify:
\`\`\`
git log --oneline -3
\`\`\`
Only stop after confirming your work appears in git log. If it does not, something is wrong — do not exit.

Begin by reading the steering files, then start implementing tasks.
`;
}

function buildBlindReviewPrompt(job) {
  return `You are the Technical Review Agent for the AI-DLC platform.

## YOUR GOAL

Perform a BLIND CODE REVIEW. You have NO access to requirements, user stories, or tasks. Analyze the code on its technical merits only.

## CRITICAL RULES

1. **DO NOT read the sprint graph for requirements.** You must NOT call \`get_sprint_graph\`, \`list_nodes\`, \`find_nodes\`, or any tool revealing requirements/user stories/tasks. You are reviewing the code blind — purely on technical quality.

2. **ANALYZE ONLY THE CODE.** Look at the git diff and code files.

3. **WRITE YOUR REVIEW TO NEPTUNE** using \`update_node\` on the Review node (field: \`blind_review\`). Also set \`blind_status\` (PASSED|FAILED|PARTIAL), \`blind_risk_score\` (0-10) and \`blind_risk_reasoning\`.

4. **POST A COMPACT SUMMARY TO THE PR** using \`post_pr_comment\` once your review is saved.

5. **USE \`ask_question\` IF NEEDED** for deeply unclear context.

## WORKFLOW

1. Examine the code changes:
   - \`git log --oneline -20\`
   - \`git diff ${job.baseBranch || 'main'}...HEAD --stat\`
   - \`git diff ${job.baseBranch || 'main'}...HEAD\` (full diff)

2. Produce a **compact** technical review using this exact structure:

\`\`\`
## Technical Review

**Summary**: 1-2 sentences on what was built.

**Architecture**: Key patterns / structure decisions.

**Code Quality**: Readability, naming, error handling — 2-4 bullet points.

**Issues Found**:
- 🔴 CRITICAL: …
- 🟡 WARNING: …
- 🟢 NOTE: …

**Testing**: Coverage assessment in 1-2 sentences.

**Risk Score: X/10**
> Brief reasoning (1-2 sentences on why this score).
\`\`\`

Risk score guidance:
- 0-2: Polished, well-tested, minimal issues
- 3-4: Minor issues, low risk to ship
- 5-6: Some gaps or code smells, moderate risk
- 7-8: Significant issues, high risk
- 9-10: Critical problems, do not ship

3. Save your review:
   - \`find_nodes\` with label "Review" to get the Review node id
   - \`update_node\` with label "Review" — set \`blind_review\` to your full review text, \`blind_risk_score\` to the numeric score (as a string), \`blind_risk_reasoning\` to your risk reasoning sentence, and \`blind_status\` to PASSED, FAILED, or PARTIAL

4. Post to PR using \`post_pr_comment\` with a compact markdown comment:

\`\`\`markdown
## 🤖 AI Technical Review

> Reviewed by the AI-DLC Technical Review Agent (code-only, no requirements context)

**Summary**: <one sentence>

**Key Issues**:
<bullet list of critical/warning items only, or "None found" if clean>

**Risk Score: X/10** — <one-line reasoning>

<details>
<summary>Full review</summary>

<full review text>

</details>
\`\`\`

## GIT CONTEXT

Branch: ${job.branch || 'unknown'}
Base Branch: ${job.baseBranch || 'main'}

Begin now.
`;
}

function buildFullReviewPrompt(job) {
  return `You are the Business Review Agent for the AI-DLC platform.

## YOUR GOAL

Perform a BUSINESS CODE REVIEW cross-referencing the implementation against requirements, user stories, and tasks. Verify the implementation fulfills the spec.

## CRITICAL RULES

1. **READ THE FULL SPRINT GRAPH.** Call \`get_sprint_graph\` to understand all requirements, user stories, tasks.

2. **EXAMINE THE CODE.** Look at git diff and code files.

3. **WRITE YOUR REVIEW TO NEPTUNE** using \`update_node\` on the Review node (field: \`full_review\`). Also set \`full_status\` (PASSED|FAILED|PARTIAL), \`full_risk_score\` (0-10) and \`full_risk_reasoning\`.

4. **POST A COMPACT SUMMARY TO THE PR** using \`post_pr_comment\`.

5. **USE \`ask_question\` IF NEEDED** for team clarification.

## WORKFLOW

1. Read the sprint graph: \`get_sprint_graph\`

2. Examine the code:
   - \`git log --oneline -20\`
   - \`git diff ${job.baseBranch || 'main'}...HEAD --stat\`
   - \`git diff ${job.baseBranch || 'main'}...HEAD\`

3. Cross-reference and produce a **compact** review using this exact structure:

\`\`\`
## Business Review

**Verdict**: PASS | FAIL | PARTIAL

**Requirements Coverage**:
| Requirement | Status | Notes |
|---|---|---|
| <req title> | ✅ Met / ⚠️ Partial / ❌ Missing | <brief note> |

**Key Issues**:
- 🔴 CRITICAL: …
- 🟡 WARNING: …
- 🟢 NOTE: …

**Code Quality**: 1-3 sentences.

**Risk Score: X/10**
> Brief reasoning (1-2 sentences).
\`\`\`

Risk score guidance:
- 0-2: All requirements met, well-tested, production-ready
- 3-4: Minor gaps, low risk
- 5-6: Some requirements unmet or moderate code issues
- 7-8: Significant gaps, not production-ready without fixes
- 9-10: Critical failures, blocking issues

4. Save your review:
   - \`find_nodes\` with label "Review" to get the Review node id
   - \`update_node\` — set \`full_review\`, \`full_status\` (PASSED|FAILED|PARTIAL), \`full_risk_score\`, \`full_risk_reasoning\`
   - Create VALIDATES edges from the Review to each verified Requirement/UserStory

5. Post to PR using \`post_pr_comment\`:

\`\`\`markdown
## 🔍 AI Business Review

> Reviewed by the AI-DLC Business Review Agent (with requirements context)

**Verdict**: PASS | FAIL | PARTIAL

**Requirements Coverage**:
<requirements table>

**Key Issues**:
<bullet list of critical/warning items only, or "None found">

**Risk Score: X/10** — <one-line reasoning>

<details>
<summary>Full review</summary>

<full review text>

</details>
\`\`\`

## GIT CONTEXT

Branch: ${job.branch || 'unknown'}
Base Branch: ${job.baseBranch || 'main'}

Begin now. Be thorough — this is the quality gate before code ships.
`;
}

function buildReviewModifyPrompt(job) {
  const instruction = job.description || '';
  return `You are the Review Modify Agent for the AI-DLC platform.

## YOUR GOAL

Read the PR comments (technical review findings, business review findings, and human feedback), categorize them, fix what's clear, and ask about what's ambiguous.

## CRITICAL RULES

1. **NEVER GUESS on ambiguous feedback.** Use \`ask_question\` to get clarification.
2. **MAKE ONLY THE REQUESTED CHANGES.** Do not refactor unrelated code or add features not requested.
3. **GROUP FIXES into logical commits** — not one giant commit.
4. **DO NOT PUSH.** The system will handle pushing after you exit.
${instruction ? `\n## ADDITIONAL CONTEXT FROM USER\n\n${instruction}\n` : ''}

## GIT CONTEXT

Branch: ${job.branch || 'unknown'}
Base Branch: ${job.baseBranch || 'main'}

## WORKFLOW

1. Read the sprint graph to understand context: \`get_sprint_graph\`
2. Read all PR comments: \`get_pr_comments\`
3. Categorize each comment/finding:
   - **Clear & actionable** (e.g. "missing null check on line 42") → fix it
   - **Ambiguous or conflicting** (e.g. "should this be a separate service?") → \`ask_question\` before acting
   - **Trivial / cosmetic** → fix if easy, skip if not
4. Make fixes, commit each logical group: \`git add . && git commit -m "Review fix: <description>"\`
5. Post a summary comment on the PR using \`post_pr_comment\` with this structure:

\`\`\`markdown
## 🔧 Review Modify Summary

**Fixed:**
- <what was fixed, referencing the original comment/author>

**Questions Asked:**
- <what was unclear, what you asked about>

**Skipped:**
- <what was intentionally skipped and why>
\`\`\`

Begin by reading the PR comments now.
`;
}

function buildBugfixPrompt(job) {
  const instruction = job.description || '';
  return `You are a Bug Fix Agent working on an existing codebase.

## YOUR GOAL

You have been invoked to fix bugs or make targeted changes on a branch. This is a general-purpose agent invocation — you are NOT part of the AI-DLC inception/construction/review lifecycle. Focus exclusively on the instructions provided below.

## INSTRUCTIONS

${instruction || '(No instructions provided — examine the codebase and look for obvious issues.)'}

## CRITICAL RULES

1. **FOCUS ON THE INSTRUCTIONS.** Only make changes that are relevant to the bug fix or task described above. Do not refactor unrelated code.

2. **COMMIT YOUR CHANGES.** After making changes, stage and commit with a descriptive message.

3. **DO NOT PUSH.** The system will handle pushing after you exit.

4. **USE \`ask_question\` IF NEEDED.** If something is unclear, ask the team via the \`ask_question\` tool.

## GIT CONTEXT

Branch: ${job.branch || 'unknown'}
Base Branch: ${job.baseBranch || 'main'}

## WORKFLOW

1. Understand the current code state by reading relevant files
2. Identify the bug(s) or issue(s) described in the instructions
3. Implement the fix(es)
4. Test if possible (run existing tests, check for syntax errors)
5. Stage and commit: \`git add -A && git commit -m "Fix: <short description>"\`

## FINAL STEP (MANDATORY — do this last, right before you stop)

Run these commands as the very last thing you do:
\`\`\`
git add -A
git status
\`\`\`
If git status shows ANY staged or unstaged changes, commit them:
\`\`\`
git commit -m "Fix: final changes"
\`\`\`
Then verify:
\`\`\`
git log --oneline -3
\`\`\`
Only stop after confirming your work appears in git log. If it does not, something is wrong — do not exit.

Begin by examining the codebase and implementing the requested fixes.
`;
}

// Push a branch to remote with retry and verification.
// Returns true if push succeeded and was verified on remote, false otherwise.
function pushBranchWithRetry(job, branch, maxRetries = 3) {
  // Re-inject token into remote URL for push authentication.
  const auth = job.gitToken ? `x-access-token:${job.gitToken}@` : '';
  if (auth) {
    try {
      execSync(
        `cd /workspace && git remote set-url origin "https://${auth}github.com/${job.gitRepo}.git"`,
        { stdio: 'inherit' },
      );
    } catch (urlErr) {
      console.error(`[pool-worker] Failed to set remote URL: ${urlErr.message}`);
      return false;
    }
  }

  // Check if the branch has any commits at all
  try {
    execSync('cd /workspace && git log -1 --format=%H', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    console.log(
      `[pool-worker] Branch ${branch} has no commits — nothing to push. This is normal for orchestrator first-run.`,
    );
    return false;
  }

  // Auto-commit any leftover uncommitted changes the agent forgot
  try {
    const status = execSync('cd /workspace && git status --porcelain', { encoding: 'utf8' }).trim();
    if (status) {
      console.log(
        `[pool-worker] WARNING: Agent left uncommitted changes. Auto-committing to prevent data loss:\n${status}`,
      );
      execSync(
        'cd /workspace && git add -A && git commit -m "auto-commit: uncommitted changes from agent"',
        { stdio: 'inherit' },
      );
    }
  } catch (commitErr) {
    console.error(`[pool-worker] Auto-commit failed: ${commitErr.message}`);
  }

  const log = execSync('cd /workspace && git log --oneline -3', { encoding: 'utf8' }).trim();
  console.log(`[pool-worker] Recent commits on ${branch}:\n${log}`);

  const localHead = execSync('cd /workspace && git rev-parse HEAD', { encoding: 'utf8' }).trim();
  console.log(`[pool-worker] Local HEAD for ${branch}: ${localHead}`);

  // Log actual current branch for debugging — if this differs from the expected branch,
  // the agent or setupWorkspace failed to check out the correct branch.
  const currentBranch = execSync(
    'cd /workspace && git branch --show-current 2>/dev/null || echo "detached"',
    { encoding: 'utf8' },
  ).trim();
  console.log(`[pool-worker] Current local branch: ${currentBranch} (expected: ${branch})`);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Push HEAD to the remote branch name explicitly. This works even if the local branch
      // name doesn't match (e.g. agent is on 'main' but we need to push to the task branch).
      execSync(`cd /workspace && git push origin HEAD:refs/heads/${branch}`, { stdio: 'inherit' });
      console.log(`[pool-worker] Push succeeded for ${branch} (attempt ${attempt})`);

      // Verify the push landed by checking remote HEAD matches local HEAD
      try {
        const remoteHead = execSync(`cd /workspace && git ls-remote origin ${branch}`, {
          encoding: 'utf8',
        })
          .trim()
          .split(/\s/)[0];
        if (remoteHead === localHead) {
          console.log(`[pool-worker] Push verified: remote HEAD matches local HEAD (${localHead})`);
          return true;
        } else {
          console.error(
            `[pool-worker] Push verification mismatch: local=${localHead} remote=${remoteHead}`,
          );
          // Push went through but heads differ — could be a race. Still count as success
          // since our commits are on the remote (remote may have advanced further).
          return true;
        }
      } catch (verifyErr) {
        console.error(
          `[pool-worker] Push verification failed: ${verifyErr.message}. Trusting push exit code.`,
        );
        return true;
      }
    } catch (pushErr) {
      console.error(
        `[pool-worker] Push attempt ${attempt}/${maxRetries} failed for ${branch}: ${pushErr.message}`,
      );
      if (attempt < maxRetries) {
        const backoffMs = attempt * 2000;
        console.log(`[pool-worker] Retrying push in ${backoffMs}ms...`);
        execSync(`sleep ${backoffMs / 1000}`);
      }
    }
  }

  console.error(
    `[pool-worker] CRITICAL: Push failed after ${maxRetries} attempts for ${branch}. Work may be lost.`,
  );
  return false;
}

// Run the ACP client for a single job
// Returns { exitCode, pushSucceeded } — pushSucceeded is only relevant for construction phases
function runAcpSession(job) {
  return new Promise((resolve) => {
    const phase = (job.agentType || 'inception').toLowerCase();
    const prompt = buildPrompt(job);

    const childEnv = {
      ...process.env,
      AGENT_CLI: job.agentCli,
      EXECUTION_ID: job.executionId,
      PROJECT_ID: job.projectId,
      SPRINT_ID: job.sprintId || '',
      AGENT_TYPE: phase,
      AGENT_PROMPT: prompt,
      TASK_ID: job.taskId || '',
      BRANCH: job.branch || '',
      GIT_TOKEN: job.gitToken || '',
      GIT_REPO: job.gitRepo || '',
      RUN_NUMBER: String(job.runNumber || 1),
    };

    const child = spawn('node', ['/opt/acp-client/acp-client.js'], {
      cwd: '/workspace',
      env: childEnv,
      stdio: 'inherit',
    });

    child.on('exit', (code) => {
      let pushSucceeded = false;

      // For construction and review-modify phases, push changes to remote.
      // CRITICAL: Wrapped in try/catch so no git error can crash the pool-worker process.
      // An uncaught exception here would kill the ECS task, wasting the worker permanently.
      if (
        (phase === 'construction' ||
          phase === 'construction-orchestrator' ||
          phase === 'review-modify' ||
          phase === 'bugfix') &&
        code === 0 &&
        job.gitRepo &&
        job.branch
      ) {
        try {
          pushSucceeded = pushBranchWithRetry(job, job.branch);
        } catch (pushErr) {
          console.error(
            `[pool-worker] FATAL-PREVENTED: pushBranchWithRetry threw unexpectedly: ${pushErr.message}`,
          );
          console.error(pushErr.stack);
          pushSucceeded = false;
        }

        if (phase === 'construction-orchestrator' && pushSucceeded) {
          try {
            cleanupMergedTaskBranch(job);
          } catch (cleanupErr) {
            console.error(
              `[pool-worker] FATAL-PREVENTED: cleanupMergedTaskBranch threw unexpectedly: ${cleanupErr.message}`,
            );
            console.error(cleanupErr.stack);
          }
        }
      }

      resolve({ exitCode: code || 0, pushSucceeded });
    });
    child.on('error', (err) => {
      console.error('ACP child error:', err);
      resolve({ exitCode: 1, pushSucceeded: false });
    });
  });
}

async function main() {
  // Discover which CLI binaries are actually installed in this image.
  // No environment variable or deploy-time configuration needed — the image
  // is the source of truth for what's available.
  const installedClis = discoverInstalledDrivers();
  console.log(`[pool-worker] Installed CLIs: [${installedClis.join(', ')}]`);

  // Attempt authentication for every installed CLI.
  // CLIs that succeed are added to _availableClis and advertised to the pool.
  // Failures are captured in _cliAuthErrors so the dispatch Lambda and Admin
  // UI can show the user why a particular CLI isn't available.
  for (const cli of installedClis) {
    try {
      await getDriver(cli).authenticate(process.env);
      _availableClis.push(cli);
      console.log(`[pool-worker] CLI "${cli}" authenticated and available`);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      _cliAuthErrors[cli] = msg;
      console.warn(`[pool-worker] CLI "${cli}" not available: ${msg}`);
    }
  }

  if (_availableClis.length === 0) {
    console.error('[pool-worker] No CLIs authenticated — exiting');
    process.exit(1);
  }

  console.log(
    `[pool-worker] Worker ${env.workerId} ready. Available CLIs: [${_availableClis.join(', ')}]`,
  );

  // If the dispatcher pre-assigned a job to this worker (cold-start path where
  // findIdleWorkers returned 0), the DDB row already has status='assigned' and
  // a baked-in job. Honour that instead of overwriting it with setIdle, which
  // would erase the job and leave the dispatcher with no worker for it.
  const existing = await ddb.send(
    new GetCommand({
      TableName: env.poolTable,
      Key: { workerId: env.workerId },
    }),
  );
  if (existing.Item?.status === 'assigned' && existing.Item.job) {
    console.log(
      `[pool-worker] Found pre-assigned job on startup: ${existing.Item.job.executionId} — advertising clis without clearing job`,
    );
    // Advertise availableClis/version but preserve assigned status + job.
    await ddb.send(
      new UpdateCommand({
        TableName: env.poolTable,
        Key: { workerId: env.workerId },
        UpdateExpression:
          'SET lastHeartbeat = :t, version = :v, availableClis = :clis, cliAuthErrors = :errs',
        ExpressionAttributeValues: {
          ':t': Date.now(),
          ':v': env.version,
          ':clis': _availableClis,
          ':errs': _cliAuthErrors,
        },
      }),
    );
  } else {
    // Register as idle — advertises availableClis to the job dispatcher.
    await setIdle();
  }

  // Heartbeat loop
  setInterval(async () => {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: env.poolTable,
          Key: { workerId: env.workerId },
          UpdateExpression: 'SET lastHeartbeat = :t',
          ExpressionAttributeValues: { ':t': Date.now() },
        }),
      );
    } catch {}
  }, HEARTBEAT_INTERVAL);

  // Main poll loop
  while (true) {
    try {
      const poll = await pollForJob();

      if (poll.action === 'exit') {
        console.log('[pool-worker] Drained or removed, exiting');
        await cleanup();
        break;
      }

      if (poll.action === 'job') {
        const job = poll.job;
        const jobCli = job.agentCli;
        console.log(
          `[pool-worker] Got job: ${job.executionId} for project ${job.projectId} (cli=${jobCli})`,
        );

        setupWorkspace(job);
        const { exitCode, pushSucceeded } = await runAcpSession(job);

        const status = exitCode === 0 ? 'completed' : 'failed';
        await saveStatus(job.executionId, job.agentType || 'inception', job.projectId, status);
        await updateAgentRunStatus(job, status).catch(() => {});
        console.log(`[pool-worker] Job done (exit=${exitCode}, pushSucceeded=${pushSucceeded})`);

        // Re-trigger orchestrator when a construction sub-agent finishes.
        // ALWAYS trigger — even if push failed. The orchestrator needs to know this task
        // finished so it can either merge the branch (push succeeded) or recover the task
        // (push failed). Without this, the entire pipeline hangs waiting for a re-trigger
        // that never comes.
        if (
          (job.agentType || '').toLowerCase() === 'construction' &&
          job.taskId &&
          process.env.AGENTS_LAMBDA_NAME
        ) {
          const triggerStatus = pushSucceeded ? status : 'push_failed';
          console.log(
            `[pool-worker] Construction task ${job.taskId} finished (pushSucceeded=${pushSucceeded}), triggering orchestrator with status=${triggerStatus}`,
          );
          try {
            // Extract sprint branch from task branch (e.g. "ai-dlc/sprint-1--task-auth" -> "ai-dlc/sprint-1")
            const sprintBranch = (job.branch || '').replace(/--task-[^/]+$/, '');
            await lambda.send(
              new InvokeCommand({
                FunctionName: process.env.AGENTS_LAMBDA_NAME,
                InvocationType: 'Event', // async — don't wait
                Payload: Buffer.from(
                  JSON.stringify({
                    httpMethod: 'POST',
                    path: `/projects/${job.projectId}/agents`,
                    pathParameters: { projectId: job.projectId },
                    body: JSON.stringify({
                      phase: 'construction-orchestrator',
                      sprintId: job.sprintId,
                      branch: sprintBranch,
                      baseBranch: job.baseBranch || 'main',
                      gitToken: job.gitToken || '',
                      event: {
                        event: 'task_completed',
                        taskId: job.taskId,
                        status: triggerStatus,
                        pushSucceeded,
                      },
                    }),
                    requestContext: { authorizer: { claims: { sub: 'system' } } },
                  }),
                ),
              }),
            );
          } catch (err) {
            console.error('[pool-worker] Failed to trigger orchestrator:', err.message);
          }
        }

        // Check if we were drained while busy — if so, exit instead of going idle
        const check = await ddb.send(
          new GetCommand({ TableName: env.poolTable, Key: { workerId: env.workerId } }),
        );
        if (!check.Item || check.Item.status === 'draining') {
          console.log('[pool-worker] Drained while busy, exiting');
          await cleanup();
          break;
        }

        await setIdle();
      }
    } catch (err) {
      console.error('[pool-worker] Poll error:', err.message);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }

  process.exit(0);
}

async function cleanup() {
  try {
    await ddb.send(
      new DeleteCommand({ TableName: env.poolTable, Key: { workerId: env.workerId } }),
    );
  } catch {}
}

main().catch((err) => {
  console.error('[pool-worker] Fatal:', err);
  process.exit(1);
});
