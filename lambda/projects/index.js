import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import nodePath from 'node:path';
import { randomUUID } from 'node:crypto';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { getUrlAndHeaders } from 'gremlin-aws-sigv4/lib/utils.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SSMClient } from '@aws-sdk/client-ssm';
import { buildResponse } from '../shared/response.js';
import { runTrackerMigration } from '../shared/tracker-migration.js';
import { getGitConnection } from '../shared/git-connection-store.js';
import { resolveGitToken } from '../shared/git-token.js';
import { getProvider } from '../shared/git-providers.js';
import {
  getVal,
  projectTrackersFoldStep,
  mapBinding,
  fetchMembershipRole,
} from '../shared/trackers.js';
import { validateMcpServersJson } from '../shared/mcp-validator.js';
import { normalizeCliModels, parseCliModels } from '../shared/cli-models.js';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});

const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const __ = gremlin.process.statics;
const { cardinality, P } = gremlin.process;

// Synthetic-binding id for legacy projects (issue_integration_enabled='true'
// but no HAS_TRACKER edge). Lets the frontend render the GitHub-issues panel
// against the project's gitRepo without requiring the user to migrate first.
// The trackers lambda special-cases this id on the issue routes.
export const LEGACY_GITHUB_BINDING_ID = 'legacy-github';

// Project kind discriminator. Every existing project predates this field and is
// implicitly v1 (no migration). v2 projects run the AI-DLC v2 block/workflow
// runtime (intents, dynamic phases/stages) and carry the extra settings below.
const DEFAULT_V2_WORKFLOW_ID = 'aidlc-v2';
// Seconds a parked (waiting-for-human) stage's compute lingers before release.
// Default 5 min; bounded by the runtime idle backstop (900s) — see v2-open.md D1.
const DEFAULT_PARK_RELEASE_SECONDS = 300;
const MAX_PARK_RELEASE_SECONDS = 900;
// Concurrency cap for parallel unit lanes (docs/v2-parallel.md WP5).
// 0 = unbounded (the unit DAG is the only limit). Bounded well below the
// AgentCore session quotas (2.5k+ active sessions) — a workflow fan-out past
// this is a smell, not a need.
const DEFAULT_MAX_PARALLEL_UNITS = 0;
const MAX_MAX_PARALLEL_UNITS = 64;
// PR strategy at fan-in (docs/v2-parallel.md WP6). Staged rollout: intent-pr
// ships first; pr-per-unit / stacked are DEFINED (the UI shows them disabled)
// but rejected here until WP8's merge fixtures unlock WP6b.
const PR_STRATEGIES = ['intent-pr', 'pr-per-unit', 'stacked'];
const ENABLED_PR_STRATEGIES = ['intent-pr'];
const DEFAULT_PR_STRATEGY = 'intent-pr';

// Validate + normalize park_release_seconds. Returns { valid, value?, error? }.
const normalizeParkReleaseSeconds = (raw) => {
  if (raw === undefined || raw === null || raw === '') {
    return { valid: true, value: DEFAULT_PARK_RELEASE_SECONDS };
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > MAX_PARK_RELEASE_SECONDS) {
    return {
      valid: false,
      error: `parkReleaseSeconds must be an integer between 0 and ${MAX_PARK_RELEASE_SECONDS}`,
    };
  }
  return { valid: true, value: n };
};

// Validate + normalize max_parallel_units. Returns { valid, value?, error? }.
const normalizeMaxParallelUnits = (raw) => {
  if (raw === undefined || raw === null || raw === '') {
    return { valid: true, value: DEFAULT_MAX_PARALLEL_UNITS };
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > MAX_MAX_PARALLEL_UNITS) {
    return {
      valid: false,
      error: `maxParallelUnits must be an integer between 0 (unbounded) and ${MAX_MAX_PARALLEL_UNITS}`,
    };
  }
  return { valid: true, value: n };
};

// Validate + normalize pr_strategy. Returns { valid, value?, error? }.
// A KNOWN-but-disabled strategy gets a distinct error so the UI can explain
// "coming with WP6b" instead of "unknown value".
const normalizePrStrategy = (raw) => {
  if (raw === undefined || raw === null || raw === '') {
    return { valid: true, value: DEFAULT_PR_STRATEGY };
  }
  if (!PR_STRATEGIES.includes(raw)) {
    return { valid: false, error: `prStrategy must be one of: ${PR_STRATEGIES.join(', ')}` };
  }
  if (!ENABLED_PR_STRATEGIES.includes(raw)) {
    return {
      valid: false,
      error: `prStrategy "${raw}" is not enabled yet (currently available: ${ENABLED_PR_STRATEGIES.join(', ')})`,
    };
  }
  return { valid: true, value: raw };
};

// Assemble the v2 settings block returned on a project DTO. Reads are
// defaulted so a v1 project (no v2 properties) still produces a coherent shape
// without these fields surfacing.
const readV2Settings = (v) => {
  const kind = getVal(v, 'kind') || 'v1';
  if (kind !== 'v2') return { kind };
  const rawVersion = getVal(v, 'workflow_version');
  return {
    kind,
    workflowId: getVal(v, 'workflow_id') || DEFAULT_V2_WORKFLOW_ID,
    workflowVersion: rawVersion ? Number(rawVersion) : null,
    parkReleaseSeconds: Number(getVal(v, 'park_release_seconds') || DEFAULT_PARK_RELEASE_SECONDS),
    // `|| default` would coerce a stored "0" back to the default — 0 is a
    // meaningful value here (unbounded), so read it explicitly.
    maxParallelUnits:
      getVal(v, 'max_parallel_units') === undefined || getVal(v, 'max_parallel_units') === ''
        ? DEFAULT_MAX_PARALLEL_UNITS
        : Number(getVal(v, 'max_parallel_units')),
    prStrategy: getVal(v, 'pr_strategy') || DEFAULT_PR_STRATEGY,
  };
};

const buildLegacyBinding = (project) => ({
  id: LEGACY_GITHUB_BINDING_ID,
  provider: 'github-issues',
  instance: 'public',
  externalProjectKey: project.gitRepo,
  displayName: project.gitRepo,
  createdAt: project.createdAt,
  createdBy: null,
});

// Append a synthetic legacy binding when the project still uses the
// issueIntegrationEnabled boolean and has no real bindings yet. Mutates +
// returns the same project object for terse call sites.
const withLegacyTracker = (project) => {
  if (
    project.issueIntegrationEnabled &&
    project.trackers.length === 0 &&
    project.gitProvider === 'github' &&
    project.gitRepo
  ) {
    project.trackers.push(buildLegacyBinding(project));
  }
  return project;
};

