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
claim to `platform-admin` and the fixed business-role catalog. Only
`platform-admin` becomes a Cognito platform group.

### The source attribute (`claims.roles`)

`claims.roles` names the OIDC claim or SAML attribute the application reads —
it does not restrict the values to IdP "roles". Use `groups`, `roles`, or any
exact custom attribute name (for SAML this can be a full attribute URI), and
configure the IdP to send that attribute to this application. One source
attribute is read per provider; if the IdP sends groups and roles in separate
attributes, choose the one to use. The selected attribute supplies Cognito's
`custom:sso_roles` on every federated sign-in and feeds both platform-role
mappings (below) and business-role mappings (next section).

### Business-role mappings

Business roles (Developer, Architect, QA / Tester, …) describe delivery
responsibilities in spaces. Platform Admins map IdP values to business roles in
**Platform Admin → Users → Business role mappings**. You can also define a
baseline in each provider's Terraform `role_mappings`:

```hcl
role_mappings = {
  "platform-admin" = ["<ADMIN_GROUP_OBJECT_ID>"]
  developer        = ["<DEVELOPER_GROUP_OBJECT_ID>"]
  architect        = ["<ARCHITECT_GROUP_OBJECT_ID>"]
  "qa-tester"      = []
}
```

Use stable IDs: `product-owner`, `business-analyst`, `architect`, `ux-ui-designer`,
`developer`, `qa-tester`, `security-compliance`, `operations-devops`, and
`delivery-manager`. In the installer provider JSON, the same map is named
`roleMappings`. An empty business-role list grants nothing from Terraform.

For each role, the effective values are the deduplicated union of Terraform
values and UI additions. The UI labels their sources and displays Terraform
values as read-only. Admins can add or remove UI values; removing an addition
that also exists in Terraform leaves the Terraform value active. The database
stores only UI additions. Existing saved mappings become additions without a
migration. A deployment updates the Terraform baseline without replacing them.
With no baseline, mappings remain fully managed through the UI:

- Enter the exact values received from SSO, including case — a group name, a
  role value, or a group ID (for example an Entra group object ID). The
  application does not verify the value exists in the IdP.
- One business role can match several values (any match grants the role), and
  the same value may map to several business roles.
- A saved mapping affects the next role calculation immediately. A change to a
  user's company groups becomes visible after their next federated sign-in.
- **Configure the IdP to always send the source attribute, even when it is
  empty.** Cognito keeps the stored value when a sign-in omits the attribute,
  so a user removed from their last group would keep that group, and with it
  their platform roles, business roles, and `requiredClaimValues` access,
  until the attribute is sent again. Some IdPs omit a group claim when the
  user has no group; check this before relying on group removal.
- Each federated sign-in records the user's provider and raw values in the
  access table (never the calculated roles). Business roles, including those
  of members who are not signed in, are calculated from that copy with the
  current mappings and `requiredClaimValues`, without reading Cognito. A user
  who no longer has a required value keeps no SSO business roles. Token
  refreshes do not update the copy; if it cannot be saved, the sign-in fails.
- Changing or removing a provider's source attribute (`claims.roles`)
  invalidates the recorded values, so members get no SSO business roles until
  they sign in again with the new attribute. Mapping changes for the same
  attribute apply immediately.
- The first deployment of this behavior copies the values Cognito holds for
  existing federated users before the member APIs use them. A copy saved by a
  sign-in is never replaced by that backfill.
- Business roles never grant sign-in access, space membership, or platform
  management rights. The `platform-admin` mapping and `requiredClaimValues`
  stay in the provider file and cannot be changed from this UI.

Space Owners can add business roles locally and exclude inherited SSO roles per
space (see [the spaces guide](../using-the-platform/projects.md)).

For a federated user:

- The external claim is authoritative on every fresh federated sign-in.
- Cognito group membership is replaced in the issued token by mapped platform roles.
  Manually adding a federated user to `platform-admin` does not grant that role.
- Cognito requires mapped claims to use app-client-writable attributes. Hosted
  SSO sessions omit Cognito's self-service scope, so federated users cannot
  modify the stored role claim through `UpdateUserAttributes`.
- `requiredClaimValues` is an optional, independent access gate. When configured,
  every user, including an administrator, must have at least one required value.
