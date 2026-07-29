import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { normalizeSsoConfig } from '../sso-config.mjs';

const secretArn =
  'arn:aws:secretsmanager:eu-west-1:111122223333:secret:/aidlc/test-client-secret-AbCdEf';

test('normalizes multiple OIDC providers and known role mappings', () => {
  const normalized = normalizeSsoConfig(
    {
      providers: [
        {
          name: 'Entra',
          displayName: 'Microsoft Entra ID',
          type: 'oidc',
          issuerUrl: 'https://login.microsoftonline.com/example/v2.0/',
          clientId: 'client-id',
          clientSecretArn: secretArn,
          claims: { email: 'email', name: 'name', roles: 'roles' },
          roleMappings: { 'platform-admin': ['AI-DLC.Admin'] },
          requiredClaimValues: ['AI-DLC.User'],
        },
        {
          name: 'Okta',
          displayName: 'Okta',
          type: 'oidc',
          issuerUrl: 'https://example.okta.com/oauth2/default',
          clientId: 'okta-client',
          clientSecretArn: secretArn,
          claims: { email: 'email', name: 'name' },
        },
      ],
    },
    { mode: 'hybrid' },
  );

  assert.deepEqual(Object.keys(normalized), ['Entra', 'Okta']);
  assert.equal(normalized.Entra.issuer_url, 'https://login.microsoftonline.com/example/v2.0');
  assert.deepEqual(normalized.Entra.role_mappings, {
    'platform-admin': ['AI-DLC.Admin'],
  });
  assert.deepEqual(normalized.Okta.scopes, ['openid', 'email', 'profile']);
});

test('loads SAML metadata files relative to the provider configuration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aidlc-saml-contract-'));
  const metadata = '<EntityDescriptor entityID="urn:test:idp"></EntityDescriptor>';
  writeFileSync(join(dir, 'metadata.xml'), metadata);

  const normalized = normalizeSsoConfig(
    {
      providers: [
        {
          name: 'CorporateSAML',
          displayName: 'Corporate SAML',
          type: 'saml',
          metadata: { file: 'metadata.xml' },
          claims: {
            email: 'urn:oid:0.9.2342.19200300.100.1.3',
            name: 'urn:oid:2.16.840.1.113730.3.1.241',
            roles: 'https://aidlc.example.com/claims/groups',
          },
          roleMappings: { 'platform-admin': ['aidlc-admin'] },
          requiredClaimValues: ['aidlc-user'],
        },
      ],
    },
    { mode: 'sso-only', baseDir: dir },
  );

  assert.equal(normalized.CorporateSAML.type, 'saml');
  assert.equal(normalized.CorporateSAML.metadata_xml, metadata);
  assert.equal(normalized.CorporateSAML.metadata_url, '');
});

test('requires an admin mapping for SSO-only and rejects unknown platform roles', () => {
  const provider = {
    name: 'OIDC',
    displayName: 'OIDC',
    type: 'oidc',
    issuerUrl: 'https://idp.example.com',
    clientId: 'client-id',
    clientSecretArn: secretArn,
    claims: { email: 'email', roles: 'groups' },
  };

  assert.throws(
    () => normalizeSsoConfig({ providers: [provider] }, { mode: 'sso-only' }),
    /requires a platform-admin role mapping/,
  );
  assert.throws(
    () =>
      normalizeSsoConfig(
        {
          providers: [
            {
              ...provider,
              roleMappings: { 'future-unknown-role': ['external-role'] },
            },
          ],
        },
        { mode: 'hybrid' },
      ),
    /unsupported role/,
  );
});

test('requires a role claim for mappings and access gates', () => {
  assert.throws(
    () =>
      normalizeSsoConfig(
        {
          providers: [
            {
              name: 'OIDC',
              displayName: 'OIDC',
              type: 'oidc',
              issuerUrl: 'https://idp.example.com',
              clientId: 'client-id',
              clientSecretArn: secretArn,
              claims: { email: 'email' },
              requiredClaimValues: ['aidlc-user'],
            },
          ],
        },
        { mode: 'hybrid' },
      ),
    /claims.roles is required/,
  );
});