const getConnection = async () => {
  const host = process.env.NEPTUNE_ENDPOINT;
  const port = process.env.GREMLIN_PORT ?? '8182';
  const protocol = process.env.GREMLIN_PROTOCOL ?? 'wss';

  const credentials = await fromNodeProviderChain()();
  credentials.region = process.env.AWS_REGION ?? 'us-east-1';
  const { url, headers } = getUrlAndHeaders(host, port, credentials, '/gremlin', protocol);
  return new DriverRemoteConnection(url, { headers });
};

// ---------------------------------------------------------------------------
// Repo helpers
// ---------------------------------------------------------------------------

// Fetch all Repository vertices linked to a project via HAS_REPO edges.
const fetchRepos = async (g, projectId) => {
  // Project + coalesce so defaults are applied in-query (no getVal/valueMap
  // array-unwrapping). The driver still returns Map per row, so we marshal once.
  const rows = await g
    .V()
    .has('Project', 'id', projectId)
    .out('HAS_REPO')
    .hasLabel('Repository')
    // Stable ordering by add time so promotion-after-delete and any
    // "first repo" fallback are deterministic across calls.
    .order()
    .by(__.coalesce(__.values('added_at'), __.constant('')))
    .project('url', 'provider', 'role', 'detectedStack', 'addedAt')
    .by('url')
    .by(__.coalesce(__.values('provider'), __.constant('github')))
    .by(__.coalesce(__.values('role'), __.constant('unknown')))
    .by(__.coalesce(__.values('detected_stack'), __.constant('')))
    .by(__.coalesce(__.values('added_at'), __.constant('')))
    .toList();
  return rows.map((r) => ({
    url: r.get('url'),
    provider: r.get('provider'),
    role: r.get('role'),
    detectedStack: r.get('detectedStack'),
    addedAt: r.get('addedAt'),
  }));
};

// Backward-compat: derive the legacy `gitRepo` field from the repos list.
const derivePrimaryRepo = (repos, legacyGitRepo) => {
  if (repos.length === 0) return legacyGitRepo || '';
  const primary = repos.find((r) => r.role === 'primary') || repos[0];
  return primary.url;
};

// Reconcile repo role labels so exactly one repo carries `primary`. The
// matching repo is promoted; any stale `primary` is demoted to `secondary`;
// other roles are left untouched. Callers that already hold the repo list can
// pass it in to avoid a redundant fetch.
const syncPrimaryRepo = async (g, projectId, primaryUrl, preloadedRepos) => {
  const repos = preloadedRepos ?? (await fetchRepos(g, projectId));

  // Guard: if primaryUrl matches no repo, don't blindly demote the existing
  // primary (that would leave the project with zero primaries).
  if (!repos.some((repo) => repo.url === primaryUrl)) return;

  for (const repo of repos) {
    const nextRole =
      repo.url === primaryUrl ? 'primary' : repo.role === 'primary' ? 'secondary' : repo.role;
    if (nextRole === repo.role) continue;

    await g
      .V()
      .has('Project', 'id', projectId)
      .out('HAS_REPO')
      .has('Repository', 'url', repo.url)
      .property(cardinality.single, 'role', nextRole)
      .next();
  }
};

// Validates owner/repo format. GitHub allows alphanumeric, hyphens,
// underscores, and dots; max 39 chars for owner and 100 for repo.
// Used for the multi-repo `repos[]` API — these are real clone targets.
const REPO_URL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;

// The legacy `gitRepo` field is historically a freeform string (bare names,
// SSH URLs). We can't tighten it to owner/repo without breaking that contract,
// but it still gets interpolated into `git clone "https://.../${url}.git"` in
// the pool-worker. The shell/traversal-safe guard lives in shared/ so it can't
// drift from the agents lambda's read-path copy (esbuild bundles ../shared).
const { isSafeRepo } = require('../shared/repo-validation');

// Canonical repository role + provider vocabularies. Keep in sync with
// `RepoRole` and `ProjectRepo.provider` in frontend/src/services/projects.ts.
const ALLOWED_REPO_ROLES = new Set([
  'primary',
  'secondary',
  'frontend',
  'backend',
  'api',
  'infra',
  'shared',
  'docs',
  'unknown',
]);
const ALLOWED_PROVIDERS = new Set(['github', 'gitlab']);

// Validate a single repo input's role/provider against the canonical
// vocabularies. Returns an error string when invalid, or null when valid.
// Shared by POST /projects/:id/repos and POST /projects so the two paths can't
// drift. `url` validation differs per caller, so it's intentionally excluded.
const validateRepoRoleAndProvider = ({ role, provider }) => {
  if (role && !ALLOWED_REPO_ROLES.has(role)) {
    return `Invalid role "${role}". Allowed: ${[...ALLOWED_REPO_ROLES].join(', ')}`;
  }
  if (provider && !ALLOWED_PROVIDERS.has(provider)) {
    return `Invalid provider "${provider}". Allowed: ${[...ALLOWED_PROVIDERS].join(', ')}`;
  }
  return null;
};

// Auto-detect role from repo URL patterns (lightweight heuristic).
const guessRole = (url) => {
  const lower = (url || '').toLowerCase();
  if (/front|ui|web|app|client|dashboard/.test(lower)) return 'frontend';
  if (/back|api|server|service|lambda/.test(lower)) return 'backend';
  if (/infra|terraform|cdk|deploy|devops|platform/.test(lower)) return 'infra';
  if (/shared|common|lib|util|pkg/.test(lower)) return 'shared';
  if (/doc|wiki|guide/.test(lower)) return 'docs';
  return 'unknown';
};

// Ensure a HAS_REPO edge + Repository vertex exists for a legacy git_repo value.
// Called lazily on read — idempotent.
const ensureLegacyRepoMigrated = async (g, projectId, legacyGitRepo) => {
  if (!legacyGitRepo) return;
  // Defense-in-depth: this is the final gate before a value becomes a cloneable
  // Repository vertex (and flows into the pool-worker's git clone execSync).
  // Legacy git_repo is freeform, so we only enforce shell-safety here (not strict
  // owner/repo). Skip (don't throw) on a dangerous value — this runs on read paths
  // and must not break GETs of old projects.
  if (!isSafeRepo(legacyGitRepo)) {
    console.error(
      `[projects] Skipping migration of unsafe git_repo value for ${projectId}: ${JSON.stringify(legacyGitRepo)}`,
    );
    return;
  }
  const exists = await g
    .V()
    .has('Project', 'id', projectId)
    .out('HAS_REPO')
    .has('Repository', 'url', legacyGitRepo)
    .hasNext();
  if (exists) return;

  const repoId = `repo-${randomUUID()}`;
  await g
    .addV('Repository')
    .property('id', repoId)
    .property('url', legacyGitRepo)
    .property('provider', 'github')
    .property('role', 'primary')
    .property('detected_stack', '')
    .property('added_at', new Date().toISOString())
    .as('r')
    .V()
    .has('Project', 'id', projectId)
    .addE('HAS_REPO')
    .to('r')
    .next();
};

// ---------------------------------------------------------------------------
// Quick detection — lightweight tech stack detection via GitHub API
// ---------------------------------------------------------------------------

