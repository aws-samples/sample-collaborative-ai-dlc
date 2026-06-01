import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { getUrlAndHeaders } from 'gremlin-aws-sigv4/lib/utils.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { buildResponse } from '../shared/response.js';
import { runTrackerMigration } from '../shared/tracker-migration.js';
import {
  getVal,
  projectTrackersFoldStep,
  mapBinding,
  fetchMembershipRole,
} from '../shared/trackers.js';
import { validateMcpServersJson } from '../shared/mcp-validator.js';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const __ = gremlin.process.statics;
const { cardinality, P } = gremlin.process;

// Synthetic-binding id for legacy projects (issue_integration_enabled='true'
// but no HAS_TRACKER edge). Lets the frontend render the GitHub-issues panel
// against the project's gitRepo without requiring the user to migrate first.
// The trackers lambda special-cases this id on the issue routes.
export const LEGACY_GITHUB_BINDING_ID = 'legacy-github';

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

// Validates owner/repo format. GitHub allows alphanumeric, hyphens,
// underscores, and dots; max 39 chars for owner and 100 for repo.
// Used for the multi-repo `repos[]` API — these are real clone targets.
const REPO_URL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;

// The legacy `gitRepo` field is historically a freeform string (bare names,
// SSH URLs). We can't tighten it to owner/repo without breaking that contract,
// but it still gets interpolated into `git clone "https://.../${url}.git"` in
// the pool-worker. This whitelist rejects exactly the characters that can break
// out of that double-quoted shell string ("  `  $  \  whitespace), closing the
// injection vector while preserving freeform values.
const SHELL_SAFE_REPO_PATTERN = /^[A-Za-z0-9._@:/-]+$/;

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
  if (!SHELL_SAFE_REPO_PATTERN.test(legacyGitRepo)) {
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

const getUserGitToken = async (userId) => {
  if (!userId || !process.env.GIT_CONNECTIONS_TABLE) return null;
  try {
    const { Item } = await ddb.send(
      new GetCommand({
        TableName: process.env.GIT_CONNECTIONS_TABLE,
        Key: { userId },
      }),
    );
    return Item?.accessToken || null;
  } catch {
    return null;
  }
};

const ghFetch = async (url, token) => {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) return null;
  return res.json();
};

