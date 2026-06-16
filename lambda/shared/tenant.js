'use strict';

// Tenant resolution for the building-blocks library.
//
// Blocks live in a per-tenant library, with a `SYSTEM` tenant reserved for the
// read-only shipped baseline. The app has no org/tenant entity yet (tenancy is
// otherwise structural, via Project membership), so today every authenticated
// caller resolves to a single shared tenant. This is the one seam to change
// when real multi-tenancy arrives — e.g. derive the tenant from a Cognito
// group or custom claim — without touching the data model or callers.

const DEFAULT_TENANT = 'default';

// The reserved owner of the shipped baseline. Its blocks are read-only to
// tenants: writes are rejected, and a tenant customizes one by cloning it.
const SYSTEM_TENANT = 'SYSTEM';

// Resolves the caller's tenant from the Cognito authorizer claims. Returns a
// constant for now; the claims argument is the forward-compatible hook.
const resolveTenant = (_claims) => DEFAULT_TENANT;

module.exports = { resolveTenant, DEFAULT_TENANT, SYSTEM_TENANT };