const CONFIG_SIGNATURES = {
  'package.json': { lang: 'JavaScript', parse: detectNodeStack },
  'tsconfig.json': { lang: 'TypeScript', parse: null },
  'go.mod': { lang: 'Go', parse: detectGoStack },
  'Cargo.toml': { lang: 'Rust', parse: null },
  'pyproject.toml': { lang: 'Python', parse: detectPythonStack },
  'requirements.txt': { lang: 'Python', parse: null },
  'pom.xml': { lang: 'Java', parse: null },
  'build.gradle': { lang: 'Java', parse: null },
  'build.gradle.kts': { lang: 'Kotlin', parse: null },
  Gemfile: { lang: 'Ruby', parse: null },
  'mix.exs': { lang: 'Elixir', parse: null },
  'composer.json': { lang: 'PHP', parse: null },
  Dockerfile: { lang: null, parse: null },
  'docker-compose.yml': { lang: null, parse: null },
  terraform: { lang: null, parse: null, type: 'dir', framework: 'Terraform' },
  'cdk.json': { lang: null, parse: null, framework: 'AWS CDK' },
  'serverless.yml': { lang: null, parse: null, framework: 'Serverless Framework' },
  'sam.json': { lang: null, parse: null, framework: 'AWS SAM' },
  'template.yaml': { lang: null, parse: null, framework: 'AWS SAM' },
};

function detectNodeStack(content) {
  try {
    const pkg = JSON.parse(content);
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const frameworks = [];
    if (allDeps['next']) frameworks.push('Next.js');
    if (allDeps['react']) frameworks.push('React');
    if (allDeps['vue']) frameworks.push('Vue');
    if (allDeps['svelte']) frameworks.push('Svelte');
    if (allDeps['@angular/core']) frameworks.push('Angular');
    if (allDeps['express']) frameworks.push('Express');
    if (allDeps['fastify']) frameworks.push('Fastify');
    if (allDeps['hono']) frameworks.push('Hono');
    if (allDeps['nestjs'] || allDeps['@nestjs/core']) frameworks.push('NestJS');
    if (allDeps['aws-cdk-lib']) frameworks.push('AWS CDK');
    const hasTS = !!allDeps['typescript'];
    return { frameworks, hasTS };
  } catch {
    return { frameworks: [], hasTS: false };
  }
}

function detectGoStack(content) {
  const frameworks = [];
  if (/github\.com\/gin-gonic\/gin/.test(content)) frameworks.push('Gin');
  if (/github\.com\/gofiber\/fiber/.test(content)) frameworks.push('Fiber');
  if (/github\.com\/labstack\/echo/.test(content)) frameworks.push('Echo');
  if (/github\.com\/gorilla\/mux/.test(content)) frameworks.push('Gorilla');
  return { frameworks };
}

function detectPythonStack(content) {
  const frameworks = [];
  if (/fastapi/i.test(content)) frameworks.push('FastAPI');
  if (/django/i.test(content)) frameworks.push('Django');
  if (/flask/i.test(content)) frameworks.push('Flask');
  if (/streamlit/i.test(content)) frameworks.push('Streamlit');
  if (/aws-cdk/i.test(content)) frameworks.push('AWS CDK');
  return { frameworks };
}

function detectRoleFromContents(fileNames, dirNames, frameworks) {
  const fwSet = new Set(frameworks.map((f) => f.toLowerCase()));
  if (
    fwSet.has('next.js') ||
    fwSet.has('react') ||
    fwSet.has('vue') ||
    fwSet.has('svelte') ||
    fwSet.has('angular')
  )
    return 'frontend';
  if (
    fwSet.has('terraform') ||
    fwSet.has('aws cdk') ||
    fwSet.has('aws sam') ||
    fwSet.has('serverless framework')
  )
    return 'infra';
  if (
    fwSet.has('express') ||
    fwSet.has('fastify') ||
    fwSet.has('nestjs') ||
    fwSet.has('fastapi') ||
    fwSet.has('django') ||
    fwSet.has('flask') ||
    fwSet.has('gin')
  )
    return 'backend';
  if (dirNames.has('src') && fileNames.has('index.html')) return 'frontend';
  if (fileNames.has('Dockerfile') && (fileNames.has('go.mod') || fileNames.has('pom.xml')))
    return 'backend';
  return null;
}

// Resolve a user's git access token for a given provider, for the optional
// repo stack-detection below. Reads the connection row via the shared store
// (composite key, with legacy migrate-on-read) and the token from SSM. Returns
// null when the user has no connection for that provider — detection is
// best-effort, so callers treat null as "skip detection".
const getUserGitToken = async (userId, provider) => {
  if (!userId || !provider) return null;
  try {
    const item = await getGitConnection(ddb, userId, provider);
    if (!item?.parameterName) return null;
    return await resolveGitToken(ssm, item);
  } catch {
    return null;
  }
};

// Top-level file/dir names from a recursive blob tree. The provider abstraction
// returns a flat list of blob paths (recursive); the signature scan only cares
// about the repo root, so derive root files and root directories from paths.
const rootEntriesFromTree = (tree) => {
  const fileNames = new Set();
  const dirNames = new Set();
  for (const entry of tree) {
    const segments = (entry.path || '').split('/');
    if (segments.length === 1) {
      if (segments[0]) fileNames.add(segments[0]);
    } else if (segments.length > 1) {
      if (segments[0]) dirNames.add(segments[0]);
    }
  }
  return { fileNames, dirNames };
};

// Provider-agnostic repo stack detection. Works for any git provider in the
// shared abstraction (github, gitlab) — reads the repo tree + select config
// files through the provider, so a GitLab repo is detected the same as GitHub.
// All failures are non-fatal; the caller falls back to guessRole.
async function detectRepoStack(repoUrl, token, providerId = 'github') {
  if (!repoUrl || !token) {
    return { languages: [], frameworks: [], role: guessRole(repoUrl), summary: '' };
  }

  let provider;
  try {
    provider = getProvider(providerId);
  } catch {
    return { languages: [], frameworks: [], role: guessRole(repoUrl), summary: '' };
  }
  const ctx = { token };

  let tree;
  try {
    tree = await provider.getTree(ctx, repoUrl);
  } catch {
    // Branch may not be 'main', repo may be empty/inaccessible — non-fatal.
    return { languages: [], frameworks: [], role: guessRole(repoUrl), summary: '' };
  }

  const { fileNames, dirNames } = rootEntriesFromTree(tree);
  const languages = new Set();
  const frameworks = new Set();

  for (const [name, sig] of Object.entries(CONFIG_SIGNATURES)) {
    const found = sig.type === 'dir' ? dirNames.has(name) : fileNames.has(name);
    if (!found) continue;
    if (sig.lang) languages.add(sig.lang);
    if (sig.framework) frameworks.add(sig.framework);

    if (sig.parse && !sig.type) {
      try {
        const file = await provider.getFileContents(ctx, repoUrl, name);
        if (file?.content) {
          const result = sig.parse(file.content);
          if (result.frameworks) result.frameworks.forEach((f) => frameworks.add(f));
          if (result.hasTS) languages.add('TypeScript');
        }
      } catch {
        /* parse / fetch failure is non-fatal */
      }
    }
  }

  const langArr = [...languages];
  const fwArr = [...frameworks];
  const role = detectRoleFromContents(fileNames, dirNames, fwArr) || guessRole(repoUrl);
  const parts = [...fwArr];
  if (langArr.length > 0 && fwArr.length === 0) parts.push(...langArr);
  else if (langArr.includes('TypeScript')) parts.push('TypeScript');
  const summary = parts.join(' + ');

  return { languages: langArr, frameworks: fwArr, role, summary };
}

