# Git Integration

AIDLC Collaborative integrates with GitHub for repository management, issue creation, and status syncing.

## Configure GitHub OAuth

[Create a GitHub **OAuth App**](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app) (not a GitHub App — the flow here expects OAuth App semantics). When prompted, use:

- **Homepage URL**: `https://$(terraform -chdir=terraform output -raw cloudfront_domain_name)`
- **Authorization callback URL**: `https://$(terraform -chdir=terraform output -raw cloudfront_domain_name)/github/callback`

Then store the OAuth App's credentials in the Secrets Manager secret that terraform created (replace `your_github_client_id` and `your_github_client_secret` with the actual values):

```bash
aws secretsmanager put-secret-value \
  --secret-id $(terraform -chdir=terraform output -raw github_oauth_secret_name) \
  --secret-string '{"client_id":"your_github_client_id","client_secret":"your_github_client_secret"}'
```

## Selecting a git repo

1. Click "Create new Project" in the project overview screen
2. The platform will check if you're connected to GitHub
3. Select the repository that should back this new project

The repository is cloned into the workspace and becomes available to the LLM assistant and agents.

Local repos are useful during development when you want agents to work on the same codebase you are working on.

## Reviews

The platform will create a pull request once it is finished with the construction phase. You can start a review. The
platform will store review results as a comment on the pull request.