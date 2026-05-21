const gremlin = require('gremlin');
const { randomUUID } = require('crypto');
const { fromNodeProviderChain } = require('@aws-sdk/credential-providers');
const { getUrlAndHeaders } = require('gremlin-aws-sigv4/lib/utils');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { buildResponse } = require('./shared/response');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
const traversal = gremlin.process.AnonymousTraversalSource.traversal;
const __ = gremlin.process.statics;
const { cardinality } = gremlin.process;

// Extract a property value from a Neptune valueMap result (handles both Map and plain object)
const getVal = (obj, key) => {
  if (!obj) return '';
  const raw = obj instanceof Map ? obj.get(key) : obj[key];
  if (Array.isArray(raw)) return raw[0] ?? '';
  return raw ?? '';
};

const getConnection = async () => {
  const host = process.env.NEPTUNE_ENDPOINT;
  const port = '8182';
  const region = process.env.AWS_REGION || 'us-east-1';

  const credentials = await fromNodeProviderChain()();
  credentials.region = region;

  const connInfo = getUrlAndHeaders(host, port, credentials, '/gremlin', 'wss');

  return new DriverRemoteConnection(connInfo.url, { headers: connInfo.headers });
};

// ---------------------------------------------------------------------------
// Repo helpers
// ---------------------------------------------------------------------------

// Fetch all Repository vertices linked to a project via HAS_REPO edges.
const fetchRepos = async (g, projectId) => {
  const repoResults = await g
    .V()
    .has('Project', 'id', projectId)
    .out('HAS_REPO')
    .hasLabel('Repository')
    .valueMap()
    .toList();
  return repoResults.map((r) => ({
    url: getVal(r, 'url'),
    provider: getVal(r, 'provider') || 'github',
    role: getVal(r, 'role') || 'unknown',
    detectedStack: getVal(r, 'detected_stack') || '',
    addedAt: getVal(r, 'added_at') || '',
  }));
};

// Backward-compat: derive the legacy `gitRepo` field from the repos list.
const derivePrimaryRepo = (repos, legacyGitRepo) => {
  if (repos.length === 0) return legacyGitRepo || '';
  const primary = repos.find((r) => r.role === 'primary') || repos[0];
  return primary.url;
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
    .next();
  await g
    .V()
    .has('Project', 'id', projectId)
    .addE('HAS_REPO')
    .to(__.V().has('Repository', 'id', repoId))
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
    const roleEdge = await g
      .V()
      .has('Project', 'id', projectId)
      .outE('HAS_MEMBER')
      .as('e')
      .inV()
      .has('User', 'id', userId)
      .select('e')
      .by(__.valueMap())
      .next();
    const role = getVal(roleEdge.value, 'role') || 'member';
    if (role !== 'owner' && role !== 'admin') {
      return response(403, { error: 'Only project owners and admins can remove repositories' });
    }

    const repoUrl = event.queryStringParameters?.url;
    if (!repoUrl) return response(400, { error: 'url query parameter is required' });
    const decoded = decodeURIComponent(repoUrl);

    const repoExists = await g
      .V()
      .has('Project', 'id', projectId)
      .out('HAS_REPO')
      .has('Repository', 'url', decoded)
      .hasNext();
    if (!repoExists) return response(404, { error: 'Repository not found on this project' });

    await g
      .V()
      .has('Project', 'id', projectId)
      .out('HAS_REPO')
      .has('Repository', 'url', decoded)
      .drop()
      .next();

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
    const roleEdge = await g
      .V()
      .has('Project', 'id', projectId)
      .outE('HAS_MEMBER')
      .as('e')
      .inV()
      .has('User', 'id', userId)
      .select('e')
      .by(__.valueMap())
      .next();
    const role = getVal(roleEdge.value, 'role') || 'member';
    if (role !== 'owner' && role !== 'admin') {
      return response(403, { error: 'Only project owners and admins can add repositories' });
    }

    const data = JSON.parse(event.body || '{}');
    if (!data.url) return response(400, { error: 'url is required' });

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
      .next();

    await g
      .V()
      .has('Project', 'id', projectId)
      .addE('HAS_REPO')
      .to(__.V().has('Repository', 'id', newRepoId))
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

exports.handler = async (event) => {
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
    const g = traversal().withRemote(conn);

    const { httpMethod, pathParameters, body } = event;
    const projectId = pathParameters?.projectId;
    const userId = event.requestContext?.authorizer?.claims?.sub;
    const userEmail = event.requestContext?.authorizer?.claims?.email || '';

    // Route: /projects/{projectId}/repos
    const path = event.path || '';
    if (projectId && /\/repos(\/|$)/.test(path)) {
      if (!userId) return response(401, { error: 'Unauthorized' });
      return await handleReposRoute(g, response, event, projectId, userId);
    }

    switch (httpMethod) {
      case 'GET':
        if (projectId) {
          // Single project lookup - verify user is a member and return their role
          if (!userId) return response(401, { error: 'Unauthorized' });

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

          const userRole = getVal(memberEdges[0], 'role') || 'member';

          const result = await g.V().has('Project', 'id', projectId).valueMap().next();
          if (!result.value) return response(404, { error: 'Project not found' });

          const v = result.value;
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
            userRole,
            repos,
          };
          return response(200, project);
        }

        // List projects - only return projects where the current user is a member
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
          .by(__.valueMap())
          .by(__.valueMap())
          .toList();
        const projects = await Promise.all(
          results.map(async (item) => {
            const e = item instanceof Map ? item.get('e') : item.e;
            const v = item instanceof Map ? item.get('p') : item.p;
            const pid = getVal(v, 'id');
            const legacyGitRepo = getVal(v, 'git_repo');

            await ensureLegacyRepoMigrated(g, pid, legacyGitRepo);
            const repos = await fetchRepos(g, pid);

            return {
              id: pid,
              name: getVal(v, 'name'),
              gitProvider: getVal(v, 'git_provider') || 'github',
              gitRepo: derivePrimaryRepo(repos, legacyGitRepo),
              agentCli: getVal(v, 'agent_cli') || 'kiro',
              issueIntegrationEnabled: getVal(v, 'issue_integration_enabled') === 'true',
              createdAt: getVal(v, 'created_at') || new Date().toISOString(),
              userRole: getVal(e, 'role') || 'member',
              repos,
            };
          }),
        );
        return response(200, projects);

      case 'POST': {
        if (!userId) return response(401, { error: 'Unauthorized' });

        const data = JSON.parse(body);
        const id = randomUUID();
        const createdAt = new Date().toISOString();

        // Support both legacy `gitRepo` (string) and new `repos` (array) input
        const inputRepos = data.repos || [];
        const legacyGitRepo = data.gitRepo || '';

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
            .next();

          await g
            .V()
            .has('Project', 'id', id)
            .addE('HAS_REPO')
            .to(__.V().has('Repository', 'id', repoId))
            .next();

          reposOut.push({ url: repo.url, provider, role: repoRole, detectedStack: repo.detectedStack || '', addedAt });
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
        const updateEdges = await g
          .V()
          .has('Project', 'id', projectId)
          .outE('HAS_MEMBER')
          .as('e')
          .inV()
          .has('User', 'id', userId)
          .select('e')
          .by(__.valueMap())
          .toList();
        if (updateEdges.length === 0) return response(403, { error: 'Access denied' });

        const updaterRole = getVal(updateEdges[0], 'role') || 'member';
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
          vertex = g.V().has('Project', 'id', projectId);
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