// ---------------------------------------------------------------------------
// Route: /projects/{projectId}/repos
// ---------------------------------------------------------------------------

const handleReposRoute = async (g, response, event, projectId, userId) => {
  const { httpMethod } = event;

  // Membership check — all repo routes require project membership
  const isMember = await g
    .V()
    .has('Project', 'id', projectId)
    .outE('HAS_MEMBER')
    .inV()
    .has('User', 'id', userId)
    .hasNext();
  if (!isMember) return response(403, { error: 'Access denied' });

  if (httpMethod === 'DELETE') {
    const allowed = await g
      .V()
      .has('Project', 'id', projectId)
      .outE('HAS_MEMBER')
      .has('role', P.within('owner', 'admin'))
      .inV()
      .has('User', 'id', userId)
      .hasNext();
    if (!allowed) {
      return response(403, { error: 'Only project owners and admins can remove repositories' });
    }

    const repoUrl = event.queryStringParameters?.url;
    if (!repoUrl) return response(400, { error: 'url query parameter is required' });
    const decoded = decodeURIComponent(repoUrl);

    const existingRepos = await fetchRepos(g, projectId);
    const targetRepo = existingRepos.find((repo) => repo.url === decoded);
    if (!targetRepo) {
      return response(404, { error: 'Repository not found on this project' });
    }

    await g
      .V()
      .has('Project', 'id', projectId)
      .outE('HAS_REPO')
      .where(__.inV().has('Repository', 'url', decoded))
      .drop()
      .next();

    const stillReferenced = await g.V().has('Repository', 'url', decoded).inE('HAS_REPO').hasNext();
    if (!stillReferenced) {
      await g.V().has('Repository', 'url', decoded).drop().next();
    }

    if (targetRepo.role === 'primary') {
      const remainingRepos = await fetchRepos(g, projectId);
      const nextPrimaryUrl = remainingRepos[0]?.url || '';
      if (nextPrimaryUrl) {
        // Reuse the list we just fetched to avoid a redundant round-trip.
        await syncPrimaryRepo(g, projectId, nextPrimaryUrl, remainingRepos);
      }
      await g
        .V()
        .has('Project', 'id', projectId)
        .property(cardinality.single, 'git_repo', nextPrimaryUrl)
        .next();
    }

    return response(200, { removed: decoded });
  }

  // GET /projects/{projectId}/repos
  if (httpMethod === 'GET') {
    const legacyGitRepo = getVal(
      (await g.V().has('Project', 'id', projectId).valueMap('git_repo').next()).value,
      'git_repo',
    );
    await ensureLegacyRepoMigrated(g, projectId, legacyGitRepo);
    const repos = await fetchRepos(g, projectId);
    return response(200, repos);
  }

  // POST /projects/{projectId}/repos
  if (httpMethod === 'POST') {
    const allowed = await g
      .V()
      .has('Project', 'id', projectId)
      .outE('HAS_MEMBER')
      .has('role', P.within('owner', 'admin'))
      .inV()
      .has('User', 'id', userId)
      .hasNext();
    if (!allowed) {
      return response(403, { error: 'Only project owners and admins can add repositories' });
    }

    const data = JSON.parse(event.body || '{}');
    if (!data.url) return response(400, { error: 'url is required' });
    if (!REPO_URL_PATTERN.test(data.url)) {
      return response(400, { error: 'url must be in owner/repo format' });
    }
    const repoInputError = validateRepoRoleAndProvider(data);
    if (repoInputError) return response(400, { error: repoInputError });

    // Check for duplicates
    const duplicate = await g
      .V()
      .has('Project', 'id', projectId)
      .out('HAS_REPO')
      .has('Repository', 'url', data.url)
      .hasNext();
    if (duplicate) return response(409, { error: 'Repository already added to this project' });

    // Run quick detection (non-blocking — failures are non-fatal). Detection
    // runs against the repo's own provider so GitLab repos are detected too.
    const detectionProvider = data.provider || 'github';
    const token = await getUserGitToken(userId, detectionProvider);
    let detection = { languages: [], frameworks: [], role: guessRole(data.url), summary: '' };
    if (token) {
      try {
        detection = await detectRepoStack(data.url, token, detectionProvider);
      } catch (e) {
        console.error('Quick detection failed:', e.message);
      }
    }

    const newRepoId = `repo-${randomUUID()}`;
    const addedAt = new Date().toISOString();
    const repoRole = data.role || detection.role || 'unknown';
    const provider = detectionProvider;
    const detectedStack = data.detectedStack || detection.summary || '';

    await g
      .addV('Repository')
      .property('id', newRepoId)
      .property('url', data.url)
      .property('provider', provider)
      .property('role', repoRole)
      .property('detected_stack', detectedStack)
      .property('added_at', addedAt)
      .as('r')
      .V()
      .has('Project', 'id', projectId)
      .addE('HAS_REPO')
      .to('r')
      .next();

    // Reconcile role labels and the legacy git_repo field. When the new repo is
    // primary, demote any previous primary so only one remains.
    const allRepos = await fetchRepos(g, projectId);
    let primaryUrl;
    if (repoRole === 'primary') {
      await syncPrimaryRepo(g, projectId, data.url, allRepos);
      primaryUrl = data.url;
    } else {
      primaryUrl = derivePrimaryRepo(allRepos, '');
    }
    await g
      .V()
      .has('Project', 'id', projectId)
      .property(cardinality.single, 'git_repo', primaryUrl)
      .next();

    return response(201, { url: data.url, provider, role: repoRole, detectedStack, addedAt });
  }

  return response(405, { error: 'Method not allowed' });
};

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export const handler = async (event) => {
  const response = buildResponse(event);
  console.log(
    'Request:',
    JSON.stringify({
      httpMethod: event.httpMethod,
      path: event.path,
      pathParameters: event.pathParameters,
    }),
  );

  // Handle OPTIONS for CORS
  if (event.httpMethod === 'OPTIONS') {
    return response(200, {});
  }

  let conn;
  try {
    conn = await getConnection();
    let g = traversal().withRemote(conn);
    if (process.env.GREMLIN_PARTITION) {
      g = g.withStrategies(
        new PartitionStrategy({
          partitionKey: '_partition',
          writePartition: process.env.GREMLIN_PARTITION,
          readPartitions: [process.env.GREMLIN_PARTITION],
        }),
      );
    }

    const { httpMethod, pathParameters, body, path } = event;
    const projectId = pathParameters?.projectId;
    const userId = event.requestContext?.authorizer?.claims?.sub;
    const userEmail = event.requestContext?.authorizer?.claims?.email || '';
    const isMigrateTracker = httpMethod === 'POST' && path?.endsWith('/migrate-tracker');
    const isAdminMigrationStatus =
      httpMethod === 'GET' && path?.endsWith('/admin/tracker-migration/status');
    const isAdminMigrationRun = httpMethod === 'POST' && path?.endsWith('/admin/tracker-migration');

    // POST /projects/{projectId}/migrate-tracker — owner/admin only.
    // Backfills the tracker_* fields on this project's sprints + creates a
    // synthetic HAS_TRACKER edge if the project still uses the legacy
    // issue_integration_enabled boolean. Idempotent. See parent issue #194.
    if (isMigrateTracker) {
      if (!userId) return response(401, { error: 'Unauthorized' });
      const role = await fetchMembershipRole(g, projectId, userId);
      if (!role) return response(403, { error: 'Access denied' });
      if (role !== 'owner' && role !== 'admin') {
        return response(403, { error: 'Only project owners and admins can migrate trackers' });
      }
      let dryRun = false;
      if (body) {
        try {
          dryRun = Boolean(JSON.parse(body)?.dryRun);
        } catch {
          return response(400, { error: 'Invalid JSON body' });
        }
      }
      const result = await runTrackerMigration(g, { projectId, dryRun });
      return response(200, result);
    }

    // GET /admin/tracker-migration/status — operator-facing whole-graph
    // count of projects + sprints still on the legacy tracker shape. Drives
    // the Admin page's "Tracker Migration" card. Implemented as a dry-run
    // of the same shared core that the per-project endpoint and the bulk
    // CLI lambda use, so the three paths cannot drift. See parent issue
    // #194 phase #198. Authenticated-only — matches the existing posture
    // for admin-config endpoints in this repo (see `/agents/settings` and
    // `/trackers/providers/{p}/oauth-config`); tightening admin gating is
    // a separate, repo-wide hardening pass.
    if (isAdminMigrationStatus) {
      if (!userId) return response(401, { error: 'Unauthorized' });
      const result = await runTrackerMigration(g, { dryRun: true });
      return response(200, result);
    }

    // POST /admin/tracker-migration — operator-facing bulk migration
    // trigger. Same effect as `aws lambda invoke ... migrate-tracker-fields`,
    // exposed through the API so operators don't need shell access. Body
    // `{ dryRun?: boolean }`. Idempotent.
    if (isAdminMigrationRun) {
      if (!userId) return response(401, { error: 'Unauthorized' });
      let dryRun = false;
      if (body) {
        try {
          dryRun = Boolean(JSON.parse(body)?.dryRun);
        } catch {
          return response(400, { error: 'Invalid JSON body' });
        }
      }
      const result = await runTrackerMigration(g, { dryRun });
      return response(200, result);
    }

    // ---------------------------------------------------------------------------
    // Sub-resource routing: /projects/{projectId}/mcp-servers
    //                       /projects/{projectId}/steering-docs
    // Detected by examining event.path since each sub-resource has its own
    // API Gateway resource that maps to this Lambda.
    // ---------------------------------------------------------------------------
    const requestPath = event.path || '';
    if (projectId && requestPath.endsWith('/mcp-servers')) {
      return await handleProjectMcpServers(g, response, httpMethod, projectId, userId, body);
    }
    if (projectId && requestPath.endsWith('/steering-docs')) {
      return await handleProjectSteeringDocs(g, response, httpMethod, projectId, userId, body);
    }

    // Route: /projects/{projectId}/repos
    if (projectId && /\/repos(\/|$)/.test(requestPath)) {
      if (!userId) return response(401, { error: 'Unauthorized' });
      return await handleReposRoute(g, response, event, projectId, userId);
    }

    switch (httpMethod) {
      case 'GET':
        if (projectId) {
          // Single project lookup - verify user is a member and return their
          // role. Single round-trip: role + project valueMap + trackers all
          // fold into one traversal (parity with the list endpoint).
          if (!userId) return response(401, { error: 'Unauthorized' });

          const single = await g
            .V()
            .has('Project', 'id', projectId)
            .as('p')
            .outE('HAS_MEMBER')
            .as('e')
            .inV()
            .has('User', 'id', userId)
            .select('e', 'p')
            .by(__.values('role'))
            .by(__.project('vertex', 'trackers').by(__.valueMap()).by(projectTrackersFoldStep()))
            .next();
          if (single.done) return response(403, { error: 'Access denied' });

          const item = single.value;
          const role = item instanceof Map ? item.get('e') : item.e;
          const pBundle = item instanceof Map ? item.get('p') : item.p;
          const v = pBundle instanceof Map ? pBundle.get('vertex') : pBundle.vertex;
          const trackerMaps =
            (pBundle instanceof Map ? pBundle.get('trackers') : pBundle.trackers) ?? [];
          const legacyGitRepo = getVal(v, 'git_repo');

          // Lazy migration: ensure legacy git_repo has a corresponding Repository vertex
          await ensureLegacyRepoMigrated(g, projectId, legacyGitRepo);
          const repos = await fetchRepos(g, projectId);
          const project = {
            id: getVal(v, 'id') || projectId,
            name: getVal(v, 'name'),
            gitProvider: getVal(v, 'git_provider') || 'github',
            gitRepo: derivePrimaryRepo(repos, legacyGitRepo),
            agentCli: getVal(v, 'agent_cli') || 'kiro',
            cliModels: parseCliModels(getVal(v, 'cli_models')),
            issueIntegrationEnabled: getVal(v, 'issue_integration_enabled') === 'true',
            createdAt: getVal(v, 'created_at') || new Date().toISOString(),
            userRole: role || 'member',
            trackers: trackerMaps.map(mapBinding),
            repos,
            ...readV2Settings(v),
          };
          return response(200, withLegacyTracker(project));
        }

        // List projects - only return projects where the current user is a member.
        // Trackers fold into the same traversal so we don't fan out into N+1
        // per-project fetches.
        if (!userId) return response(401, { error: 'Unauthorized' });

        const results = await g
          .V()
          .has('User', 'id', userId)
          .inE('HAS_MEMBER')
          .as('e')
          .outV()
          .hasLabel('Project')
          .as('p')
          .select('e', 'p')
          .by(__.values('role'))
          .by(__.project('vertex', 'trackers').by(__.valueMap()).by(projectTrackersFoldStep()))
          .toList();
        const settled = await Promise.allSettled(
          results.map(async (item) => {
            // item is a Map with keys 'e' (role string) and 'p' ({vertex, trackers}).
            const role = item instanceof Map ? item.get('e') : item.e;
            const pBundle = item instanceof Map ? item.get('p') : item.p;
            const v = pBundle instanceof Map ? pBundle.get('vertex') : pBundle.vertex;
            const trackerMaps =
              (pBundle instanceof Map ? pBundle.get('trackers') : pBundle.trackers) ?? [];
            const pid = getVal(v, 'id');
            const legacyGitRepo = getVal(v, 'git_repo');

            await ensureLegacyRepoMigrated(g, pid, legacyGitRepo);
            const repos = await fetchRepos(g, pid);

            return withLegacyTracker({
              id: pid,
              name: getVal(v, 'name'),
              gitProvider: getVal(v, 'git_provider') || 'github',
              gitRepo: derivePrimaryRepo(repos, legacyGitRepo),
              agentCli: getVal(v, 'agent_cli') || 'kiro',
              cliModels: parseCliModels(getVal(v, 'cli_models')),
              issueIntegrationEnabled: getVal(v, 'issue_integration_enabled') === 'true',
              createdAt: getVal(v, 'created_at') || new Date().toISOString(),
              userRole: role || 'member',
              trackers: trackerMaps.map(mapBinding),
              repos,
              ...readV2Settings(v),
            });
          }),
        );
        // Don't let one project's enrichment failure 500 the whole list.
        const failed = settled.filter((r) => r.status === 'rejected');
        if (failed.length > 0) {
          console.error(
            `[projects] ${failed.length} project(s) failed to enrich and were omitted:`,
            failed.map((f) => f.reason?.message),
          );
        }
        const projects = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
        return response(200, projects);

      case 'POST': {
        if (!userId) return response(401, { error: 'Unauthorized' });

        const data = JSON.parse(body);
        const id = randomUUID();
        const createdAt = new Date().toISOString();

        // Support both legacy `gitRepo` (string) and new `repos` (array) input.
        // SECURITY: repo urls are interpolated into a shell `git clone` in the
        // pool-worker. The multi-repo `repos[]` entries are real clone targets,
        // so they must be strict owner/repo. The legacy `gitRepo` string stays
        // freeform but must be shell-safe (no injection chars).
        if (data.repos !== undefined && !Array.isArray(data.repos)) {
          return response(400, { error: 'repos must be an array' });
        }
        // Copy so the legacy-fallback push below never mutates the parsed body.
        const inputRepos = [...(data.repos || [])];
        const legacyGitRepo = data.gitRepo || '';

        for (const repo of inputRepos) {
          if (!repo.url || !REPO_URL_PATTERN.test(repo.url)) {
            return response(400, {
              error: `Invalid repository url "${repo.url}". Expected "owner/repo" format.`,
            });
          }
          const repoInputError = validateRepoRoleAndProvider(repo);
          if (repoInputError) return response(400, { error: repoInputError });
        }
        if (legacyGitRepo && !isSafeRepo(legacyGitRepo)) {
          return response(400, { error: `Invalid gitRepo "${legacyGitRepo}".` });
        }

        if (inputRepos.length === 0 && legacyGitRepo) {
          inputRepos.push({
            url: legacyGitRepo,
            provider: data.gitProvider || 'github',
            role: 'primary',
          });
        }

        const primaryUrl = derivePrimaryRepo(inputRepos, '');

        const issueIntegrationEnabled = data.issueIntegrationEnabled === true;
        const cliModelsValidation = normalizeCliModels(data.cliModels);
        if (!cliModelsValidation.valid) {
          return response(400, {
            error: 'Invalid cliModels configuration',
            issues: cliModelsValidation.issues,
          });
        }
        const cliModels = cliModelsValidation.value;

        // v2 project discriminator + settings. v1 (default) skips them entirely.
        const kind = data.kind === 'v2' ? 'v2' : 'v1';
        let v2Settings = { kind };
        if (kind === 'v2') {
          const parkValidation = normalizeParkReleaseSeconds(data.parkReleaseSeconds);
          if (!parkValidation.valid) return response(400, { error: parkValidation.error });
          const parallelValidation = normalizeMaxParallelUnits(data.maxParallelUnits);
          if (!parallelValidation.valid) return response(400, { error: parallelValidation.error });
          const prValidation = normalizePrStrategy(data.prStrategy);
          if (!prValidation.valid) return response(400, { error: prValidation.error });
          v2Settings = {
            kind,
            workflowId: data.workflowId || DEFAULT_V2_WORKFLOW_ID,
            // Empty pin = "resolve latest at intent create" (left to the intents API).
            workflowVersion: Number.isInteger(data.workflowVersion) ? data.workflowVersion : null,
            // Scope is NOT a project property — it is chosen per-intent.
            parkReleaseSeconds: parkValidation.value,
            maxParallelUnits: parallelValidation.value,
            prStrategy: prValidation.value,
          };
        }

        // Create the project vertex with creator tracking
        const createV = g
          .addV('Project')
          .property('id', id)
          .property('name', data.name)
          .property('git_provider', data.gitProvider || 'github')
          .property('git_repo', primaryUrl)
          .property('agent_cli', data.agentCli || 'kiro')
          .property('cli_models', JSON.stringify(cliModels))
          .property('issue_integration_enabled', issueIntegrationEnabled ? 'true' : 'false')
          .property('kind', kind)
          .property('created_by', userId)
          .property('created_at', createdAt);
        if (kind === 'v2') {
          createV
            .property('workflow_id', v2Settings.workflowId)
            .property(
              'workflow_version',
              v2Settings.workflowVersion == null ? '' : String(v2Settings.workflowVersion),
            )
            .property('park_release_seconds', String(v2Settings.parkReleaseSeconds))
            .property('max_parallel_units', String(v2Settings.maxParallelUnits))
            .property('pr_strategy', v2Settings.prStrategy);
        }
        await createV.next();

        // Create Repository vertices and HAS_REPO edges. Normalize so at most
        // one repo keeps the `primary` role: `primaryUrl` is the canonical
        // primary (first explicit primary, else first repo); any other repo
        // that asked for `primary` is demoted to `secondary`.
        const reposOut = [];
        for (const repo of inputRepos) {
          const repoId = `repo-${randomUUID()}`;
          const addedAt = new Date().toISOString();
          const requestedRole = repo.role || guessRole(repo.url);
          const repoRole =
            requestedRole === 'primary' && repo.url !== primaryUrl ? 'secondary' : requestedRole;
          const provider = repo.provider || data.gitProvider || 'github';

          await g
            .addV('Repository')
            .property('id', repoId)
            .property('url', repo.url)
            .property('provider', provider)
            .property('role', repoRole)
            .property('detected_stack', repo.detectedStack || '')
            .property('added_at', addedAt)
            .as('r')
            .V()
            .has('Project', 'id', id)
            .addE('HAS_REPO')
            .to('r')
            .next();

          reposOut.push({
            url: repo.url,
            provider,
            role: repoRole,
            detectedStack: repo.detectedStack || '',
            addedAt,
          });
        }

        // Ensure the User vertex exists
        const userExists = await g.V().has('User', 'id', userId).hasNext();
        if (!userExists) {
          await g.addV('User').property('id', userId).property('email', userEmail).next();
        }

        // Add the creator as project owner
        await g
          .V()
          .has('Project', 'id', id)
          .addE('HAS_MEMBER')
          .property('role', 'owner')
          .to(__.V().has('User', 'id', userId))
          .next();

        return response(201, {
          id,
          name: data.name,
          gitProvider: data.gitProvider || 'github',
          gitRepo: primaryUrl,
          agentCli: data.agentCli || 'kiro',
          cliModels,
          issueIntegrationEnabled,
          createdAt,
          repos: reposOut,
          ...v2Settings,
        });
      }

      case 'PUT': {
        if (!userId) return response(401, { error: 'Unauthorized' });

        // Owners and admins can update project settings
        const updaterRole = await fetchMembershipRole(g, projectId, userId);
        if (!updaterRole) return response(403, { error: 'Access denied' });
        if (updaterRole !== 'owner' && updaterRole !== 'admin') {
          return response(403, { error: 'Only project owners and admins can update settings' });
        }

        const data = JSON.parse(body);
        if (data.name) {
          await g
            .V()
            .has('Project', 'id', projectId)
            .property(cardinality.single, 'name', data.name)
            .next();
        }
        if (data.gitRepo !== undefined) {
          // SECURITY: same execSync sink as POST. This value also feeds
          // ensureLegacyRepoMigrated/syncPrimaryRepo, which can create a
          // Repository vertex — so enforce the same strict owner/repo format
          // as POST /repos. A looser value (full URL, extra path segments)
          // passes the shell-safe check but later makes parseOwnerRepo throw
          // inside trigger_pr_creation, bricking PR creation for the project.
          if (data.gitRepo && !REPO_URL_PATTERN.test(data.gitRepo)) {
            return response(400, {
              error: `Invalid gitRepo "${data.gitRepo}": expected "owner/repo".`,
            });
          }
          await g
            .V()
            .has('Project', 'id', projectId)
            .property(cardinality.single, 'git_repo', data.gitRepo)
            .next();
          if (data.gitRepo) {
            await ensureLegacyRepoMigrated(g, projectId, data.gitRepo);
            await syncPrimaryRepo(g, projectId, data.gitRepo);
          }
        }
        if (data.gitProvider) {
          await g
            .V()
            .has('Project', 'id', projectId)
            .property(cardinality.single, 'git_provider', data.gitProvider)
            .next();
        }
        if (data.agentCli) {
          const validClis = ['kiro', 'claude', 'opencode'];
          if (!validClis.includes(data.agentCli)) {
            return response(400, {
              error: `Invalid agentCli value. Must be one of: ${validClis.join(', ')}`,
            });
          }
          await g
            .V()
            .has('Project', 'id', projectId)
            .property(cardinality.single, 'agent_cli', data.agentCli)
            .next();
        }
        let normalizedCliModels;
        if (data.cliModels !== undefined) {
          const validation = normalizeCliModels(data.cliModels);
          if (!validation.valid) {
            return response(400, {
              error: 'Invalid cliModels configuration',
              issues: validation.issues,
            });
          }
          normalizedCliModels = validation.value;
          await g
            .V()
            .has('Project', 'id', projectId)
            .property(cardinality.single, 'cli_models', JSON.stringify(normalizedCliModels))
            .next();
        }
        if (data.issueIntegrationEnabled !== undefined) {
          const vertex = g.V().has('Project', 'id', projectId);
          await vertex
            .property(
              cardinality.single,
              'issue_integration_enabled',
              data.issueIntegrationEnabled ? 'true' : 'false',
            )
            .next();
        }
        // v2 settings — owner/admin tunable. Only meaningful for v2 projects;
        // writing them on a v1 project is harmless (readV2Settings ignores them).
        let normalizedParkReleaseSeconds;
        if (data.parkReleaseSeconds !== undefined) {
          const parkValidation = normalizeParkReleaseSeconds(data.parkReleaseSeconds);
          if (!parkValidation.valid) return response(400, { error: parkValidation.error });
          normalizedParkReleaseSeconds = parkValidation.value;
          await g
            .V()
            .has('Project', 'id', projectId)
            .property(
              cardinality.single,
              'park_release_seconds',
              String(normalizedParkReleaseSeconds),
            )
            .next();
        }
        // Concurrency cap for parallel unit lanes (docs/v2-parallel.md WP5).
        let normalizedMaxParallelUnits;
        if (data.maxParallelUnits !== undefined) {
          const parallelValidation = normalizeMaxParallelUnits(data.maxParallelUnits);
          if (!parallelValidation.valid) return response(400, { error: parallelValidation.error });
          normalizedMaxParallelUnits = parallelValidation.value;
          await g
            .V()
            .has('Project', 'id', projectId)
            .property(cardinality.single, 'max_parallel_units', String(normalizedMaxParallelUnits))
            .next();
        }
        // PR strategy at fan-in (docs/v2-parallel.md WP6; only intent-pr enabled).
        let normalizedPrStrategy;
        if (data.prStrategy !== undefined) {
          const prValidation = normalizePrStrategy(data.prStrategy);
          if (!prValidation.valid) return response(400, { error: prValidation.error });
          normalizedPrStrategy = prValidation.value;
          await g
            .V()
            .has('Project', 'id', projectId)
            .property(cardinality.single, 'pr_strategy', normalizedPrStrategy)
            .next();
        }
        if (data.workflowId !== undefined) {
          await g
            .V()
            .has('Project', 'id', projectId)
            .property(cardinality.single, 'workflow_id', data.workflowId || DEFAULT_V2_WORKFLOW_ID)
            .next();
        }
        if (data.workflowVersion !== undefined) {
          await g
            .V()
            .has('Project', 'id', projectId)
            .property(
              cardinality.single,
              'workflow_version',
              Number.isInteger(data.workflowVersion) ? String(data.workflowVersion) : '',
            )
            .next();
        }
        return response(200, {
          id: projectId,
          ...data,
          ...(normalizedCliModels !== undefined ? { cliModels: normalizedCliModels } : {}),
          ...(normalizedParkReleaseSeconds !== undefined
            ? { parkReleaseSeconds: normalizedParkReleaseSeconds }
            : {}),
          ...(normalizedMaxParallelUnits !== undefined
            ? { maxParallelUnits: normalizedMaxParallelUnits }
            : {}),
          ...(normalizedPrStrategy !== undefined ? { prStrategy: normalizedPrStrategy } : {}),
        });
      }

      case 'DELETE':
        if (!userId) return response(401, { error: 'Unauthorized' });

        // Only owners can delete projects
        const canDelete = await g
          .V()
          .has('Project', 'id', projectId)
          .outE('HAS_MEMBER')
          .has('role', 'owner')
          .inV()
          .has('User', 'id', userId)
          .hasNext();
        if (!canDelete) return response(403, { error: 'Only project owners can delete projects' });

        // Drop associated Repository vertices first. drop() on an empty
        // traversal is a no-op, so a rejection here is a real error — let it
        // propagate to the handler-level catch instead of being swallowed.
        await g
          .V()
          .has('Project', 'id', projectId)
          .out('HAS_REPO')
          .hasLabel('Repository')
          .drop()
          .next();

        await g.V().has('Project', 'id', projectId).drop().next();
        return response(204, {});

      default:
        return response(405, { error: 'Method not allowed' });
    }
  } catch (err) {
    console.error('Error:', err);
    return response(500, {
      error: 'Internal server error',
      message: err.message,
      neptune: process.env.NEPTUNE_ENDPOINT,
    });
  } finally {
    if (conn) {
      try {
        await conn.close();
      } catch (e) {
        console.error('Error closing connection:', e);
      }
    }
  }
};

