# Enterprise SSO

AI-DLC can authenticate users through one or more external OpenID Connect (OIDC)
or SAML 2.0 identity providers. Amazon Cognito remains the federation broker and
the only JWT issuer, so every backend continues to validate the same token
format regardless of where the user authenticated.

## Authentication model

The three authentication modes are:

| Mode       | Login page                                                          |
| ---------- | ------------------------------------------------------------------- |
| `local`    | Cognito email and password only                                     |
| `hybrid`   | Named enterprise providers plus a separate **Cognito account** form |
| `sso-only` | Named enterprise providers only                                     |

These endpoints and systems have different responsibilities:

| Component                          | Responsibility                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| Application URL                    | CloudFront hostname that serves the AI-DLC SPA and APIs                       |
| Cognito managed-login domain       | Federation endpoint that redirects between AI-DLC and an external IdP         |
| Cognito User Pool                  | Stores local and federated identities and issues every AI-DLC access/ID token |
| External IdP                       | Authenticates enterprise users and supplies email, name, and role claims      |
| GitHub/GitLab source-control OAuth | Repository access after login; unrelated to enterprise login                  |

GitHub OAuth is not an enterprise login provider in this release. GitHub and
GitLab OAuth remain source-control integrations; enterprise login requires an
OIDC or SAML identity provider.

The application callback is `<application-url>/auth/callback`. The upstream IdP
callback is the `oidc_idp_callback_url` output for OIDC or the `saml_acs_url`
output for SAML. Do not interchange them.

AI-DLC does not automatically link a federated identity to an existing local
identity, and matching email addresses must not be assumed to merge accounts.
Platform logout clears the AI-DLC/Cognito session but does not perform global
IdP logout. An upstream IdP can therefore reuse its browser session on the next
login. AI-DLC does not implement upstream account switching for any provider;
there are no provider-specific exceptions. OIDC logout and SAML Single Logout
have different contracts and cannot provide one portable behavior. Users who
must change their enterprise identity should use the IdP's own
account-switch/sign-out flow or an isolated browser profile.

## Role and access mapping

Provider configuration can map exact, case-sensitive values from one external
claim to platform roles. This release supports `platform-admin`; future roles
are added centrally in `config/platform-roles.json`.

For a federated user:

- The external claim is authoritative on every fresh federated sign-in.
- Cognito group membership is replaced in the issued token by the mapped roles.
  Manually adding a federated user to `platform-admin` does not grant that role.
- Cognito requires mapped claims to use app-client-writable attributes. Hosted
  SSO sessions omit Cognito's self-service scope, so federated users cannot
  modify the stored role claim through `UpdateUserAttributes`.
- `requiredClaimValues` is an optional, independent access gate. When configured,
  every user, including an administrator, must have at least one required value.
- Role and access changes at the IdP take effect after platform logout and a new
  federated sign-in. Refresh tokens are valid for one day in SSO-enabled modes.
- The Admin user list marks these roles **Managed by `<provider>`** and read-only.

Local Cognito users keep their normal Cognito groups. In `sso-only` mode, the
installer does not create a local administrator and deployment validation
requires at least one configured `platform-admin` mapping. That validation
cannot prove that a real person is assigned, so verify an SSO administrator in
`hybrid` mode before switching to `sso-only`.

Project membership is assigned to the Cognito broker identity, not to an email
address or upstream username. A federated user must complete one successful
sign-in before appearing in **Project Settings → Members**. The member picker
labels local Cognito accounts separately from enterprise identities and excludes
identities that are disabled or do not pass the configured access gate.

## Bootstrap sequence

