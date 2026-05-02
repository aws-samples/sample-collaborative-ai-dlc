# Git Integration

AIDLC Collaborative integrates with GitHub for repository management, issue creation, and status syncing.

## Connecting GitHub

There are two ways to connect:

### Personal access token (PAT)

Set `GITHUB_TOKEN` in your `.env.local` file:

```bash
GITHUB_TOKEN=ghp_your_token_here
```

This is the simplest option for local development.

### OAuth flow

Configure GitHub OAuth credentials in `.env.local`:

```bash
GITHUB_OAUTH_CLIENT_ID=your_client_id
GITHUB_OAUTH_CLIENT_SECRET=your_client_secret
```

Then connect through the Settings page in the UI. The OAuth flow gives per-project token management.

!!! info "NEED IMAGE HERE"
    Screenshot of the Settings page showing the GitHub connection section with OAuth or PAT configuration.

## Adding repositories to a project

1. Navigate to your project page
2. Open the Git section
3. Add a repository by entering its GitHub URL (for example, `https://github.com/owner/repo`)

The repository is cloned into the workspace and becomes available to the LLM assistant and agents.

## Local repositories

You can also link local git repositories on the server machine:

1. Choose **Browse** to open a folder picker
2. Select a folder that contains a `.git` directory
3. The local repo is linked by path (no cloning needed)

Local repos are useful during development when you want agents to work on the same codebase you are working on.

!!! info "NEED IMAGE HERE"
    Screenshot of the project page showing the Git section with a list of connected repositories.

## Spec-scoped repos

You can assign specific repos to a spec. This tells the system:

- Which repos the LLM assistant should focus on
- Which repos the decompose step should target
- Where agents should create worktrees

For each spec-repo association, you configure:

- **Base branch** (for example, `main`)
- **Feature branch pattern** (for example, `feature/{specSlug}/{taskSlug}`)

## Pushing tasks as GitHub Issues

After decomposing a spec:

1. Choose **Create Issues** in the decompose view
2. Select the target repository
3. Tasks are created as GitHub Issues in topological order (dependencies first)

Each issue includes:

- The task title and description
- Acceptance criteria as a checklist
- Test requirements
- Dependencies listed as issue references
- A complexity label (for example, `complexity:M`)

!!! info "NEED IMAGE HERE"
    Screenshot of the decompose view showing the Create Issues button and GitHub issue mappings after creation.

## Syncing issue status

After issues are created, you can sync their status from GitHub. This updates the task status in AIDLC Collaborative based on whether the GitHub issue is open, closed, or has a linked pull request.