// ---------------------------------------------------------------------------
// Project-level MCP servers: GET/PUT /projects/{projectId}/mcp-servers
// ---------------------------------------------------------------------------

async function handleProjectMcpServers(g, response, httpMethod, projectId, userId, body) {
  if (!userId) return response(401, { error: 'Unauthorized' });

  // Verify user is a project member
  const memberEdges = await g
    .V()
    .has('Project', 'id', projectId)
    .outE('HAS_MEMBER')
    .as('e')
    .inV()
    .has('User', 'id', userId)
    .select('e')
    .by(__.valueMap())
    .toList();
  if (memberEdges.length === 0) return response(403, { error: 'Access denied' });

  if (httpMethod === 'GET') {
    const result = await g.V().has('Project', 'id', projectId).valueMap('mcp_servers').next();
    const raw = result.value ? getVal(result.value, 'mcp_servers') : '[]';
    return response(200, { mcpServers: raw || '[]' });
  }

  if (httpMethod === 'PUT') {
    // Only owners and admins can update MCP servers
    const role = await fetchMembershipRole(g, projectId, userId);
    if (!role) return response(403, { error: 'Access denied' });
    if (role !== 'owner' && role !== 'admin') {
      return response(403, { error: 'Only project owners and admins can update MCP servers' });
    }

    const data = JSON.parse(body || '{}');
    const mcpServersJson = data.mcpServers || '[]';
    const validation = validateMcpServersJson(mcpServersJson);
    if (!validation.valid) {
      return response(400, {
        error: 'Invalid MCP servers configuration',
        issues: validation.issues,
      });
    }
    await g
      .V()
      .has('Project', 'id', projectId)
      .property(cardinality.single, 'mcp_servers', mcpServersJson)
      .next();
    return response(200, { saved: true });
  }

  return response(405, { error: 'Method not allowed' });
}

