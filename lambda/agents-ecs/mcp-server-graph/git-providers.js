'use strict';

// Single-sourced access to the git-provider registry for the construction MCP
// server. Implementation lives in lambda/shared/git-providers (one source of
// truth for GitHub/GitLab specifics).
//
// Path indirection: mcp-server-graph runs both from the repo (tests, where the
// canonical module is at ../../shared/git-providers) and from the ECS image
// (where the Dockerfile copies shared/git-providers.js + shared/git-providers/
// into ./shared/ alongside this file — see agents-ecs/Dockerfile). We try the
// in-package copy first (image), then fall back to the repo-relative path
// (local + unit tests), so neither environment needs a bespoke build step.
let providers;
try {
  providers = require('./shared/git-providers');
} catch {
  providers = require('../../shared/git-providers');
}

module.exports = providers;
