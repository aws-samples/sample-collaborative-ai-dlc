# AI-DLC Frontend

React + TypeScript + Vite single-page application for the AI-DLC collaborative platform — where humans and AI agents build software together through a structured, graph-connected workflow.

## Prerequisites

- Node.js 22+

## Configuration

Copy the example environment file and fill in the values:

```bash
cp .env.example .env
```

Required variables (see `.env.example` for descriptions):

- `VITE_AWS_REGION`
- `VITE_AWS_USER_POOL_ID`
- `VITE_AWS_USER_POOL_CLIENT_ID`
- `VITE_API_BASE_URL`
- `VITE_WEBSOCKET_URL`
- `VITE_YJS_SERVER_URL`
- `VITE_ENVIRONMENT`

In real deployments these are derived from Terraform outputs (`terraform -chdir=terraform output`) and written automatically by `scripts/deploy-frontend.sh`.

## Commands

```bash
npm install          # install dependencies
npm run dev          # start dev server with HMR
npm run build        # typecheck + production build
npm run typecheck    # tsc -b (type checking only)
npx vitest run       # run unit tests
npm run lint         # oxlint
npm run format       # oxfmt (auto-fix)
npm run format:check # oxfmt (check only)
npm run preview      # preview production build locally
```

## More Information

See the [root README](../README.md) for full deployment instructions, prerequisites, and architecture.
