#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const supportedRoles = new Set(
  JSON.parse(readFileSync(resolve(root, 'config/platform-roles.json'), 'utf8')),
);
const MODES = new Set(['local', 'hybrid', 'sso-only']);
const PROVIDER_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const SECRET_ARN = /^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/;

const requireString = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
};

const stringList = (value, field, fallback = []) => {
  if (value == null) return fallback;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  return [...new Set(value.map((item) => item.trim()))];
};

const normalizeMappings = (value, providerName) => {
  if (value == null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${providerName}.roleMappings must be an object`);
  }
  const result = {};
  for (const [role, claims] of Object.entries(value)) {
    if (!supportedRoles.has(role)) {
      throw new Error(`${providerName}.roleMappings targets unsupported role "${role}"`);
    }
    result[role] = stringList(claims, `${providerName}.roleMappings.${role}`);
    if (result[role].length === 0) {
      throw new Error(`${providerName}.roleMappings.${role} must not be empty`);
    }
  }
  return result;
};

const normalizeProvider = (provider, baseDir) => {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    throw new Error('Every provider must be an object');
  }
  const name = requireString(provider.name, 'provider.name');
  if (!PROVIDER_NAME.test(name) || name.toUpperCase() === 'COGNITO') {
    throw new Error(`provider.name "${name}" must match ${PROVIDER_NAME} and must not be COGNITO`);
  }
  const displayName = requireString(provider.displayName, `${name}.displayName`);
  const type = requireString(provider.type, `${name}.type`).toLowerCase();
  if (type !== 'oidc' && type !== 'saml') {
    throw new Error(`${name}.type must be "oidc" or "saml"`);
  }

  const claims = provider.claims;
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
    throw new Error(`${name}.claims must be an object`);
  }
  const emailClaim = requireString(claims.email, `${name}.claims.email`);
  const nameClaim = claims.name ? requireString(claims.name, `${name}.claims.name`) : '';
  const roleMappings = normalizeMappings(provider.roleMappings, name);
  const requiredClaimValues = stringList(
    provider.requiredClaimValues,
    `${name}.requiredClaimValues`,
  );
  const needsRoleClaim = Object.keys(roleMappings).length > 0 || requiredClaimValues.length > 0;
  const roleClaim = claims.roles ? requireString(claims.roles, `${name}.claims.roles`) : '';
  if (needsRoleClaim && !roleClaim) {
    throw new Error(`${name}.claims.roles is required when role or access mappings are configured`);
  }

  const normalized = {
    display_name: displayName,
    type,
    email_claim: emailClaim,
    name_claim: nameClaim,
    role_claim: roleClaim,
    role_mappings: roleMappings,
    required_claim_values: requiredClaimValues,
  };

  if (type === 'oidc') {
    normalized.issuer_url = requireString(provider.issuerUrl, `${name}.issuerUrl`).replace(
      /\/$/,
      '',
    );
    normalized.client_id = requireString(provider.clientId, `${name}.clientId`);
    normalized.client_secret_arn = requireString(
      provider.clientSecretArn,
      `${name}.clientSecretArn`,
    );
    if (!SECRET_ARN.test(normalized.client_secret_arn)) {
      throw new Error(`${name}.clientSecretArn must be a Secrets Manager secret ARN`);
    }
    normalized.scopes = stringList(provider.scopes, `${name}.scopes`, [
      'openid',
      'email',
      'profile',
    ]);
    if (!normalized.scopes.includes('openid')) {
      throw new Error(`${name}.scopes must include "openid"`);
    }
  } else {
    const metadata = provider.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new Error(`${name}.metadata must specify exactly one of url, file, or xml`);
    }
    const supplied = ['url', 'file', 'xml'].filter(
      (key) => typeof metadata[key] === 'string' && metadata[key].trim(),
    );
    if (supplied.length !== 1) {
      throw new Error(`${name}.metadata must specify exactly one of url, file, or xml`);
    }
    if (supplied[0] === 'url') {
      normalized.metadata_url = requireString(metadata.url, `${name}.metadata.url`);
      normalized.metadata_xml = '';
    } else if (supplied[0] === 'file') {
      const metadataPath = resolve(baseDir, metadata.file);
      normalized.metadata_url = '';
      normalized.metadata_xml = requireString(
        readFileSync(metadataPath, 'utf8'),
        `${name}.metadata.file`,
      );
    } else {
      normalized.metadata_url = '';
      normalized.metadata_xml = requireString(metadata.xml, `${name}.metadata.xml`);
    }
  }
  return [name, normalized];
};

export const normalizeSsoConfig = (input, { mode = 'hybrid', baseDir = process.cwd() } = {}) => {
  if (!MODES.has(mode)) throw new Error(`auth mode must be one of: ${[...MODES].join(', ')}`);
  if (!input || typeof input !== 'object' || !Array.isArray(input.providers)) {
    throw new Error('SSO configuration must contain a providers array');
  }
  const entries = input.providers.map((provider) => normalizeProvider(provider, baseDir));
  const providers = Object.fromEntries(entries);
  if (Object.keys(providers).length !== entries.length) {
    throw new Error('Provider names must be unique');
  }
  if (mode === 'local' && entries.length > 0) {
    throw new Error('local auth mode cannot configure SSO providers');
  }
  if (mode !== 'local' && entries.length === 0) {
    throw new Error(`${mode} auth mode requires at least one SSO provider`);
  }
  if (
    mode === 'sso-only' &&
    !Object.values(providers).some(
      (provider) => (provider.role_mappings['platform-admin'] || []).length > 0,
    )
  ) {
    throw new Error('sso-only auth mode requires a platform-admin role mapping');
  }
  return providers;
};

export const loadAndNormalizeSsoConfig = (path, mode) => {
  const absolute = resolve(path);
  const input = JSON.parse(readFileSync(absolute, 'utf8'));
  return normalizeSsoConfig(input, { mode, baseDir: dirname(absolute) });
};

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const [path, mode = 'hybrid'] = process.argv.slice(2);
  if (!path) {
    console.error('Usage: sso-config.mjs <config.json> [local|hybrid|sso-only]');
    process.exit(2);
  }
  try {
    process.stdout.write(`${JSON.stringify(loadAndNormalizeSsoConfig(path, mode))}\n`);
  } catch (error) {
    console.error(`Invalid SSO configuration: ${error.message}`);
    process.exit(2);
  }
}
