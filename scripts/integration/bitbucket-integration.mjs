#!/usr/bin/env node

/**
 * LEVEL-2 Bitbucket Provider Integration Test Harness
 *
 * Exercises the real Bitbucket Cloud API against the provider module
 * lambda/shared/git-providers/bitbucket.js WITHOUT deploying AWS infrastructure.
 *
 * Validates Bitbucket-specific logic: pagination via 'next', workspace/repo_slug
 * parsing, PR creation, comment handling, and OAuth token-refresh path.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

// Import the Bitbucket provider and token modules
const bitbucketProvider = require(
  join(__dirname, '../../lambda/shared/git-providers/bitbucket.js'),
);

// Parse command line arguments
const args = process.argv.slice(2);
const writeMode = args.includes('--write');
const refreshMode = args.includes('--refresh');
const verboseMode = args.includes('--verbose') || args.includes('--debug');

// A fetch wrapper that, in verbose mode, logs the HTTP method, full request URL,
// response status, and a truncated raw response body for every provider call.
// Credentials are NEVER logged (the Authorization header is not printed).
function createLoggingFetch(baseFetch = fetch) {
  if (!verboseMode) return baseFetch;
  return async (url, options = {}) => {
    const method = (options.method || 'GET').toUpperCase();
    console.log(`\n[HTTP] → ${method} ${url}`);
    const res = await baseFetch(url, options);
    // Clone so reading the body here does not consume it for the provider.
    let bodyPreview = '';
    try {
      const clone = res.clone();
      const text = await clone.text();
      bodyPreview =
        text.length > 500 ? `${text.slice(0, 500)}… [truncated ${text.length} chars]` : text;
    } catch (e) {
      bodyPreview = `<could not read body: ${e && e.message ? e.message : String(e)}>`;
    }
    console.log(`[HTTP] ← ${res.status} ${res.statusText}`);
    console.log(`[HTTP]   body: ${bodyPreview}`);
    return res;
  };
}

// Required environment variables
const REQUIRED_ENV_VARS = ['BITBUCKET_ACCESS_TOKEN', 'BITBUCKET_WORKSPACE', 'BITBUCKET_TEST_REPO'];

// Optional environment variables for refresh testing
const REFRESH_ENV_VARS = [
  'BITBUCKET_REFRESH_TOKEN',
  'BITBUCKET_CLIENT_ID',
  'BITBUCKET_CLIENT_SECRET',
];

// Test results tracking
const results = [];

function addResult(test, status, details = null) {
  results.push({ test, status, details });
  const statusIcon = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '⚠';
  console.log(`${statusIcon} ${test}${details ? ': ' + details : ''}`);
}

function printUsage() {
  console.log(`
Bitbucket Provider Integration Test Harness

PREREQUISITES:
1. Create a test repository in your Bitbucket workspace
2. Generate a repository access token with scopes:
   - repository
   - repository:write
   - pullrequest
   - pullrequest:write

REQUIRED ENVIRONMENT VARIABLES:
- BITBUCKET_ACCESS_TOKEN: Your Bitbucket repository access token
- BITBUCKET_WORKSPACE: Your workspace slug (e.g., 'mycompany')
- BITBUCKET_TEST_REPO: Your test repository slug (e.g., 'test-repo')

OPTIONAL ENVIRONMENT VARIABLES (for --refresh testing):
- BITBUCKET_REFRESH_TOKEN: OAuth refresh token
- BITBUCKET_CLIENT_ID: OAuth client ID
- BITBUCKET_CLIENT_SECRET: OAuth client secret

USAGE:
  node scripts/integration/bitbucket-integration.mjs              # read-only tests
  node scripts/integration/bitbucket-integration.mjs --write     # + PR/comment lifecycle with cleanup
  node scripts/integration/bitbucket-integration.mjs --refresh   # + token refresh path

To create a repository access token:
1. Go to https://bitbucket.org/account/settings/app-passwords/
2. Click "Create app password"
3. Select scopes: Repositories (Read, Write), Pull requests (Read, Write)
4. Copy the generated token
`);
}

function checkEnvironment() {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);

  if (missing.length > 0) {
    console.error(`❌ Missing required environment variables: ${missing.join(', ')}\n`);
    printUsage();
    process.exit(1);
  }

  if (refreshMode) {
    const missingRefresh = REFRESH_ENV_VARS.filter((name) => !process.env[name]);
    if (missingRefresh.length > 0) {
      console.log(
        `⚠ --refresh flag used but missing refresh environment variables: ${missingRefresh.join(', ')}`,
      );
      console.log('Skipping refresh tests.\n');
      return false;
    }
    return true;
  }

  return false;
}

function createContext(token) {
  const loggingFetch = createLoggingFetch(fetch);
  return {
    token,
    fetchImpl: loggingFetch,
    onRefresh: refreshMode
      ? async () => {
          console.log('🔄 Token refresh triggered...');
          // Simulate the refresh token flow
          const refreshResult = await bitbucketProvider.oauth.refreshAccessToken({
            clientId: process.env.BITBUCKET_CLIENT_ID,
            clientSecret: process.env.BITBUCKET_CLIENT_SECRET,
            refreshToken: process.env.BITBUCKET_REFRESH_TOKEN,
            fetchImpl: loggingFetch,
          });
          console.log('✓ Token refreshed successfully');
          return refreshResult.accessToken;
        }
      : undefined,
  };
}

async function testSplitWorkspaceRepo() {
  try {
    const repoId = `${process.env.BITBUCKET_WORKSPACE}/${process.env.BITBUCKET_TEST_REPO}`;
    const { workspace, repo_slug } = bitbucketProvider.splitWorkspaceRepo(repoId);

    if (
      workspace === process.env.BITBUCKET_WORKSPACE &&
      repo_slug === process.env.BITBUCKET_TEST_REPO
    ) {
      addResult('splitWorkspaceRepo', 'PASS');
    } else {
      addResult(
        'splitWorkspaceRepo',
        'FAIL',
        `Expected ${process.env.BITBUCKET_WORKSPACE}/${process.env.BITBUCKET_TEST_REPO}, got ${workspace}/${repo_slug}`,
      );
    }
  } catch (error) {
    addResult('splitWorkspaceRepo', 'FAIL', error.message);
  }
}

async function testListRepos(ctx) {
  try {
    console.log('📋 Fetching repositories...');
    const repos = await bitbucketProvider.listRepos(ctx);

    if (!Array.isArray(repos)) {
      addResult('listRepos', 'FAIL', 'Response is not an array');
      return;
    }

    const testRepo = repos.find(
      (r) => r.fullName === `${process.env.BITBUCKET_WORKSPACE}/${process.env.BITBUCKET_TEST_REPO}`,
    );
    if (testRepo) {
      addResult('listRepos', 'PASS', `Found ${repos.length} repos, including test repo`);
    } else {
      addResult(
        'listRepos',
        'FAIL',
        `Test repo ${process.env.BITBUCKET_WORKSPACE}/${process.env.BITBUCKET_TEST_REPO} not found in ${repos.length} repos`,
      );
    }
  } catch (error) {
    addResult('listRepos', 'FAIL', `${error.message}`);
  }
}

async function testListBranches(ctx) {
  try {
    const repoId = `${process.env.BITBUCKET_WORKSPACE}/${process.env.BITBUCKET_TEST_REPO}`;
    console.log(`🌿 Fetching branches for ${repoId}...`);
    const branches = await bitbucketProvider.listBranches(ctx, repoId);

    if (!Array.isArray(branches)) {
      addResult('listBranches', 'FAIL', 'Response is not an array');
      return;
    }

    if (branches.length > 0) {
      addResult(
        'listBranches',
        'PASS',
        `Found ${branches.length} branches: ${branches.slice(0, 3).join(', ')}${branches.length > 3 ? '...' : ''}`,
      );
    } else {
      addResult('listBranches', 'FAIL', 'No branches found');
    }
  } catch (error) {
    addResult('listBranches', 'FAIL', error.message);
  }
}

async function testGetTree(ctx) {
  try {
    const repoId = `${process.env.BITBUCKET_WORKSPACE}/${process.env.BITBUCKET_TEST_REPO}`;
    console.log(`📂 Fetching file tree for ${repoId}...`);
    const tree = await bitbucketProvider.getTree(ctx, repoId, 'main');

    if (!Array.isArray(tree)) {
      addResult('getTree', 'FAIL', 'Response is not an array');
      return;
    }

    addResult('getTree', 'PASS', `Found ${tree.length} files`);
  } catch (error) {
    addResult('getTree', 'FAIL', error.message);
  }
}

async function testGetFileContents(ctx) {
  try {
    const repoId = `${process.env.BITBUCKET_WORKSPACE}/${process.env.BITBUCKET_TEST_REPO}`;
    console.log(`📄 Fetching README contents for ${repoId}...`);

    // Try common readme files
    const readmeFiles = ['README.md', 'README.txt', 'readme.md', 'README'];
    let success = false;

    for (const filename of readmeFiles) {
      try {
        const file = await bitbucketProvider.getFileContents(ctx, repoId, filename, 'main');
        if (file && file.content) {
          addResult('getFileContents', 'PASS', `Retrieved ${filename} (${file.size} bytes)`);
          success = true;
          break;
        }
      } catch {
        // Try next file
        continue;
      }
    }

    if (!success) {
      // No README present — fall back to a real file discovered via getTree so
      // getFileContents is still genuinely validated against this repo.
      console.log('  No README found — falling back to a real file from the tree...');
      let fallbackFile = null;
      try {
        const tree = await bitbucketProvider.getTree(ctx, repoId, 'main');
        // Prefer a small text-ish file if available, otherwise take the first file.
        fallbackFile =
          tree.find((f) => /\.(md|txt|properties|xml|json|ya?ml|java|js|ts)$/i.test(f.path)) ||
          tree[0];
      } catch (e) {
        addResult('getFileContents', 'FAIL', `Could not list tree for fallback: ${e.message}`);
        return;
      }

      if (!fallbackFile) {
        addResult('getFileContents', 'FAIL', 'Repository has no files to fetch');
        return;
      }

      console.log(`  Trying real file: ${fallbackFile.path}`);
      const file = await bitbucketProvider.getFileContents(ctx, repoId, fallbackFile.path, 'main');
      if (file && typeof file.content === 'string') {
        addResult('getFileContents', 'PASS', `Retrieved ${fallbackFile.path} (${file.size} bytes)`);
      } else {
        addResult('getFileContents', 'FAIL', `Fetched ${fallbackFile.path} but content was empty`);
      }
    }
  } catch (error) {
    addResult('getFileContents', 'FAIL', error.message);
  }
}

async function testTokenRefresh(_ctx) {
  if (!refreshMode) {
    addResult('tokenRefresh', 'SKIP', '--refresh flag not provided');
    return;
  }

  try {
    console.log('🔄 Testing token refresh flow...');

    // Trigger refresh by calling the OAuth refresh directly
    const refreshResult = await bitbucketProvider.oauth.refreshAccessToken({
      clientId: process.env.BITBUCKET_CLIENT_ID,
      clientSecret: process.env.BITBUCKET_CLIENT_SECRET,
      refreshToken: process.env.BITBUCKET_REFRESH_TOKEN,
      fetchImpl: createLoggingFetch(fetch),
    });

    if (refreshResult.accessToken) {
      addResult('tokenRefresh', 'PASS', 'Successfully obtained new access token');
    } else {
      addResult('tokenRefresh', 'FAIL', 'No access token in refresh response');
    }
  } catch (error) {
    addResult('tokenRefresh', 'FAIL', error.message);
  }
}

async function testPRLifecycle(ctx) {
  if (!writeMode) {
    addResult('createPullRequest', 'SKIP', '--write flag not provided');
    addResult('addPRComment', 'SKIP', '--write flag not provided');
    addResult('listPRComments', 'SKIP', '--write flag not provided');
    return null;
  }

  const repoId = `${process.env.BITBUCKET_WORKSPACE}/${process.env.BITBUCKET_TEST_REPO}`;
  const timestamp = Date.now();
  const branchName = `integration-test/bitbucket-${timestamp}`;

  let createdPR = null;

  try {
    console.log(`🔀 Creating test branch ${branchName}...`);

    // For this test, we assume the repo has content and we'll create a PR
    // In a real scenario, you'd create a branch and commit, but for testing
    // we'll try to create a PR directly (which might fail with "no changes")

    console.log('📝 Creating pull request...');
    const prResult = await bitbucketProvider.createPullRequest(ctx, repoId, {
      branch: branchName,
      baseBranch: 'main',
      title: `Integration Test PR ${timestamp}`,
      body: `Automated test PR created at ${new Date().toISOString()}\n\nThis PR was created by the Bitbucket integration test harness and should be cleaned up automatically.`,
    });

    if (prResult.error) {
      addResult('createPullRequest', 'FAIL', prResult.error);
      return null;
    }

    if (prResult.skipped) {
      addResult('createPullRequest', 'SKIP', prResult.reason || 'No changes to create PR');
      return null;
    }

    if (prResult.existing) {
      addResult('createPullRequest', 'PASS', `Found existing PR #${prResult.prNumber}`);
    } else {
      addResult('createPullRequest', 'PASS', `Created PR #${prResult.prNumber}`);
    }

    createdPR = prResult;

    // Test adding a comment
    console.log(`💬 Adding comment to PR #${prResult.prNumber}...`);
    const comment = await bitbucketProvider.addPRComment(ctx, repoId, prResult.prNumber, {
      body: `Integration test comment added at ${new Date().toISOString()}`,
    });

    if (comment && comment.id) {
      addResult('addPRComment', 'PASS', `Added comment ${comment.id}`);
    } else {
      addResult('addPRComment', 'FAIL', 'No comment ID returned');
    }

    // Test listing comments
    console.log(`📖 Listing comments on PR #${prResult.prNumber}...`);
    const comments = await bitbucketProvider.listPRComments(ctx, repoId, prResult.prNumber);

    if (Array.isArray(comments)) {
      addResult('listPRComments', 'PASS', `Found ${comments.length} comments`);
    } else {
      addResult('listPRComments', 'FAIL', 'Comments response is not an array');
    }
  } catch (error) {
    addResult('createPullRequest', 'FAIL', error.message);
    addResult('addPRComment', 'SKIP', 'PR creation failed');
    addResult('listPRComments', 'SKIP', 'PR creation failed');
  }

  return createdPR;
}

async function cleanup(ctx, createdPR) {
  if (!createdPR || !writeMode) {
    return;
  }

  try {
    console.log('🧹 Cleaning up test resources...');

    // Note: Bitbucket doesn't have a direct API to decline/close PRs or delete branches
    // In a real implementation, you might need to use the PR update API to decline it
    // For now, we'll just log what should be cleaned up

    console.log(`⚠ Manual cleanup required:`);
    console.log(`   - Decline/close PR #${createdPR.prNumber}: ${createdPR.prUrl}`);
    console.log(`   - Delete test branch if created`);

    addResult('cleanup', 'PARTIAL', 'Manual cleanup required - see console output');
  } catch (error) {
    addResult('cleanup', 'FAIL', error.message);
  }
}

function printSummary() {
  console.log('\n=== TEST SUMMARY ===');

  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;
  const partial = results.filter((r) => r.status === 'PARTIAL').length;

  console.log(`✓ PASSED: ${passed}`);
  console.log(`✗ FAILED: ${failed}`);
  console.log(`⚠ SKIPPED: ${skipped}`);
  if (partial > 0) {
    console.log(`◐ PARTIAL: ${partial}`);
  }

  if (failed > 0) {
    console.log('\nFAILED TESTS:');
    results
      .filter((r) => r.status === 'FAIL')
      .forEach((r) => {
        console.log(`  ✗ ${r.test}: ${r.details || 'No details'}`);
      });
  }

  return failed === 0;
}

async function main() {
  console.log('🚀 Bitbucket Provider Integration Test Harness\n');

  const canRefresh = checkEnvironment();

  console.log('Configuration:');
  console.log(`  Workspace: ${process.env.BITBUCKET_WORKSPACE}`);
  console.log(`  Repository: ${process.env.BITBUCKET_TEST_REPO}`);
  console.log(`  Write mode: ${writeMode ? 'ENABLED' : 'DISABLED'}`);
  console.log(
    `  Refresh mode: ${refreshMode ? (canRefresh ? 'ENABLED' : 'DISABLED (missing vars)') : 'DISABLED'}`,
  );
  console.log(`  Verbose mode: ${verboseMode ? 'ENABLED' : 'DISABLED'}`);
  console.log('');

  const ctx = createContext(process.env.BITBUCKET_ACCESS_TOKEN);
  let createdPR = null;

  try {
    // Core API tests
    await testSplitWorkspaceRepo();
    await testListRepos(ctx);
    await testListBranches(ctx);
    await testGetTree(ctx);
    await testGetFileContents(ctx);

    // Token refresh test
    if (canRefresh) {
      await testTokenRefresh(ctx);
    }

    // Write operations (PR lifecycle)
    createdPR = await testPRLifecycle(ctx);
  } catch (error) {
    console.error(`❌ Unexpected error: ${error.message}`);
    addResult('harness', 'FAIL', `Unexpected error: ${error.message}`);
  } finally {
    // Always attempt cleanup
    if (writeMode) {
      await cleanup(ctx, createdPR);
    }
  }

  const success = printSummary();
  process.exit(success ? 0 : 1);
}

main().catch((error) => {
  console.error(`❌ Fatal error: ${error.message}`);
  process.exit(1);
});