- Role and access changes at the IdP take effect after platform logout and a new
  federated sign-in. Refresh tokens are valid for one day in SSO-enabled modes
  unless configured otherwise; see [Token lifetimes](#token-lifetimes).
- The Admin user list marks these roles **Managed by `<provider>`** and read-only.

Local Cognito users keep their normal Cognito groups. In `sso-only` mode, the
installer does not create a local administrator and deployment validation
requires at least one configured `platform-admin` mapping. That validation
cannot prove that a real person is assigned, so verify an SSO administrator in
`hybrid` mode before switching to `sso-only`.

Space membership is assigned to the Cognito broker identity, not to an email
address or upstream username. A federated user must complete one successful
sign-in before appearing in **Space Settings → Members**. The member picker
labels local Cognito accounts separately from enterprise identities and excludes
identities that are disabled or do not pass the configured access gate.

## Token lifetimes

After every sign-in, local or federated, Cognito issues the tokens the web app
uses. Their lifetimes decide how often the web app must refresh its session,
when a new sign-in is required, and how long a user removed at the identity
provider keeps access. When your organization's identity policy caps
session or token lifetimes, set them in the environment's `.tfvars`:

```hcl
auth_access_token_validity_minutes = 60 # 5-1440
auth_id_token_validity_minutes     = 60 # 5-1440
auth_refresh_token_validity_hours  = 24 # 1-87600
```

| Variable                             | Default                                     |
| ------------------------------------ | ------------------------------------------- |
| `auth_access_token_validity_minutes` | 60                                          |
| `auth_id_token_validity_minutes`     | 60                                          |
| `auth_refresh_token_validity_hours`  | 24 with enterprise SSO, 168 in `local` mode |

- The web app resolves the Cognito session before every API request and every
  realtime connection, and sends the ID token. Amplify refreshes expired ID and
  access tokens with the refresh token, so shorter values add token refreshes
  but do not sign users out.
- The refresh token lifetime is how long after a sign-in Cognito permits
  refreshes. When it ends, the web app can no longer refresh and the user must
  sign in again. Refresh expiry is not a hard session cap: it stops future
  refreshes but does not invalidate tokens already issued.
  - An ID token issued by a refresh just before the deadline stays valid for the
    full ID token lifetime. A session can therefore keep working for up to the
    refresh token lifetime plus the ID token lifetime after sign-in.
  - Realtime connections are authorized when they open. The web app reconnects
    before its ten-minute realtime scope token expires, and reconnecting
    requires a valid ID token, but the servers do not close a connection that
    is already open when its tokens expire.
- Lifetimes are not revocation. A Cognito refresh does not check the identity
  provider again, so a user disabled or removed there keeps refreshing until
  the refresh token expires, then keeps using the last ID token until it
  expires. Access after a removal can therefore last up to the refresh token
  lifetime plus the ID token lifetime. Size both for the longest access you
  accept after a removal.
- The values apply to the single app client, so they also cover local Cognito
  accounts in `hybrid` mode.
- A change applies to tokens issued after the next apply. Tokens already issued
  keep their original expiry.

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

## Custom managed-login domain

By default the Cognito managed-login domain is a generated `<prefix>.auth.<region>.amazoncognito.com` hostname.
To serve it from your own hostname instead, provision a custom login domain:

```hcl
auth_domain          = "auth.aidlc.example.com"
auth_certificate_arn = "" # empty reuses acm_certificate_arn
auth_route53_zone_id = "" # optional; independent of the application zone
auth_domain_active   = false
```

- The certificate must be an issued ACM certificate in `us-east-1` that covers `auth_domain`, regardless of the deployment Region.
- Cognito accepts the domain only when its parent (here `aidlc.example.com`) already resolves through a public DNS A record. Terraform orders custom-domain creation after its application DNS records and waits for the parent A record to resolve. For externally managed parent DNS, create the parent record before applying.
- `auth_domain` must differ from `app_domain` and its aliases. Cognito serves it from its own CloudFront distribution.
- After apply, point `auth_domain` at the `auth_dns_target` output (a CNAME, or a Route53 alias using `auth_dns_target_hosted_zone_id`). With `auth_route53_zone_id` set, Terraform creates the alias records itself. Set this explicitly even when auth and application use the same hosted zone; the application `route53_zone_id` is never reused implicitly.

Creating the custom domain keeps the generated prefix domain selected for existing logins. This allows an existing `hybrid` or `sso-only` deployment to prepare the new domain without changing its frontend login origin.

1. Apply with `auth_domain_active = false`, preserving the deployment's existing authentication mode and providers.
2. Verify the custom hostname resolves and serves a valid HTTPS certificate.
3. Register `auth_custom_oidc_idp_callback_url` or `auth_custom_saml_acs_url` with the identity provider while retaining the old callback. Local-only deployments have no IdP registration step.
4. Set `auth_domain_active = true`, apply, and rebuild/deploy the frontend. The effective OIDC callback, SAML ACS, and login-origin outputs now use the custom domain.
5. Verify sign-in before removing any old IdP callback.

To roll back the login origin, set `auth_domain_active = false` and redeploy the frontend. Both domains remain attached to the user pool. To remove the custom domain afterward, also clear `auth_domain`, `auth_certificate_arn`, and `auth_route53_zone_id`.

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
