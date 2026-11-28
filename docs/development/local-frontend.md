# Local frontend development

Start with a deployed AWS backend and the [frontend dependencies installed](../getting-started/setup.md#install-dependencies). Run these commands from the repository root to work on the frontend locally:

```bash
./scripts/generate-env.sh dev
npm --prefix frontend run dev
```

This starts the Vite development server on `http://localhost:5173`, calling the deployed API, WebSocket and Yjs endpoints. `http://localhost:5173` is already in the CORS allowlist, alongside the deployment's own hostnames.

Two things to expect on a deployment with a custom domain:

- The **Admin** page reports that you are not on the canonical hostname. That is correct and intentional: the OAuth callback URLs it shows are the deployed ones, because those are what the backend actually sends to providers. Paste those, not a `localhost` variant.
- Provider OAuth flows cannot complete against a local dev server, since the provider redirects the browser to the deployed callback URL. Connect your accounts in the deployed app instead; the tokens are stored per user server-side, so your local session picks them up.
