# Bedrock AgentCore Runtime image for AI-DLC v2 stage execution.
#
# AgentCore Runtime requires an ARM64 container that listens on 0.0.0.0:8080 and
# serves GET /ping + POST /invocations (see http-server.js). The same session id
# routes to the same microVM, so the git checkout from init-ws persists across
# run-stage invocations.
#
# Build context is the repo `lambda/` dir (so the image can COPY both the
# agentcore package and the shared/ helpers it imports via ../shared).
FROM public.ecr.aws/docker/library/node:24.19.0-slim@sha256:be8929e08ae137e81b5e1edba02259e6c4cb2f5ad655092bb9f56b97e41c4536

# Base tools: git (workspace checkout), curl/unzip (CLI installs), jq, procps,
# python3 (bare-`python`/`python3` MCP servers; `python`→`python3` symlink so
# both resolve — uv/uvx manage their own Python separately).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git curl unzip jq procps python3 \
    && ln -sf /usr/bin/python3 /usr/local/bin/python \
    && rm -rf /var/lib/apt/lists/*

# Agent CLIs — installed for all supported drivers; selectCli picks what's
# present at runtime. Kiro (API-key auth), Claude Code + OpenCode + Codex
# (Bedrock).
ARG KIRO_CLI_VERSION=2.19.2
ARG KIRO_CLI_SHA256=84df9ddcf02156d9563910850c7a07805ea41cf6a32bc30438741878f10a5af5
RUN curl -fsSLo /tmp/kiro-cli.zip \
        "https://prod.download.cli.kiro.dev/stable/${KIRO_CLI_VERSION}/kirocli-aarch64-linux-musl.zip" \
    && echo "${KIRO_CLI_SHA256}  /tmp/kiro-cli.zip" | sha256sum -c - \
    && unzip -q /tmp/kiro-cli.zip -d /tmp/kiro-cli \
    && KIRO_CLI_SKIP_SETUP=1 /tmp/kiro-cli/kirocli/install.sh \
    && mkdir -p /opt/kiro \
    && cp -a /root/.local/bin /opt/kiro/bin \
    && ln -sf /opt/kiro/bin/kiro-cli /usr/local/bin/kiro-cli \
    && kiro-cli --version | grep -F "${KIRO_CLI_VERSION}" \
    && rm -rf /root/.local /tmp/kiro-cli /tmp/kiro-cli.zip
ARG CLAUDE_CODE_VERSION=2.1.246
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && claude --version | grep -F "${CLAUDE_CODE_VERSION}" \
    && npm cache clean --force
ARG OPENCODE_VERSION=1.17.20
ARG OPENCODE_SHA256=0a41572e83a896eb008683589dfe09e17b941d06122608510f3e5f16d86d9afc
RUN mkdir -p /opt/opencode/bin \
    && curl -fsSLo /tmp/opencode.tar.gz \
        "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-arm64.tar.gz" \
    && echo "${OPENCODE_SHA256}  /tmp/opencode.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/opencode.tar.gz -C /opt/opencode/bin \
    && chmod +x /opt/opencode/bin/opencode \
    && /opt/opencode/bin/opencode --version | grep -F "${OPENCODE_VERSION}" \
    && rm -f /tmp/opencode.tar.gz
# Codex — pinned for reproducibility (the npm package ships the arm64 binary).
# The per-stage CODEX_HOME (config.toml) is materialized at run time; the
# version assert catches a broken/mismatched install at build time.
ARG CODEX_VERSION=0.145.0
RUN npm install -g @openai/codex@${CODEX_VERSION} \
    && codex --version | grep -F "${CODEX_VERSION}" \
    && npm cache clean --force

# Bun — the runtime the deterministic CODE sensors (linter, type-check) run on.
# They shell out to `bunx eslint`/`bunx tsc` against the workspace checkout, so
# the binary must be on PATH for the script-kind sensor runner. Document-shape
# sensors run in-process (no bun) — this is only for the code-quality axis.
ARG BUN_VERSION=1.4.0
ARG BUN_SHA256=4b1a332ee861983eb93bcfe6f770fff94e3e31b2c388bdaea3c8ed35e58eed0e
RUN mkdir -p /opt/bun/bin \
    && curl -fsSLo /tmp/bun.zip \
        "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-aarch64.zip" \
    && echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum -c - \
    && unzip -q /tmp/bun.zip -d /tmp/bun \
    && install -m 0755 /tmp/bun/bun-linux-aarch64/bun /opt/bun/bin/bun \
    && ln -sf /opt/bun/bin/bun /opt/bun/bin/bunx \
    && ln -sf /opt/bun/bin/bun /usr/local/bin/bun \
    && ln -sf /opt/bun/bin/bunx /usr/local/bin/bunx \
    && bun --version | grep -Fx "${BUN_VERSION}" \
    && rm -rf /tmp/bun /tmp/bun.zip

# uv / uvx — the standard launcher for Python-based MCP servers (e.g.
# `uvx mcp-server-fetch`). Custom MCP servers configured per-project/globally
# may reference it, and the mcp-validator allows `uv`/`uvx` as bare commands, so
# the binaries must be on PATH.
ARG UV_VERSION=0.12.6
ARG UV_SHA256=d58030acd26159499ac82f32da12d1b3c12a3a1bfc414232d9082070c03e128d
RUN mkdir -p /opt/uv/bin \
    && curl -fsSLo /tmp/uv.tar.gz \
        "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-aarch64-unknown-linux-gnu.tar.gz" \
    && echo "${UV_SHA256}  /tmp/uv.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/uv.tar.gz -C /tmp \
    && install -m 0755 /tmp/uv-aarch64-unknown-linux-gnu/uv /opt/uv/bin/uv \
    && install -m 0755 /tmp/uv-aarch64-unknown-linux-gnu/uvx /opt/uv/bin/uvx \
    && ln -sf /opt/uv/bin/uv /usr/local/bin/uv \
    && ln -sf /opt/uv/bin/uvx /usr/local/bin/uvx \
    && uv --version | grep -F "uv ${UV_VERSION}" \
    && rm -rf /tmp/uv-aarch64-unknown-linux-gnu /tmp/uv.tar.gz

# Pre-create the application directories before COPY --chmod writes into them.
# Otherwise BuildKit may apply a file's 0644 mode to an auto-created parent,
# making /opt/agentcore non-traversable. Create the local workspace fallback and
# ephemeral CLI-state directories here too, with their final ownership, so no
# recursive chown layer is needed later.
RUN install -d -o node -g node -m 0755 \
    /opt/agentcore \
    /opt/shared \
    /mnt/workspace \
    /home/node/.codex-state \
    /home/node/.codex-runs

# Install the agentcore package deps (its own package.json — isolated).
COPY --chown=node:node --chmod=0644 agentcore/package.json /opt/agentcore/package.json
RUN cd /opt/agentcore \
    && npm install --omit=dev \
    && npm cache clean --force

# App code: the agentcore package + the shared/ helpers it imports via ../shared.
COPY --chown=node:node agentcore/ /opt/agentcore/
COPY --chown=node:node shared/ /opt/shared/

# The shared/ helpers are CommonJS loaded from /opt/shared, so Node resolves their
# @aws-sdk deps upward from /opt/shared — never into /opt/agentcore/node_modules
# where they are installed. Symlink so the shared helpers see the same deps.
RUN ln -s /opt/agentcore/node_modules /opt/shared/node_modules

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
#  - Codex: CODEX_HOME stays on EPHEMERAL local disk. run-stage restores and
#    atomically persists only the active thread's rollout JSONL under
#    V2_CODEX_STORE_DIR; config, SQLite state, and non-resumable sessions never
#    touch the managed mount. See cli/codex-store.js.
ENV HOME=/home/node \
    PATH=/opt/kiro/bin:/opt/opencode/bin:/opt/bun/bin:/opt/uv/bin:/usr/local/bin:/usr/bin:/bin \
    V2_WORKSPACE_DIR=/mnt/workspace \
    CLAUDE_CONFIG_DIR=/mnt/workspace/.claude \
    XDG_DATA_HOME=/home/node/.kiro-data \
    V2_KIRO_STORE_DIR=/mnt/workspace/.kiro-data \
    OPENCODE_XDG_DATA_HOME=/home/node/.opencode-data \
    V2_OPENCODE_STORE_DIR=/mnt/workspace/.opencode-data \
    OPENCODE_DISABLE_AUTOUPDATE=1 \
    V2_CODEX_HOME_ROOT=/home/node/.codex-runs \
    V2_CODEX_STORE_DIR=/mnt/workspace/.aidlc/codex-home \
    V2_MCP_ENTRY=/opt/agentcore/mcp/index.js

# AgentCore Runtime contract: listen on 8080. /ping is the health surface.
EXPOSE 8080

ENTRYPOINT ["node", "/opt/agentcore/http-server.js"]
