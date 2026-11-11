# Customer MCP servers behind the Gateway

Platform administrators can serve a customer's own MCP servers (for example a Confluence or Jira MCP server) to agents through the AgentCore Gateway the built-in tools already use. The agent runtime never holds the server's credential: the Gateway fetches it from AgentCore Identity on each call. The Gateway's interceptor decides who may call which tool from the control plane's signed grant, per space, stage and tool.

This is a deployment-level setting in Terraform, not a space setting. Space and platform custom MCP servers (**Space Settings → Agent → MCP Servers**, **Admin → Agents**) keep working as before unless the deployment uses the [Gateway-only profile](#gateway-only-profile).

## How a call flows

```text
agent CLI ─stdio─▶ aidlc-gateway-tools (runtime proxy, SigV4 + grant)
          ─▶ AgentCore Gateway (AWS_IAM)
          ─▶ mcp-interceptor: grant, session, live stage state, allow rule
          ─▶ customer MCP server, with the Gateway's OAuth token or API key
             and the x-aidlc-caller header
```

- Agents in stage sessions (the lead and dispatched personas, for every agent CLI) see one extra MCP server, `aidlc-gateway-tools`, whose tools keep the Gateway's qualified names: `<target>___<tool>`, for example `confluence___search`. Discussion and conflict-resolution sessions do not get it.
- `tools/list` only shows the customer tools the session may call. Every `tools/call` is checked again; a denied call returns a tool error to the agent and never reaches the customer server.
- A call is allowed only when the grant is a stage grant, its space is in the target's `project_ids`, its stage is in `stage_ids` (or `stage_ids` is unset) and the tool is in `tools` (or `tools` is unset), and the execution and stage are still active. The role, persona and agent identity the runtime reports are never used to grant access.

## Add a target

Prerequisites: `enable_mcp_gateway = true` (which requires `network_mode = "VPC"`). The MCP server must speak Streamable HTTP over HTTPS, publicly reachable or through a VPC Lattice private endpoint.

### 1. Create the credential provider

Create the provider in the deployment's account and Region, outside Terraform, so the secret never enters Terraform state. Read the secret from a file rather than putting it on the command line.

OAuth 2.0 client credentials (the server's authorization server issues the Gateway a token):

```sh
aws bedrock-agentcore-control create-oauth2-credential-provider \
  --name confluence-mcp \
  --credential-provider-vendor CustomOauth2 \
  --oauth2-provider-config-input file://confluence-oauth.json
```

with `confluence-oauth.json`:

```json
{
  "customOauth2ProviderConfig": {
    "oauthDiscovery": {
      "discoveryUrl": "https://auth.example.com/.well-known/openid-configuration"
    },
    "clientId": "<client id>",
    "clientSecret": "<client secret>"
  }
}
```

API key:

```sh
aws bedrock-agentcore-control create-api-key-credential-provider \
  --name jira-mcp \
  --cli-input-json file://jira-api-key.json
```

with `jira-api-key.json` containing `{ "apiKey": "<api key>" }`.

Delete the input file afterwards. Note the `credentialProviderArn` and the secret ARN from the response (`clientSecretArn.secretArn` or `apiKeySecretArn.secretArn`). The provider ARN has the form `arn:aws:bedrock-agentcore:<region>:<account>:token-vault/default/oauth2credentialprovider/<name>` (or `.../apikeycredentialprovider/<name>`); Terraform also accepts the `acps` service prefix used in the API reference. If the provider secret is encrypted with a customer managed KMS key, also allow the Gateway role (`<project>-mcp-gateway-<environment>`) to decrypt with it.

### 2. Declare the target

```hcl
mcp_gateway_custom_targets = {
  confluence = {
    endpoint = "https://mcp.confluence.example.com/mcp"
    auth = {
      type                    = "oauth"
      credential_provider_arn = "<credentialProviderArn>"
      secret_arn              = "<clientSecretArn.secretArn>"
      scopes                  = ["read:confluence-content.all"]
    }
    allow = {
      project_ids = ["<space id>"]
      stage_ids   = ["requirements-analysis", "application-design"]
      tools       = ["search", "get_page"]
    }
  }
  jira = {
    endpoint = "https://mcp.jira.example.com/mcp"
    auth = {
      type                    = "api_key"
      credential_provider_arn = "<credentialProviderArn>"
      secret_arn              = "<apiKeySecretArn.secretArn>"
      credential_location     = "HEADER"
      parameter_name          = "X-Api-Key"
    }
    allow = {
      project_ids = ["<space id>", "<other space id>"]
    }
  }
}
```

- The key (`confluence`, `jira`) is the Gateway target name: 1–32 lowercase letters, digits and single hyphens, never `aidlc`. Agents and allow rules refer to tools through it, so treat it as immutable; renaming creates a different target.
- `allow.project_ids` is required. `stage_ids` and `tools` are optional; unset means every stage, or every tool of the target. Tool names are the server's own names, without the `<target>___` prefix.
- `private_endpoint` takes the same `managed_vpc_resource` or `self_managed_lattice_resource` block as `aws_bedrockagentcore_gateway_target`.
- The encoded allow rules must stay under 2 KB; Terraform refuses a larger set.

Terraform creates one Gateway target per entry, lets it receive only the `x-aidlc-caller` request header, and gives the Gateway role exactly the permissions to fetch those providers' tokens or keys (`bedrock-agentcore:GetWorkloadAccessToken` on its workload identity; `GetResourceOauth2Token` or `GetResourceApiKey` on the providers, the `default` token vault and its workload identity, against all of which AgentCore authorizes the call; and `secretsmanager:GetSecretValue` on the provider secrets). The interceptor receives the allow rules only; the runtime learns only that customer targets exist.

### 3. Deploy

Apply with `deploy-terraform.sh` as usual. The `aidlc-gateway-tools` entry is written when a stage session starts on the updated runtime; sessions already running when the first target is added do not get it.

## Contract for the customer MCP server

- **Authenticate the Gateway.** Every request carries the credential from the provider: the OAuth access token in `Authorization` (verify issuer, audience or client, and scopes) or the API key where you configured it. Reject anything else. The interceptor never sets `Authorization`, so the provider's credential is the one you receive.
- **Read `x-aidlc-caller` for scoping.** On `tools/call` the header is a base64url-encoded JSON object:

  ```json
  {
    "v": 1,
    "projectId": "<space id>",
    "intentId": "<intent id>",
    "executionId": "<execution id>",
    "stageId": "requirements-analysis",
    "unitSlug": null,
    "sectionIndex": null,
    "grantId": "<grant id>",
    "expiresAt": 1793890000
  }
  ```

  Every field comes from the control plane's signed grant; nothing in it is asserted by the agent runtime. Reject unknown versions. Use it to scope what a call may read or write (for example a Confluence space per AI-DLC space) and for audit.

- **Treat `{"v": 1, "none": true}` as no caller.** On every other request the interceptor allows (`initialize`, `ping`, `tools/list`, notifications, and calls to other targets), it sets the header to this fixed value, base64url `eyJ2IjoxLCJub25lIjp0cnVlfQ`, so a header supplied by the caller never reaches your server. It identifies no space, intent or stage: grant nothing scoped on it.
- **Trust the header only on an authenticated Gateway request.** It is plain data, not a signature: a request that did not authenticate as the Gateway may carry any value. Do not rely on it for methods other than `tools/call`.
- Return ordinary MCP results; they reach the agent unchanged.

## Change, rotate, revoke

Target access is not pinned to an execution: the interceptor checks every call against the deployed targets, so a change also applies to stages that are already running. It takes effect once the apply has updated the interceptor and the Gateway targets; a call already admitted runs to completion.

- **Restricting** access (removing a space, stage or tool, or a whole target) is a revocation: the next call of a running stage is denied and the tools disappear from the next `tools/list`. Use it to cut off a compromised server.
- **Widening** access (adding a space, stage or tool) or **rebinding** a target (a new endpoint or credential provider) applies to the next call of a running stage in the same way.
- **Rotating** a credential happens in AgentCore Identity (update the provider's secret); no Terraform change is needed.
- A stage's grant stops working when the stage attempt ends, when its execution is cancelled, rewound or deleted, and when it expires. Calls already admitted run to completion; the customer server is not told that a grant was retired.

## Gateway-only profile

`runtime_mcp_credentials = "gateway_only"` keeps every custom MCP credential and every direct custom MCP connection out of the agent runtime's microVM. It requires `enable_mcp_gateway`, `enable_engine_data` and `enforce_runtime_grants`. The default, `"allow"`, is unchanged behaviour.

With the profile on:

- The space and platform MCP editors refuse any server (stdio or remote) and any secret value, with a message pointing to Gateway targets. Existing entries can still be read and removed, and stored secrets cleared. **Test** (MCP verification) is refused.
- Starting, retrying or rewinding an intent whose MCP snapshot still lists servers is refused until the servers are removed from Space Settings and Platform Admin settings; the retry then uses the empty configuration.
- A stage of an execution whose pinned configuration lists servers fails with `runtime_mcp_gateway_only` instead of being dispatched. The credential broker refuses to resolve MCP secrets, and the runtime refuses such a stage before resolving or connecting to anything.
- The runtime role loses its MCP secret read, and an explicit Deny keeps MCP secret parameters, AgentCore Identity tokens and API keys, and the providers' secrets out of its reach.
- Execution records read through engine-data omit the stored MCP configuration (`mcpServersByTier` and the legacy `customMcpServers`), so servers and inline credentials an intent saved under `"allow"` do not reach the runtime. The stored record is unchanged.
- The platform-provided MCP configuration is the only one an agent CLI loads, on fresh, resumed and one-shot runs. MCP servers defined by the repository or the runtime user's home are not loaded:

  | CLI         | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
  | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Claude Code | `--strict-mcp-config`: only the servers in `--mcp-config` load (none without it); `.mcp.json`, user and plugin servers are ignored.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
  | Kiro CLI    | The runtime agent sets `includeMcpJson: false`, so the global and workspace `.kiro/settings/mcp.json` are not included. A one-shot run without an agent uses an MCP-free agent.                                                                                                                                                                                                                                                                                                                                                                                                              |
  | Codex CLI   | The private `CODEX_HOME` marks the workspace and its parent directories up to the repository root untrusted, so project `.codex/` layers (config, hooks, rules) are skipped.                                                                                                                                                                                                                                                                                                                                                                                                                 |
  | OpenCode    | Every server defined in `opencode.json(c)` or `.opencode/opencode.json(c)` between the workspace and the repository root, or in the user's global config, is repeated with `enabled: false` in the inline configuration, which OpenCode reads last. A configuration file that cannot be parsed, that uses `{env:…}` or `{file:…}` anywhere other than inside a string value, or that writes one with a JSON escape (`"\u007benv:…}"`), fails the run. `OPENCODE_PURE` keeps plugins (`.opencode/plugin(s)/` files and config `plugin` entries) from loading, so none can re-enable a server. |

  This isolates the agent's MCP tools. It complements, and does not replace, network egress control: code the agent runs (a shell command, `curl`, a script in the repository) can still open connections from the microVM. Restricting the runtime's egress is the next hardening step.

To switch an existing deployment: remove the space and platform MCP servers (and clear their secrets), add the servers you still need as Gateway targets, let intents that pinned servers finish or restart them, then apply.

The profile covers custom MCP servers only. Git provider tokens still reach the runtime during the engine's push and fetch windows, and each agent CLI still holds its model credentials. See [Architecture](../concepts/architecture.md#agent-runtime).
