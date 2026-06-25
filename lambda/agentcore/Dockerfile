# Bedrock AgentCore Runtime image for AI-DLC v2 stage execution.
#
# AgentCore Runtime requires an ARM64 container that listens on 0.0.0.0:8080 and
# serves GET /ping + POST /invocations (see http-server.js). The same session id
# routes to the same microVM, so the git checkout from init-ws persists across
# run-stage invocations.
#
# Build context is the repo `lambda/` dir (so the image can COPY both the
# agentcore package and the shared/ helpers it imports via ../shared).
FROM public.ecr.aws/docker/library/node:24.15.0-slim

# Base tools: git (workspace checkout), curl/unzip (CLI installs), jq, procps.
RUN apt-get update -o Acquire::AllowInsecureRepositories=true \
    && apt-get install -y --no-install-recommends --allow-unauthenticated ca-certificates gnupg \
    && apt-get update \
    && apt-get install -y --no-install-recommends git curl unzip jq procps \
    && rm -rf /var/lib/apt/lists/*

# Agent CLIs — installed for both supported drivers; selectCli picks what's
# present at runtime. Kiro (API-key auth) + Claude Code (Bedrock auth).
RUN curl -fsSL https://cli.kiro.dev/install | bash \
    && mkdir -p /opt/kiro \
    && cp -a /root/.local/bin /opt/kiro/bin \
    && ln -sf /opt/kiro/bin/kiro-cli /usr/local/bin/kiro-cli \
    && rm -rf /root/.local
RUN npm install -g @anthropic-ai/claude-code

# Install the agentcore package deps (its own package.json — isolated).
COPY agentcore/package.json /opt/agentcore/package.json
RUN cd /opt/agentcore && npm install --omit=dev

# App code: the agentcore package + the shared/ helpers it imports via ../shared.
COPY agentcore/ /opt/agentcore/
COPY shared/ /opt/shared/

RUN mkdir -p /workspace && chown -R node:node /workspace /opt/agentcore /opt/shared /opt/kiro

WORKDIR /workspace
USER node
ENV HOME=/home/node \
    PATH=/opt/kiro/bin:/usr/local/bin:/usr/bin:/bin \
    V2_WORKSPACE_DIR=/workspace \
    V2_MCP_ENTRY=/opt/agentcore/mcp/index.js

# AgentCore Runtime contract: listen on 8080. /ping is the health surface.
EXPOSE 8080

ENTRYPOINT ["node", "/opt/agentcore/http-server.js"]
