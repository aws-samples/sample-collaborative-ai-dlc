# Agent sandboxing (Beta)

**Platform Admin → Agents → Sandboxing** configures
[Anthropic Sandbox Runtime (SRT)](https://github.com/anthropics/sandbox-runtime)
for agent harnesses and the commands they run. It can restrict filesystem access
and network egress across Claude Code, Kiro, Codex and OpenCode.

Sandboxing is disabled by default. This integration is beta. SRT is pinned to
**0.0.81** in both the settings API and runtime; the upstream documentation can
describe options from newer versions.

## Configure it

1. Open **Sandboxing**. The editor starts with the configuration below.
2. Turn on **Enable sandboxing for new runs**. On first enable, the starter
   configuration is saved and applied automatically.
3. Add restrictions to the JSON and press **Apply configuration** when ready.

```json
{
  "network": {
    "allowedDomains": [],
    "deniedDomains": [],
    "strictAllowlist": false,
    "allowAllUnixSockets": true
  },
  "filesystem": {
    "disabled": false,
    "allowWrite": ["/"],
    "denyRead": [
      "/home/node/.aws",
      "/home/node/.ssh",
      "/home/node/.git-credentials",
      "/home/node/.netrc"
    ],
    "denyWrite": [
      "/home/node/.aws",
      "/home/node/.ssh",
      "/home/node/.git-credentials",
      "/home/node/.netrc"
    ]
  }
}
```

This starter blocks access to the listed credential files and directories.
Other file access stays open, subject to OS permissions and SRT's built-in
protections. These rules cover files, not credentials supplied through environment
variables. Existing applied configurations are not replaced by this new starter.

Network destinations are allowed through SRT's proxy. The application explicitly approves unlisted destinations when
`strictAllowlist` is `false`; SRT still enforces `deniedDomains`. Unix sockets
remain available for the runtime's MCP bridge and harness helpers.

SRT still isolates direct networking. Programs that ignore HTTP/SOCKS proxy
settings, including direct SSH, UDP or raw TCP clients, can fail even with this
starter policy. Nested user/mount namespaces are also blocked; rootless
containers and browser namespace sandboxes can fail. The API and runtime reject
`allowNestedUserNamespaces: true` because it can bypass filesystem write denies.
This starter is not equivalent to running without a sandbox.

## Editing and applying

- **Draft autosave:** JSON syntax is checked in the browser. After typing pauses,
  the backend validates against the installed SRT schema and saves only valid
  configurations. Invalid edits show **Not saved** and leave the last valid draft
  and applied policy unchanged.
- **Apply configuration:** validates again and replaces the applied policy. It
  does not enable sandboxing.
- **Enable sandboxing:** immediately changes the setting for new runs using the
  applied policy, independently of unfinished editor changes. If no policy has
  been applied yet, it saves and uses the starter configuration, preserving any draft.
- **Restore applied / Restore starter:** replaces the editor draft with the
  applied policy, or the starter if nothing has been applied yet.
- Concurrent administrator edits return a conflict. Copy any edits you want to
  keep before reloading.

Only platform admins can read or change these policies. There are no space
overrides. Each intent captures the enabled flag, applied version and complete
configuration at its first start. Retries, resume and its assistant agents keep
that configuration. Intents started before this feature remain unsandboxed.
Draft assistants and connection checks select the current policy when invoked.
Changing or disabling the platform policy does not change running intents.

## Adding restrictions

For a domain block, keep `strictAllowlist: false` and add hosts to `deniedDomains`.
For an allowlist, set `strictAllowlist: true` and list every required destination
in `allowedDomains`: model providers, package registries and any external services
used by your tools. An empty strict allowlist blocks all external destinations.
Denied entries take precedence.

For additional file restrictions, add paths to `denyRead` and `denyWrite`.
`allowWrite: ["/"]` keeps other paths writable; reads are allowed unless denied.
The API rejects nonempty file rules while `disabled` is `true`, since SRT
would ignore them. Paths depend on the image and harness. The runtime adds its temporary
invocation directory to writable paths and, when file restrictions are enabled,
protects the command handoff file.
Do not assume `/mnt/workspace` alone is sufficient for every harness.
Write denies take precedence over nested write allows. Avoid denying all of
`/tmp`, which also makes the runtime's temporary invocation directory read-only.

See the [SRT configuration reference](https://github.com/anthropics/sandbox-runtime#configuration)
for option syntax. Validation rejects unknown keys, invalid field values, weaker
isolation modes, helper/binary overrides, platform-specific options for macOS and
Windows, and proxy/credential features that this integration does not support.
Proxy login, replacement proxies, TLS interception, custom certificate delivery
and SRT credential masking are not supported.
Callback-only options such as `network.allowPlaintextHeaderSet` and
`network.ambiguousRequestTarget` are also rejected: they require a
`filterRequest` callback, which cannot be supplied through this JSON editor.

Schema validation confirms the configuration's shape; it does not prove that
your allowed destinations and paths cover a particular workload.

### Parent proxy and violation suppression

Use `network.parentProxy` to route outbound traffic through a reachable corporate
HTTP(S) proxy without authentication. SRT still filters allowed and denied domains.
For example, add this object inside `network`:

```json
"parentProxy": {
  "http": "http://proxy.example.com:8080",
  "https": "http://proxy.example.com:8080",
  "noProxy": "internal.example.com"
}
```

`http` and `https` select the proxy for each destination protocol; both can use
the same proxy. `noProxy` bypasses the parent proxy for matching destinations,
but does not bypass SRT's domain rules. Invalid proxy addresses and URLs containing
credentials are rejected. Custom proxy certificates are not provisioned by Collab.

The top-level `ignoreViolations` option suppresses matching SRT observations,
without changing what is allowed or blocked. For example,
`"ignoreViolations": { "*": ["/tmp/noisy-path"] }` suppresses matching observations
for all commands. This does not suppress separate harness tool-failure logs.

## Domains for each harness

In the JSON editor, use the **?** beside **SRT settings** to open **Network access
help**. Copyable examples use the configured Bedrock inference region (or the
deployment region when unset). Copying an example does not change your policy.

For strict network filtering, start from the starter configuration, set
`network.strictAllowlist` to `true`, and add the domains for the harnesses you
use to `network.allowedDomains`. These are starting points from deployed
AgentCore tests with Kiro and Bedrock **API keys**, not a complete allowlist for
every authentication mode or project. The latest smoke tests ran all four
harnesses with the credential-file restrictions above enabled and
`network.allowAllUnixSockets: true`. The paired image tests separately verify
filesystem denials.

| Harness                 | Domains to allow for model access                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| Kiro                    | `*.kiro.dev`, `q.us-east-1.amazonaws.com`, `codewhisperer.us-east-1.amazonaws.com`                       |
| Claude Code on Bedrock  | `bedrock-runtime.<bedrock_region>.amazonaws.com`, `bedrock.<bedrock_region>.amazonaws.com`               |
| OpenCode on Bedrock     | `bedrock-runtime.<bedrock_region>.amazonaws.com`, `bedrock.<bedrock_region>.amazonaws.com`, `models.dev` |
| Codex on Bedrock Mantle | `bedrock-mantle.<bedrock_region>.api.aws`                                                                |

Replace `<bedrock_region>` with the **inference region**, for example
`bedrock-runtime.eu-central-1.amazonaws.com` or
`bedrock-mantle.us-east-1.api.aws`. It can differ from the deployment region.
The API key and model must be usable in that inference region. Global/cross-region
inference profiles route within Bedrock; the harness does not need every destination
region in its allowlist. SRT accepts a leading `*.` wildcard, but not a wildcard
in the middle: `bedrock-runtime.*.amazonaws.com` is invalid.

The Kiro list worked in the deployed tests; each domain has not been tested
independently. The Claude Code and OpenCode examples retain
`bedrock.<bedrock_region>.amazonaws.com`, the control-plane endpoint allowed during
the deployed tests. Whether it is required for every workflow has not been established.
OpenCode uses `models.dev` to refresh its model catalog; blocking it can leave newer
models unavailable. Codex was tested with `openai.gpt-5.6-sol` in `us-east-1`;
allowing an endpoint does not make a model available in that region.

These destinations were **blocked without preventing the tested stages** and are
not part of the suggested model-access list:

| Harness  | Blocked destinations                              |
| -------- | ------------------------------------------------- |
| OpenCode | `models.opencode.ai`                              |
| Codex    | `chatgpt.com`, `ab.chatgpt.com`, `api.github.com` |

External MCP services such as `mcp.context7.com` also remained blocked; their tools
are unavailable unless explicitly allowed. Package registries are project-specific:
for example, `registry.npmjs.org` for npm, or `pypi.org` and `files.pythonhosted.org`
for Python. Some tests allowed npm for their sample project; it is not a harness
requirement. Add only the services the project needs. GitHub access from agent
commands remains blocked unless allowed; engine-owned Git operations are outside SRT.

Apply the policy and start a **new intent** to test changes. Inspect `sandbox.denied`
events for the refused host, then decide whether the operation is required before
allowing it. A model `401` or `404` response can instead indicate a key-region mismatch
or an unavailable model; check the harness error alongside the sandbox events.

## Runtime and logs

The policy wraps harness launches, one-shot agent calls, script sensors and MCP
connection checks. Engine-owned Git, AWS SDK calls and the runtime-owned MCP server
remain outside this boundary. Tools served by those trusted services retain their
own authorization; an SRT policy is not an authorization policy for them.

Linux images need SRT, bubblewrap, socat, util-linux and the namespace support verified
by the image integration tests. The launcher uses `unshare` to give the SRT worker
a private `/proc`, allowing its namespace protection to work with AgentCore's
read-only `/proc/sys` without changing the host mounts.
Rebuild and deploy the runtime images and the Agents and
Intents APIs before enabling this setting. Older images do not implement the
configuration dispatch. Managed/custom environment revisions need rebuilding too;
an old image must not be treated as supporting this feature just because it runs Linux.

Existing logs report the selected policy version and enabled state per invocation.
Confirmed proxy denials include the host, port and reason. Harness tool failures
include bounded, redacted diagnostics at WARN; successful tool completions use
INFO. Filesystem and direct-network errors can appear in tool output without a
corresponding SRT denial event: SRT does not provide a complete audit of every
denied operation. No new conversation logging or dashboard is introduced.

See [Testing](../development/testing.md) for the paired `--sandbox` image tests.
Those check concrete allowed and denied operations. They do not replace testing
the deployed application's harnesses, authentication modes, MCP bridge and
build/test commands with the chosen policy.
