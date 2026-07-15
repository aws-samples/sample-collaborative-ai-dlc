# Bitbucket Provider Integration Tests

This directory contains LEVEL-2 integration tests for the Bitbucket provider that exercise real Bitbucket Cloud API endpoints without deploying AWS infrastructure.

## Prerequisites

### 1. Test Repository Setup

Create a test repository in your Bitbucket workspace that will be used for integration testing. This repository should:

- Have at least one branch (preferably `main` with some content)
- Be accessible with the access token you'll generate
- Contain at least a README file for file content tests

### 2. Access Token Generation

Generate a Bitbucket repository access token (App Password):

1. Go to https://bitbucket.org/account/settings/app-passwords/
2. Click "Create app password"
3. Give it a descriptive name (e.g., "Integration Tests")
4. Select the following scopes:
   - **Repositories**: Read, Write
   - **Pull requests**: Read, Write
5. Click "Create" and copy the generated token immediately (it won't be shown again)

### 3. OAuth Credentials (Optional)

For testing the token refresh functionality, you'll need OAuth application credentials:

1. Go to https://bitbucket.org/account/settings/oauth/
2. Create or use an existing OAuth consumer
3. Note the client ID and client secret
4. Obtain a refresh token through the OAuth flow

## Environment Variables

### Required Variables

These must be set for any test run:

```bash
export BITBUCKET_ACCESS_TOKEN="your_app_password_here"
export BITBUCKET_WORKSPACE="your_workspace_slug"
export BITBUCKET_TEST_REPO="your_test_repo_slug"
```

### Optional Variables (for --refresh testing)

These are only needed if you want to test the token refresh functionality:

```bash
export BITBUCKET_REFRESH_TOKEN="your_oauth_refresh_token"
export BITBUCKET_CLIENT_ID="your_oauth_client_id"
export BITBUCKET_CLIENT_SECRET="your_oauth_client_secret"
```

## Usage

### Read-Only Tests (Default)

Tests non-mutating operations only: listRepos, listBranches, getTree, getFileContents.

```bash
node scripts/integration/bitbucket-integration.mjs
```

### Write Tests

Includes mutating operations: creates a test PR, adds comments, then attempts cleanup.
**Warning**: This creates temporary resources in your repository.

```bash
node scripts/integration/bitbucket-integration.mjs --write
```

### Token Refresh Tests

Tests the OAuth token refresh functionality (requires OAuth environment variables).

```bash
node scripts/integration/bitbucket-integration.mjs --refresh
```

### Combined Tests

You can combine flags to test everything:

```bash
node scripts/integration/bitbucket-integration.mjs --write --refresh
```

## What Gets Tested

### Core Provider Interface

- `splitWorkspaceRepo()` - workspace/repo_slug parsing
- `listRepos()` - repository listing with pagination
- `listBranches()` - branch enumeration
- `getTree()` - recursive file tree traversal
- `getFileContents()` - file content retrieval

### Pull Request Lifecycle (--write mode)

- `createPullRequest()` - PR creation with conflict detection
- `addPRComment()` - comment addition
- `listPRComments()` - comment enumeration

### OAuth Token Management (--refresh mode)

- `oauth.refreshAccessToken()` - token refresh flow

## Safety Features

### Read-Only by Default

The harness runs in read-only mode by default to prevent accidental changes to your repository.

### Automatic Cleanup

In write mode, the harness attempts to clean up any test resources it creates:

- Temporary test branches
- Test pull requests
- Test comments

**Note**: Bitbucket's API has limited cleanup capabilities. Some manual cleanup may be required after write tests.

### Clear Logging

All operations are logged with clear indicators of what's happening and what resources are being created or modified.

## Output Format

The harness provides:

- Real-time progress indicators with ✓/✗/⚠ symbols
- Detailed error messages with HTTP status codes and API responses
- Final summary with pass/fail counts
- Non-zero exit code if any test fails

## Troubleshooting

### Authentication Errors

- Verify your access token has the required scopes
- Check that the workspace and repository names are correct
- Ensure the repository exists and is accessible

### Permission Errors

- Verify write permissions if using --write mode
- Check repository settings for pull request creation permissions

### API Rate Limits

- Bitbucket has API rate limits that may affect test runs
- Wait and retry if you encounter rate limit errors

## Integration with CI/CD

This harness is designed to be CI/CD friendly:

- Exits with appropriate status codes
- Uses environment variables for configuration
- Provides structured output for test reporting
- No interactive prompts or user input required