async function detectRepoStack(repoUrl, token) {
  const [owner, repo] = (repoUrl || '').split('/');
  if (!owner || !repo || !token) {
    return { languages: [], frameworks: [], role: guessRole(repoUrl), summary: '' };
  }

  const contents = await ghFetch(`https://api.github.com/repos/${owner}/${repo}/contents`, token);
  if (!Array.isArray(contents)) {
    return { languages: [], frameworks: [], role: guessRole(repoUrl), summary: '' };
  }

  const fileNames = new Set(contents.map((f) => f.name));
  const dirNames = new Set(contents.filter((f) => f.type === 'dir').map((f) => f.name));
  const languages = new Set();
  const frameworks = new Set();

  for (const [name, sig] of Object.entries(CONFIG_SIGNATURES)) {
    const found = sig.type === 'dir' ? dirNames.has(name) : fileNames.has(name);
    if (!found) continue;
    if (sig.lang) languages.add(sig.lang);
    if (sig.framework) frameworks.add(sig.framework);

    if (sig.parse && !sig.type) {
      const fileContent = await ghFetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${name}`,
        token,
      );
      if (fileContent?.content) {
        try {
          const decoded = Buffer.from(fileContent.content, 'base64').toString('utf8');
          const result = sig.parse(decoded);
          if (result.frameworks) result.frameworks.forEach((f) => frameworks.add(f));
          if (result.hasTS) languages.add('TypeScript');
        } catch {
          /* parse failure is non-fatal */
        }
      }
    }
  }

  const langArr = [...languages];
  const fwArr = [...frameworks];
  const role = detectRoleFromContents(fileNames, dirNames, fwArr) || guessRole(repoUrl);
  const parts = [...fwArr];
  if (langArr.length > 0 && fwArr.length === 0) parts.push(...langArr);
  else if (langArr.includes('TypeScript')) parts.push('TypeScript');
  const summary = parts.join(' + ') || langArr.join(' + ') || '';

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

    // Single query: aggregate the matched repo (eager barrier) before dropping,
    // then cap() returns what was collected so we can still distinguish 404.
    const dropped = await g
      .V()
      .has('Project', 'id', projectId)
      .out('HAS_REPO')
      .has('Repository', 'url', decoded)
      .aggregate('x')
      .drop()
      .cap('x')
      .next();
    if (!dropped.value || dropped.value.length === 0) {
      return response(404, { error: 'Repository not found on this project' });
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

    // Check for duplicates
    const duplicate = await g
      .V()
      .has('Project', 'id', projectId)
      .out('HAS_REPO')
      .has('Repository', 'url', data.url)
      .hasNext();
    if (duplicate) return response(409, { error: 'Repository already added to this project' });

    // Run quick detection (non-blocking — failures are non-fatal)
    const token = await getUserGitToken(userId);
    let detection = { languages: [], frameworks: [], role: guessRole(data.url), summary: '' };
    if (token) {
      try {
        detection = await detectRepoStack(data.url, token);
      } catch (e) {
        console.error('Quick detection failed:', e.message);
      }
    }

    const newRepoId = `repo-${randomUUID()}`;
    const addedAt = new Date().toISOString();
    const repoRole = data.role || detection.role || 'unknown';
    const provider = data.provider || 'github';
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

    // Update legacy git_repo field to primary
    const allRepos = await fetchRepos(g, projectId);
    const primaryUrl = derivePrimaryRepo(allRepos, '');
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
    const path = event.path || '';
    if (projectId && /\/repos(\/|$)/.test(path)) {
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
            issueIntegrationEnabled: getVal(v, 'issue_integration_enabled') === 'true',
            createdAt: getVal(v, 'created_at') || new Date().toISOString(),
            userRole: role || 'member',
            trackers: trackerMaps.map(mapBinding),
            repos,
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
              issueIntegrationEnabled: getVal(v, 'issue_integration_enabled') === 'true',
              createdAt: getVal(v, 'created_at') || new Date().toISOString(),
              userRole: role || 'member',
              trackers: trackerMaps.map(mapBinding),
              repos,
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
        const inputRepos = data.repos || [];
        const legacyGitRepo = data.gitRepo || '';

        for (const repo of inputRepos) {
          if (!repo.url || !REPO_URL_PATTERN.test(repo.url)) {
            return response(400, {
              error: `Invalid repository url "${repo.url}". Expected "owner/repo" format.`,
            });
          }
        }
        if (legacyGitRepo && !SHELL_SAFE_REPO_PATTERN.test(legacyGitRepo)) {
          return response(400, { error: `Invalid gitRepo "${legacyGitRepo}".` });
        }

        if (inputRepos.length === 0 && legacyGitRepo) {
          inputRepos.push({
            url: legacyGitRepo,
            provider: data.gitProvider || 'github',
            role: 'primary',
          });
        }

        const primaryUrl =
          inputRepos.length > 0
            ? (inputRepos.find((r) => r.role === 'primary') || inputRepos[0]).url
            : '';

        const issueIntegrationEnabled = data.issueIntegrationEnabled === true;

        // Create the project vertex with creator tracking
        await g
          .addV('Project')
          .property('id', id)
          .property('name', data.name)
          .property('git_provider', data.gitProvider || 'github')
          .property('git_repo', primaryUrl)
          .property('agent_cli', data.agentCli || 'kiro')
          .property('issue_integration_enabled', issueIntegrationEnabled ? 'true' : 'false')
          .property('created_by', userId)
          .property('created_at', createdAt)
          .next();

        // Create Repository vertices and HAS_REPO edges
        const reposOut = [];
        for (const repo of inputRepos) {
          const repoId = `repo-${randomUUID()}`;
          const addedAt = new Date().toISOString();
          const repoRole = repo.role || guessRole(repo.url);
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
          issueIntegrationEnabled,
          createdAt,
          repos: reposOut,
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
          // SECURITY: same execSync sink as POST. The legacy gitRepo is freeform
          // but must be shell-safe so it can't break out of the git clone command.
          if (data.gitRepo && !SHELL_SAFE_REPO_PATTERN.test(data.gitRepo)) {
            return response(400, { error: `Invalid gitRepo "${data.gitRepo}".` });
          }
          await g
            .V()
            .has('Project', 'id', projectId)
            .property(cardinality.single, 'git_repo', data.gitRepo)
            .next();
          if (data.gitRepo) {
            await ensureLegacyRepoMigrated(g, projectId, data.gitRepo);
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
        return response(200, { id: projectId, ...data });
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

        // Drop associated Repository vertices first
        await g
          .V()
          .has('Project', 'id', projectId)
          .out('HAS_REPO')
          .hasLabel('Repository')
          .drop()
          .next()
          .catch(() => {}); // No repos is fine

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
      const safeBase = path.basename(filename);
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