// ---------------------------------------------------------------------------
// Project-level steering docs: GET/PUT /projects/{projectId}/steering-docs
// ---------------------------------------------------------------------------

async function handleProjectSteeringDocs(g, response, httpMethod, projectId, userId, body) {
  if (!userId) return response(401, { error: 'Unauthorized' });

  // Verify user is a project member
  const memberEdges = await g
    .V()
    .has('Project', 'id', projectId)
    .outE('HAS_MEMBER')
    .as('e')
    .inV()
    .has('User', 'id', userId)
    .select('e')
    .by(__.valueMap())
    .toList();
  if (memberEdges.length === 0) return response(403, { error: 'Access denied' });

  const artifactsBucket = process.env.ARTIFACTS_BUCKET;
  const region = process.env.AWS_REGION || 'us-east-1';
  const s3 = new S3Client({ region });

  if (httpMethod === 'GET') {
    const result = await g.V().has('Project', 'id', projectId).valueMap('steering_docs').next();
    const raw = result.value ? getVal(result.value, 'steering_docs') : '[]';
    let docs = [];
    try {
      docs = JSON.parse(raw || '[]');
    } catch {
      docs = [];
    }

    // Generate presigned download URLs for each doc
    const docsWithUrls = await Promise.all(
      docs.map(async (doc) => {
        if (!doc.s3Key || !artifactsBucket) return doc;
        try {
          const downloadUrl = await getSignedUrl(
            s3,
            new GetObjectCommand({ Bucket: artifactsBucket, Key: doc.s3Key }),
            { expiresIn: 3600 },
          );
          return { ...doc, downloadUrl };
        } catch {
          return doc;
        }
      }),
    );

    return response(200, { steeringDocs: docsWithUrls });
  }

  if (httpMethod === 'PUT') {
    // Only owners and admins can update steering docs
    const role = await fetchMembershipRole(g, projectId, userId);
    if (!role) return response(403, { error: 'Access denied' });
    if (role !== 'owner' && role !== 'admin') {
      return response(403, { error: 'Only project owners and admins can update steering docs' });
    }

    const data = JSON.parse(body || '{}');
    const incomingDocs = data.steeringDocs || [];

    if (!artifactsBucket) {
      return response(500, { error: 'ARTIFACTS_BUCKET env var not configured' });
    }
    if (incomingDocs.length > 20) {
      return response(400, { error: 'Maximum 20 steering documents per project' });
    }

    // Compute S3 keys and generate presigned upload URLs for new/changed docs
    const uploadUrls = [];
    const savedDocs = [];
    for (const doc of incomingDocs) {
      const filename = doc.filename || '';
      const safeBase = nodePath.basename(filename);
      if (!safeBase || safeBase !== filename || !safeBase.toLowerCase().endsWith('.md')) {
        return response(400, {
          error: `Invalid filename "${filename}". Must end in .md and contain no path separators.`,
        });
      }
      const s3Key = `steering/${projectId}/project--${safeBase}`;
      try {
        const uploadUrl = await getSignedUrl(
          s3,
          new PutObjectCommand({
            Bucket: artifactsBucket,
            Key: s3Key,
            ContentType: 'text/markdown',
          }),
          { expiresIn: 3600 },
        );
        uploadUrls.push({ filename: safeBase, s3Key, uploadUrl });
      } catch (err) {
        console.error(`[projects] Failed to generate presigned URL for ${s3Key}:`, err.message);
      }
      savedDocs.push({ filename: safeBase, s3Key });
    }

    // Persist metadata to Neptune
    const metadataJson = JSON.stringify(savedDocs);
    await g
      .V()
      .has('Project', 'id', projectId)
      .property(cardinality.single, 'steering_docs', metadataJson)
      .next();

    return response(200, { saved: true, uploadUrls });
  }

  return response(405, { error: 'Method not allowed' });
}
