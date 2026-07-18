FROM public.ecr.aws/docker/library/node:24.15.0-slim@sha256:03eae3ef7e88a9de535496fb488d67e02b9d96a063a8967bae657744ecd513f2

RUN apt-get update -o Acquire::AllowInsecureRepositories=true -o Acquire::AllowDowngradeToInsecureRepositories=true \
    && apt-get install -y --no-install-recommends --allow-unauthenticated ca-certificates gnupg \
    && apt-get update \
    && apt-get install -y --no-install-recommends git curl unzip jq uuid-runtime procps \
    && rm -rf /var/lib/apt/lists/*

# Install AWS CLI (architecture-aware: x86_64 or aarch64)
RUN ARCH="$(uname -m)" \
    && curl "https://awscli.amazonaws.com/awscli-exe-linux-${ARCH}.zip" -o "awscliv2.zip" \
    && unzip awscliv2.zip \
    && ./aws/install \
    && rm -rf awscliv2.zip aws

# ---------------------------------------------------------------------------
# Install agent CLIs — all are installed in every image; the active CLI is
# selected at runtime via the AGENT_CLI environment variable (default: kiro).
# ---------------------------------------------------------------------------

# Kiro CLI (AWS Kiro — API key authentication)
# Kiro ships multiple binaries under $HOME/.local/bin (kiro-cli launcher plus
# kiro-cli-chat and kiro-cli-term that it spawns at runtime). Copy the whole
# bin directory so the image does not break silently if Kiro adds a new
# companion binary in a future release.
RUN curl -fsSL https://cli.kiro.dev/install | bash \
    && mkdir -p /opt/kiro \
    && cp -a /root/.local/bin /opt/kiro/bin \
    && ln -sf /opt/kiro/bin/kiro-cli /usr/local/bin/kiro-cli \
    && rm -rf /root/.local

# Claude Agent ACP — ACP adapter for Claude Agent SDK (Anthropic/Bedrock auth)
RUN npm install -g @zed-industries/claude-agent-acp

# OpenCode CLI (OpenCode — AWS Bedrock authentication)
RUN npm install -g opencode-ai

# uv + managed Python 3.12 (Astral) — required for Python-based MCP servers
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
    && mv /root/.local/bin/uv /root/.local/bin/uvx /usr/local/bin/ \
    && rm -rf /root/.local \
    && mkdir -p "$UV_PYTHON_INSTALL_DIR" \
    && uv python install 3.12 \
    && ln -sf "$(uv python find 3.12)" /usr/local/bin/python \
    && ln -sf "$(uv python find 3.12)" /usr/local/bin/python3 \
    && chmod -R a+rX "$UV_PYTHON_INSTALL_DIR"

# Embed AI-DLC workflow rules
COPY agents-ecs/aidlc-rules /opt/aidlc-rules

# Install MCP server
COPY agents-ecs/mcp-server-graph/package.json agents-ecs/mcp-server-graph/index.js agents-ecs/mcp-server-graph/merge-task-branches.js agents-ecs/mcp-server-graph/create-repo-prs.js agents-ecs/mcp-server-graph/git-providers.js /opt/mcp-server-graph/
# Single-sourced git-provider registry (shared/git-providers). Copied into the
# MCP server package so its ./git-providers shim resolves ./shared/git-providers.
COPY shared/git-providers.js /opt/mcp-server-graph/shared/git-providers.js
COPY shared/git-providers/ /opt/mcp-server-graph/shared/git-providers/
RUN cd /opt/mcp-server-graph && npm install --production

# Install ACP client (includes drivers)
COPY agents-ecs/package.json /opt/acp-client/package.json
RUN cd /opt/acp-client && npm install --production

ARG IMAGE_TAG=latest
ENV IMAGE_TAG=${IMAGE_TAG}

COPY agents-ecs/acp-client.js agents-ecs/pool-worker.js agents-ecs/branch-cleanup.js agents-ecs/construction-orchestrator-prompt.js /opt/acp-client/
COPY agents-ecs/drivers/ /opt/acp-client/drivers/
COPY shared/mcp-validator.js /opt/shared/mcp-validator.js
COPY shared/git-providers.js /opt/shared/git-providers.js
COPY shared/git-providers/ /opt/shared/git-providers/
COPY shared/git-token-refresh.js /opt/shared/git-token-refresh.js

# The shared modules under /opt/shared are required by pool-worker.js (which
# lives in /opt/acp-client). Node resolves a module's OWN transitive requires
# relative to that module's directory, so git-token-refresh.js's
# `require('@aws-sdk/client-lambda')` looks in /opt/shared/node_modules — which
# does not exist, crashing every worker at startup with MODULE_NOT_FOUND.
# Symlink the acp-client's installed deps so shared files resolve the same
# node_modules tree (@aws-sdk/client-lambda et al. live there already).
RUN ln -s /opt/acp-client/node_modules /opt/shared/node_modules

RUN mkdir -p /workspace \
    && chown -R node:node /workspace /opt/aidlc-rules /opt/mcp-server-graph /opt/acp-client /opt/kiro

WORKDIR /workspace

COPY --chown=node:node agents-ecs/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER node
ENV HOME=/home/node \
    PATH=/opt/kiro/bin:/usr/local/bin:/usr/bin:/bin \
    UV_PYTHON_INSTALL_DIR=/opt/uv-python

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD pgrep -f "node /opt/acp-client/pool-worker.js" > /dev/null || exit 1

ENTRYPOINT ["/entrypoint.sh"]