The Cognito federation domain must exist before an upstream redirect URI can be
registered. Use the managed installer to create a local-authentication deployment
first. Download the installer as described in [Setup](setup.md#managed-installation),
then run:

```bash
bash /tmp/aidlc-install.sh install \
  --profile <aws-profile> \
  --region <aws-region> \
  --environment <environment> \
  --admin <administrator-email>
```

The installation summary prints the OIDC callback, SAML ACS, and SAML entity ID
to register with the external provider. The `status` command prints them again:

```bash
bash /tmp/aidlc-install.sh status
```

Configure the provider, store any OIDC client secret in AWS Secrets Manager, and
write a provider file such as `/tmp/aidlc-sso.json`. Reconfigure the installed
release in `hybrid` mode first so the local administrator remains available
while the external role mapping is verified:

```bash
bash /tmp/aidlc-install.sh update \
  --version <current-version> \
  --auth-mode hybrid \
  --sso-config /tmp/aidlc-sso.json
```

Provider configuration is persisted as a mode-`0600`
`<environment>.sso.tfvars.json` file. It contains only the Secrets Manager ARN,
never the OIDC client secret. Use `--no-sso` on a later update to return to local
authentication. Moving from `sso-only` back to local/hybrid prompts for and
creates a local administrator.

After an SSO administrator has signed in successfully, the same provider file
can be moved to SSO-only mode:

```bash
bash /tmp/aidlc-install.sh update \
  --version <current-version> \
  --auth-mode sso-only \
  --sso-config /tmp/aidlc-sso.json
```

## Provider file

One file can contain multiple OIDC and SAML providers:

```json
{
  "providers": [
    {
      "name": "CorporateOIDC",
      "displayName": "Corporate identity",
      "type": "oidc",
      "issuerUrl": "https://idp.example.com",
      "clientId": "client-id",
      "clientSecretArn": "arn:aws:secretsmanager:REGION:ACCOUNT:secret:NAME",
      "scopes": ["openid", "email", "profile"],
      "claims": {
        "email": "email",
        "name": "name",
        "roles": "groups"
      },
      "roleMappings": {
        "platform-admin": ["aidlc-admin"]
      },
      "requiredClaimValues": ["aidlc-user"]
    }
  ]
}
```

`name` is the stable Cognito provider identifier and must start with a letter,
contain at most 32 letters/numbers/underscores/hyphens, and not be `COGNITO`.
`displayName` is shown on the login button. Provider names must remain stable:
renaming one creates distinct federated Cognito usernames.

Create one Secrets Manager secret per OIDC provider in the same AWS account and
Region as the AI-DLC deployment. The secret name is your choice; the examples use
`aidlc/<environment>/<provider-name>`. Store the raw OIDC client secret itself,
not a JSON wrapper:

```bash
printf '%s' '<oidc-client-secret>' > /tmp/aidlc-oidc-secret
chmod 600 /tmp/aidlc-oidc-secret

aws secretsmanager create-secret \
  --name "aidlc/<environment>/<provider-name>" \
  --secret-string file:///tmp/aidlc-oidc-secret \
  --profile <aws-profile> \
  --region <aws-region> \
  --query ARN --output text
```

Copy the returned ARN into that provider's `clientSecretArn` field, then remove
the temporary file. The installer does not require or look up a fixed secret
name. Its AWS principal needs `secretsmanager:GetSecretValue` for the ARN.

Terraform must send the secret value to the Cognito identity-provider API, so
the value can be present in Terraform state even though configuration files
contain only its ARN. Protect the state backend and restrict access to it.

## Microsoft Entra ID (OIDC)

Using Entra app roles avoids group-overage behavior and gives tokens stable,
application-specific values.

1. In **Microsoft Entra admin center**, open **App registrations** and create an
   app registration for AI-DLC in the required tenant.
2. Under **Authentication**, add a **Web** redirect URI equal to the
   **OIDC callback** shown by `bash /tmp/aidlc-install.sh status`.

3. Under **Certificates & secrets**, create a client secret. Store its **Value**
   immediately as the raw value of a Secrets Manager secret in the deployment
   account and Region, for example `aidlc/<environment>/entra`. The Secret ID is
   not the client secret. Set `clientSecretArn` below to the ARN returned by
   Secrets Manager.
4. Under **App roles**, create roles with values `AI-DLC.User` and
   `AI-DLC.Admin`. Allow users/groups, then assign users or groups through the
   corresponding Enterprise application. Administrators need both roles.
5. Under **Token configuration**, add the `email` optional claim to the ID token.
   Confirm assigned users actually receive a valid email value.
6. Record the Application (client) ID and tenant ID. Use the tenant-specific v2
   issuer, not `common` or `organizations`.

Example:

```json
{
  "providers": [
    {
      "name": "Entra",
      "displayName": "Microsoft Entra ID",
      "type": "oidc",
      "issuerUrl": "https://login.microsoftonline.com/<tenant-id>/v2.0",
      "clientId": "<application-client-id>",
      "clientSecretArn": "<secrets-manager-arn>",
      "scopes": ["openid", "email", "profile"],
      "claims": {
        "email": "email",
        "name": "name",
        "roles": "roles"
      },
      "roleMappings": {
        "platform-admin": ["AI-DLC.Admin"]
      },
      "requiredClaimValues": ["AI-DLC.User"]
    }
  ]
}
```

If your tenant uses group claims instead, set `claims.roles` to `groups` and map
Entra group object IDs. Review Entra group-overage behavior before relying on
that approach; users in many groups may receive an overage indicator instead of
the complete group list.

## Okta (OIDC)

1. In **Okta Admin Console**, open **Applications**, create an **OIDC - OpenID
   Connect** integration, choose **Web Application**, and enable Authorization
   Code.
2. Set the sign-in redirect URI to the **OIDC callback** shown by
   `bash /tmp/aidlc-install.sh status`. Assign the application only to
   users/groups allowed to use it.
3. Create Okta groups `aidlc-user` and `aidlc-admin`; administrators should be
   members of both.
4. Under **Security → API → Authorization Servers**, open the authorization
   server used by the app (commonly `default`). Under **Access Policies**, add
   an active policy assigned to the AI-DLC client and a rule that permits the
   Authorization Code grant for assigned users and the requested scopes.
5. In the same authorization server, add a `groups` claim with value type
   **Groups**. Include it in ID tokens for any scope (or for every scope listed
   in the provider file), and filter it to the groups intended for AI-DLC, such
   as names matching `^aidlc-`. Use **Token Preview** with an assigned AI-DLC
   user and confirm the ID token contains the exact, case-sensitive group names.
   If the Okta tenant instead presents an expression-based **Token claims** UI,
   name the claim `groups` and use:
   `user.getGroups({"group.profile.name":"aidlc-","operator":"STARTS_WITH"}).![name]`.
   The claim name must match `claims.roles`; `aidlc-*` is not wildcard syntax in
   this expression.
6. Copy the client ID and secret. Store the raw secret in the deployment account
   and Region, for example as `aidlc/<environment>/okta`, and set
   `clientSecretArn` below to the ARN returned by Secrets Manager.
7. Copy the exact issuer shown by Okta. For the default custom authorization
   server it normally ends in `/oauth2/default`.

Example:

```json
{
  "providers": [
    {
      "name": "Okta",
      "displayName": "Okta",
      "type": "oidc",
      "issuerUrl": "https://<okta-domain>/oauth2/default",
      "clientId": "<okta-client-id>",
      "clientSecretArn": "<secrets-manager-arn>",
      "scopes": ["openid", "email", "profile"],
      "claims": {
        "email": "email",
        "name": "name",
        "roles": "groups"
      },
      "roleMappings": {
        "platform-admin": ["aidlc-admin"]
      },
      "requiredClaimValues": ["aidlc-user"]
    }
  ]
}
```

Use the claim preview/token preview in Okta to verify `email`, `name`, and
`groups` before deploying. Claim configuration differs between the org
authorization server and custom authorization servers; the issuer and claim
must come from the same server.

Okta app assignment and app sign-on policies are separate from authorization
server access policies. If the System Log shows the app sign-on evaluation as
`ALLOW` but the OAuth authorization request fails with `no_matching_policy`,
add or correct the access policy and rule on the authorization server selected
by `issuerUrl`.

## Generic SAML 2.0

Run `bash /tmp/aidlc-install.sh status` and register AI-DLC as a SAML service
provider using the reported **SAML ACS** and **SAML entity** values.

Set:

- **ACS / Reply URL** to the reported **SAML ACS**
- **Audience / SP Entity ID** to the reported **SAML entity**
- **NameID** to a stable user identifier, normally email
- Attribute statements for email, display name, and role/group values

The provider file accepts exactly one metadata source: HTTPS URL, local file, or
inline XML. Local metadata paths are resolved relative to the JSON file.

```json
{
  "providers": [
    {
      "name": "CorporateSAML",
      "displayName": "Corporate SAML",
      "type": "saml",
      "metadata": {
        "file": "./idp-metadata.xml"
      },
      "claims": {
        "email": "urn:oid:0.9.2342.19200300.100.1.3",
        "name": "urn:oid:2.16.840.1.113730.3.1.241",
        "roles": "https://aidlc.example.com/claims/groups"
      },
      "roleMappings": {
        "platform-admin": ["aidlc-admin"]
      },
      "requiredClaimValues": ["aidlc-user"]
    }
  ]
}
```

For hosted metadata use `"metadata": {"url": "https://..."}`. For inline
metadata use `"metadata": {"xml": "<EntityDescriptor ...>"}`. Attribute names
must exactly match the names in the SAML assertion. AI-DLC does not initiate
SAML Single Logout.

## Troubleshooting

**Provider button is missing.** Run `bash /tmp/aidlc-install.sh status` and
confirm the expected authentication mode and provider names. Rerun the
installer update if the previous deployment did not complete.

**Redirect URI mismatch.** OIDC uses the **OIDC callback** reported by the
installer, not the application `/auth/callback`. SAML uses the reported
**SAML ACS**.

**Federated user is denied.** Inspect the IdP token/assertion and compare its
role claim values, including case, with `requiredClaimValues`. A mapped admin
role does not bypass the access gate.

**Role change is not visible.** Platform logout and start a new provider login.
An existing Cognito refresh token does not fetch fresh external claims.

**OIDC provider creation fails.** Confirm the issuer exposes standard OIDC
discovery, the secret contains only the raw client secret, and Terraform can
read the supplied Secrets Manager ARN using the installer’s AWS credentials.
