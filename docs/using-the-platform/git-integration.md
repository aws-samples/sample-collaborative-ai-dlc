# Git Integration

AIDLC Collaborative integrates with GitHub for repository management, issue creation, and status syncing.

## Configure GitHub OAuth

Create a [GitHub OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app) and
store the credentials:

```bash
aws secretsmanager update-secret \
  --secret-id collaborative-ai-dlc-dev-github-oauth \
  --secret-string '{"client_id":"your_client_id","client_secret":"your_client_secret"}'
```

Set the **Authorization callback URL** to your CloudFront domain followed by `/api/auth/callback/github`.

## Selecting a git repo

1. Click "Create new Project" in the project overview screen
2. The platform will check if you're connected to GitHub
3. Select the repository that should back this new project

The repository is cloned into the workspace and becomes available to the LLM assistant and agents.

Local repos are useful during development when you want agents to work on the same codebase you are working on.

## Reviews

The platform will create a pull request once it is finished with the construction phase. You can start a review. The
platform will store review results as a comment on the pull request.