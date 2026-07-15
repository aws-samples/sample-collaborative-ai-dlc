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

# Base tools: git (workspace checkout), curl/unzip (CLI installs), jq, procps,
# python3 (bare-`python`/`python3` MCP servers; `python`→`python3` symlink so
# both resolve — uv/uvx manage their own Python separately).
RUN apt-get update -o Acquire::AllowInsecureRepositories=true \
    && apt-get install -y --no-install-recommends --allow-unauthenticated ca-certificates gnupg \
    && apt-get update \
    && apt-get install -y --no-install-recommends git curl unzip jq procps python3 \
    && ln -sf /usr/bin/python3 /usr/local/bin/python \
    && rm -rf /var/lib/apt/lists/*

# Agent CLIs — installed for all supported drivers; selectCli picks what's
# present at runtime. Kiro (API-key auth), Claude Code + OpenCode (Bedrock).
RUN curl -fsSL https://cli.kiro.dev/install | bash \
    && mkdir -p /opt/kiro \
    && cp -a /root/.local/bin /opt/kiro/bin \
    && ln -sf /opt/kiro/bin/kiro-cli /usr/local/bin/kiro-cli \
    && rm -rf /root/.local
RUN npm install -g @anthropic-ai/claude-code
ARG OPENCODE_VERSION=1.17.20
RUN mkdir -p /opt/opencode/bin \
    && curl -fsSL "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-arm64.tar.gz" \
    | tar -xz -C /opt/opencode/bin \
    && chmod +x /opt/opencode/bin/opencode \
    && /opt/opencode/bin/opencode --version | grep -F "${OPENCODE_VERSION}"

# Bun — the runtime the deterministic CODE sensors (linter, type-check) run on.
# They shell out to `bunx eslint`/`bunx tsc` against the workspace checkout, so
# the binary must be on PATH for the script-kind sensor runner. Document-shape
# sensors run in-process (no bun) — this is only for the code-quality axis.
RUN curl -fsSL https://bun.sh/install | bash \
    && mkdir -p /opt/bun \
    && cp -a /root/.bun/bin /opt/bun/bin \
    && ln -sf /opt/bun/bin/bun /usr/local/bin/bun \
    && ln -sf /opt/bun/bin/bunx /usr/local/bin/bunx \
    && rm -rf /root/.bun

# uv / uvx — the standard launcher for Python-based MCP servers (e.g.
# `uvx mcp-server-fetch`). Custom MCP servers configured per-project/globally
# may reference it, and the mcp-validator allows `uv`/`uvx` as bare commands, so
# the binaries must be on PATH. Same install→/opt→symlink pattern as Kiro/bun.
# UV_NO_MODIFY_PATH: we set PATH explicitly below; skip the installer's shell
# profile edits (noise/failure in a non-interactive image build).
RUN curl -LsSf https://astral.sh/uv/install.sh \
    | env UV_INSTALL_DIR=/opt/uv/bin UV_NO_MODIFY_PATH=1 sh \
    && ln -sf /opt/uv/bin/uv /usr/local/bin/uv \
    && ln -sf /opt/uv/bin/uvx /usr/local/bin/uvx

# Install the agentcore package deps (its own package.json — isolated).
COPY agentcore/package.json /opt/agentcore/package.json
RUN cd /opt/agentcore && npm install --omit=dev

# App code: the agentcore package + the shared/ helpers it imports via ../shared.
COPY agentcore/ /opt/agentcore/
COPY shared/ /opt/shared/

# The shared/ helpers are CommonJS loaded from /opt/shared, so Node resolves their
# @aws-sdk deps upward from /opt/shared — never into /opt/agentcore/node_modules
# where they are installed. Symlink so the shared helpers see the same deps.
RUN ln -s /opt/agentcore/node_modules /opt/shared/node_modules

# /mnt/workspace is the AgentCore managed-session-storage mount (present only at
# invocation time). Create a fallback dir for local/non-AgentCore runs; chown so
# the node user can write the checkout + CLI stores when the mount is absent.
RUN mkdir -p /mnt/workspace \
    && chown -R node:node /mnt/workspace /opt/agentcore /opt/shared /opt/kiro /opt/opencode /opt/bun /opt/uv

WORKDIR /mnt/workspace
USER node
# CLI conversation-store placement (for park/resume durability):
#  - Claude: plain JSONL — CLAUDE_CONFIG_DIR points straight at the persistent
#    mount; append-only file needs no locking, works on the mount directly.
#  - Kiro: SQLite — the managed mount does NOT provide the fcntl byte-range
#    locking SQLite needs ("database is locked" on open). So XDG_DATA_HOME stays
#    on EPHEMERAL local disk where locking works, and run-stage syncs the single
#    data.sqlite3* store file between the mount (V2_KIRO_STORE_DIR, durable) and
#    local XDG around each Kiro spawn so a resume after a microVM reap still
#    recalls the conversation. See cli/kiro-store.js.
#  - OpenCode: SQLite — the same copy protocol, but its XDG override is applied
#    only to OpenCode children so Kiro's global XDG placement is unchanged.
ENV HOME=/home/node \
    PATH=/opt/kiro/bin:/opt/opencode/bin:/opt/bun/bin:/opt/uv/bin:/usr/local/bin:/usr/bin:/bin \
    V2_WORKSPACE_DIR=/mnt/workspace \
    CLAUDE_CONFIG_DIR=/mnt/workspace/.claude \
    XDG_DATA_HOME=/home/node/.kiro-data \
    V2_KIRO_STORE_DIR=/mnt/workspace/.kiro-data \
    OPENCODE_XDG_DATA_HOME=/home/node/.opencode-data \
    V2_OPENCODE_STORE_DIR=/mnt/workspace/.opencode-data \
    OPENCODE_DISABLE_AUTOUPDATE=1 \
    V2_MCP_ENTRY=/opt/agentcore/mcp/index.js

# The AgentCore managed-session-storage mount (/mnt/workspace) is owned by a uid
# that differs from the node user, so git refuses to operate on the checkout
# ("detected dubious ownership"). Mark all workspace checkouts safe. A wildcard
# (not a single path) is required because multi-repo intents clone into
# /mnt/workspace/<owner>/<repo> subdirs, each of which trips the per-repo check.
# Written as the node user so it lands in this user's global ~/.gitconfig.
RUN git config --global --add safe.directory '*'

# AgentCore Runtime contract: listen on 8080. /ping is the health surface.
EXPOSE 8080

ENTRYPOINT ["node", "/opt/agentcore/http-server.js"]
