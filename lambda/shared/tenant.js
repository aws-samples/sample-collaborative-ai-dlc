'use strict';

// Ownership namespace resolution for the building-blocks library.
//
// The "tenant" field here is not a team/org boundary. It is only the ownership
// split that lets us safely reseed imported workflow/block definitions while
// keeping user-created definitions editable:
//   - SYSTEM: imported vendor baseline, read-only through the API and freely
//     replaceable by the seed job during upgrades.
//   - default: the shared user-owned library for blocks/workflows created or
//     forked in the app.
//
// Project/team authorization continues to live in the existing project graph.
// Do not derive this value from project/team membership unless the product model
// deliberately grows separate libraries later.

const DEFAULT_TENANT = 'default';

// The reserved owner of the shipped/imported baseline. Its blocks/workflows are
// read-only through the API; users customize them by forking into `default`.
const SYSTEM_TENANT = 'SYSTEM';

// All authenticated users write to the shared user library. The claims argument
// is intentionally unused; the ownership split is SYSTEM vs user-created, not
// one library per team or project.
const resolveTenant = (_claims) => DEFAULT_TENANT;

module.exports = { resolveTenant, DEFAULT_TENANT, SYSTEM_TENANT };
