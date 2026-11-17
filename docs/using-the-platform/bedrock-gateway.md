# Bedrock gateway

A Bedrock gateway is a service your organization runs in front of Amazon Bedrock. It accepts the Bedrock `InvokeModel` API and authenticates callers with its own key instead of AWS credentials. Set `bedrock_gateway_url` to send Claude Code inference to such a gateway.

| Without a gateway                                      | With `bedrock_gateway_url`                     |
| ------------------------------------------------------ | ---------------------------------------------- |
| A Bedrock key is an Amazon Bedrock API key             | A Bedrock key is a gateway key, at every scope |
| Claude Code, OpenCode, and Codex call AWS with the key | Claude Code calls the gateway with the key     |
| OpenCode and Codex are available with a key            | OpenCode and Codex are unavailable with a key  |
| IAM mode calls Amazon Bedrock with the inference role  | Unchanged: IAM mode does not use the gateway   |
| Kiro uses its own API key                              | Unchanged                                      |

OpenCode and Codex can only call AWS endpoints. The runtime never hands them a gateway key, so the key cannot be sent to AWS.

## Before you start

**Authentication mode.** The gateway is used in **Keys** mode only. A platform administrator sees and changes the mode in **Admin → Agents → Platform Agent Credentials**. In [IAM mode](bedrock-iam.md) the setting has no effect: all three CLIs keep calling Amazon Bedrock with the inference role.

**Ask your gateway team for:**

- The URL, including the path prefix if the gateway serves the Bedrock paths under one.
- A key.
- The model IDs the gateway serves, and the AWS Region they belong to.
- Whether the gateway accepts callers from known addresses only.

**What the gateway must provide:**

- **Bedrock request format.** `POST /model/{modelId}/invoke` and `POST /model/{modelId}/invoke-with-response-stream` under the configured URL, with request and response bodies passed through unchanged. A gateway that offers the Anthropic Messages or an OpenAI-compatible format, such as LiteLLM's default endpoints, is a different kind and is not supported by this setting.
- **Bearer authentication.** Claude Code sends the saved key as `Authorization: Bearer <key>`. It sends no AWS signature.
- **HTTPS with a publicly trusted certificate.** The runtime has no setting for a private certificate authority.
- **Unchanged response headers.** If the gateway replaces the `Content-Type` of streamed responses, either fix that in the gateway or set `bedrock_gateway_disable_content_type_guard = true`.

When it starts, Claude Code also sends an unauthenticated `GET /inference-profiles` request to the gateway. The gateway may reject it.

**Network.** Only the agent runtime calls the gateway. It runs in the deployment's VPC and reaches the gateway over the internet through the deployment's NAT gateways. If the gateway accepts known addresses only, allow-list the addresses in the Terraform output `nat_egress_public_ips`; see [Static egress IPs](git-integration.md#static-egress-ips). A gateway that is reachable only inside a private network needs a route from the deployment's VPC, which this project does not create.

## Set it up

Step 2 applies only to a deployment that is already in use.

### Step 1: Check the gateway

Send one request from your machine with the URL, key and model you were given. The `read` line waits for you to paste the key and press Enter; the key is not shown.

```sh
GATEWAY_URL=https://gateway.example.com
MODEL=eu.anthropic.claude-sonnet-5-5
read -rs GATEWAY_KEY

curl -sS -X POST "$GATEWAY_URL/model/$MODEL/invoke" \
  -H "Authorization: Bearer $GATEWAY_KEY" \
  -H "Content-Type: application/json" \
  -d '{"anthropic_version":"bedrock-2023-05-31","max_tokens":32,"messages":[{"role":"user","content":"Reply with OK"}]}'
```

A JSON message whose `content` holds the reply means that the URL, the key and the model ID are right. Use exactly this `GATEWAY_URL` as `bedrock_gateway_url` in step 3. This check does not show that the agent runtime can reach the gateway; step 7 does.

### Step 2: Prepare a deployment that is in use

Skip this step on a deployment without saved Bedrock keys and without agent work.

Two facts decide what to prepare:

- From the deployment on, every saved Bedrock key is used as a gateway key. The platform cannot tell an Amazon Bedrock API key from a gateway key, so an Amazon Bedrock API key that is still saved is sent to the gateway.
- A runtime gets a Bedrock key only when its own gateway setting matches the deployment's, and not every runtime gets the setting with the deployment. A runtime session that was started before the deployment keeps running without it until it ends: after 15 minutes without activity, at the latest after 8 hours. A [managed environment](managed-environments.md) has it only in a revision that is built after the deployment as step 4 describes, and an intent keeps the revision it was created with, also when it is resumed or rewound.

A runtime without the matching setting is refused the key. Its agent runs fail, and the key is sent nowhere. So agent work that is under way during the deployment can fail until its runtime session has ended, and intents in a managed environment cannot continue.

**The deployment refuses while intents are started.** `deploy-terraform.sh`, which the managed installer also runs, stops before it changes anything if the plan sets, changes or removes `bedrock_gateway_url` while an intent is started, running or parked. It lists each one with its execution ID, its space (`project`) and its status. Drafts and finished, failed or cancelled intents do not count.

Pick a window without agent work and tell your users [what changes for them](#what-changes-for-users). An intent keeps the CLI, the models and the environment revision it was created with, so before the window:

- Finish or cancel intents that run OpenCode or Codex with a Bedrock key. They cannot continue after the deployment.
- Finish intents in a managed environment, or cancel them and create new ones after step 4. They keep their revision from before the deployment, which is refused the key.
- Finish intents whose models the gateway does not serve.
- Intents that run Claude Code in the Standard environment can continue with the gateway. Cancel them and [restart them from their current stage](intent-observability.md#steering-and-rewind) after step 5, or leave them parked as described next.

**Deploying with parked intents.** Set `AIDLC_ALLOW_ACTIVE_EXECUTIONS=1` in the environment of the deploy command in step 3, the deploy script or the installer, to deploy despite the listed intents. Do this only when every listed intent is parked, runs Claude Code in the Standard environment and uses models the gateway serves. Do not resume those intents before step 5 is done.

The check does not cover everything:

- It sees intents only. **Compose with AI** and discussion assists also use runtime sessions. One that was started before the deployment fails until it has ended.
- It does not see an intent that finished in a managed environment and is restarted later. That intent still runs in its revision from before the deployment and is refused the key.
- It is part of the deploy script. A direct `terraform apply` skips it.

**Amazon Bedrock API keys.** After the deployment, a saved Amazon Bedrock API key is presented to the gateway whenever its owner runs Claude Code, and the gateway rejects it. To prevent that, clear the keys before the deployment with **Clear** next to the key: the platform key in **Admin → Agents**, space keys in **Space Settings → Agent**, and personal keys in each user's **Account Settings**. Otherwise their owners replace them in step 5. With the keys cleared, Claude Code, OpenCode and Codex have no Bedrock key until step 5.

### Step 3: Configure and deploy

Set the gateway in the deployment's `.tfvars` file:

| Installation      | File                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| Manual            | `terraform/environments/<environment>.tfvars`                                                    |
| Managed installer | `${XDG_CONFIG_HOME:-~/.config}/collaborative-ai-dlc/terraform/environments/<environment>.tfvars` |

```hcl
bedrock_gateway_url = "https://gateway.example.com"
bedrock_region      = "eu-central-1"
bedrock_model       = "eu.anthropic.claude-sonnet-5-5"

bedrock_model_aliases = {
  opus   = "eu.anthropic.claude-opus-5-5"
  sonnet = "eu.anthropic.claude-sonnet-5-5"
  haiku  = "eu.anthropic.claude-haiku-5-5"
}

# Only when the gateway changes the Content-Type of streamed responses.
# bedrock_gateway_disable_content_type_guard = true
```

A variable may be set only once in the file. `bedrock_model` is usually set there already, and `bedrock_region` may be: change those lines instead of adding second ones. Otherwise the deployment stops with `Attribute redefined` before it changes anything.

| Variable                                     | Meaning                                                                                                                                                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bedrock_gateway_url`                        | HTTPS URL of the gateway, without credentials, query or fragment. Include the path prefix: a gateway that serves `https://gateway.example.com/bedrock/model/...` is `https://gateway.example.com/bedrock`. Empty (the default) means no gateway                           |
| `bedrock_region`                             | The Region of the gateway's model IDs, called the inference region below. Claude Code sends no request to this Region when it uses a gateway key. The Region still decides the geo prefix of aliases, the model lists in the pickers and the prices behind cost estimates |
| `bedrock_model`                              | The model Claude Code uses when no default, space, tier or workflow model applies. Its built-in value may not be served by your gateway, so set it                                                                                                                        |
| `bedrock_model_aliases`                      | Model IDs for `opus`, `sonnet` and `haiku`; see [Model aliases](#model-aliases). Set all three to models the gateway serves                                                                                                                                               |
| `bedrock_gateway_disable_content_type_guard` | `true` makes Claude Code skip its check that a streamed response is `application/vnd.amazon.eventstream`. Ignored without a gateway                                                                                                                                       |

With a strict [sandbox allowlist](agent-sandboxing.md#domains-for-each-harness), also add the gateway host there. A Claude Code run with a gateway key calls no Amazon Bedrock endpoint.

Then deploy. For a manual installation, set `AIDLC_ENVIRONMENT` to the `environment` value of the `.tfvars` file and run both scripts, as for any [update](../getting-started/setup.md#updating-a-deployment):

```sh
: "${AIDLC_ENVIRONMENT:?Set AIDLC_ENVIRONMENT to your configured environment}"
./scripts/deploy-terraform.sh "$AIDLC_ENVIRONMENT" &&
  ./scripts/deploy-frontend.sh "$AIDLC_ENVIRONMENT"
```

For a managed installation, run the update with `--reapply`:

```sh
bash /tmp/aidlc-install.sh update --reapply
```

It moves the deployment to the newest release, or deploys the installed release again if there is no newer one, and applies the `.tfvars` file in both cases. Without `--reapply`, `update` stops with `Already on AI-DLC v<version>.` when the release is unchanged. If the installer answers `Unknown option: --reapply`, your copy is older than the option: download it again as in [Managed installation](../getting-started/setup.md#managed-installation).

If the deployment stops with `Refusing Terraform plan: it changes bedrock_gateway_url`, intents are still started: go back to step 2.

**Confirm that the setting is live.** Open **Admin → Agents → Platform Agent Credentials**. The key field is labelled **Bedrock Gateway Key** and the text below it names the gateway host. If the field still reads **Bedrock Bearer Token**, the setting is not deployed: do not save a gateway key. Until the setting is deployed, a saved key is used as an Amazon Bedrock API key and sent to Amazon Bedrock.

### Step 4: Rebuild managed environments

Skip this step if every space uses **Standard**. The deployment updates the Standard runtime, and its sessions started afterwards have the setting.

Every other environment uses the gateway only in a revision that meets two conditions:

- It is built after the deployment. Only then does its runtime have the setting.
- It is built on a Standard revision from a platform release that supports the gateway. A revision takes its runtime code from the Standard revision that is published when it is built, and a platform update does not publish Standard's new revision for you. A revision built on an earlier Standard revision has the setting but cannot use it.

A revision that misses either condition is refused the Bedrock key, and agent runs in it fail; see [Troubleshooting](#troubleshooting).

In **Admin → Environments**:

1. Open **Standard** and its **Revisions** tab. If a revision with the status `READY` is newer than the published one, publish it. Platform updates add such a revision, so check this also when this deployment changed only the gateway settings: the revision may be left from an earlier update.
2. For each environment, choose **Rebuild on latest base**, then build, review and publish the new revision. See [Use a newer base revision](managed-environments.md#use-a-newer-base-revision). Rebuild an environment that is based on another environment after that one is published.

**Rebuild on latest base** is offered only when the base's published revision changed. It is missing when Standard was already up to date in the first step and you changed only the gateway settings. Then create the revision yourself: open the environment's **Definition**, change it (for example its description), choose **Save as new revision**, then build and publish it. Do not use this in place of the first step: the revision would then be built on the earlier Standard revision, and agent runs in it would fail.

New intents in the environment's spaces use the published revision. Intents created earlier keep theirs.

### Step 5: Save the gateway keys

Save the keys once step 3 shows that the setting is live. On a deployment that is in use, a runtime session from before the deployment cannot use them: agent work in it fails until the session has ended. Without agent work, that is 15 minutes after the last agent activity, which includes **Compose with AI** and discussion assists.

The key goes where a Bedrock API key goes, with the same [credential hierarchy](platform-settings.md#credential-hierarchy):

- **Admin → Agents → Platform Agent Credentials** for the fallback key.
- **Space Settings → Agent** for a key shared by a space, for example one gateway account per team.
- **Account Settings** for a personal key.

Rotate a key through the same field before it expires. A rotated key applies from the next agent invocation.

The platform does not check a key against the gateway when it is saved. A wrong or expired key shows up when an agent runs.

### Step 6: Choose models

In **Admin → Agents → Default Models**, select the Claude Code default and any **Per-tier overrides** from the models the gateway serves. A space's **Model Override** in **Space Settings → Agent** takes precedence, so check the spaces that set one. With no default selected, Claude Code uses `bedrock_model`.

The pickers list the Bedrock inference profiles of the deployment's own AWS account in the inference region. They do not know the gateway's model list, so a listed model can still be refused by the gateway.

### Step 7: Run a first test

In a test space, create an intent, choose **Claude Code** on the compose step and use **Compose with AI**. A proposed scope means that the runtime reached the gateway and the key and model were accepted. Then start the intent and let one stage finish.

If it fails, see [Troubleshooting](#troubleshooting).

## Model aliases

Workflow blocks can name a model by the alias `opus`, `sonnet` or `haiku`, and Claude Code uses the same aliases for its subagents and background calls. Each alias has a built-in target that a gateway or an account may not serve:

| Alias    | Built-in target in workflow blocks    |
| -------- | ------------------------------------- |
| `opus`   | `anthropic.claude-opus-4-6-v1`        |
| `sonnet` | `anthropic.claude-sonnet-4-6`         |
| `haiku`  | `anthropic.claude-haiku-4-5-20251001` |

Claude Code's own targets depend on its version. It calls the `haiku` target in the background even when a run uses another model.

`bedrock_model_aliases` sets the target of each alias you list. Blocks that name the alias resolve to it, and Claude Code is pinned to the same model. An alias you leave out keeps its built-in target. An ID that starts with `anthropic.` gets the geo prefix of the inference region (`us.`, `eu.` or `apac.`). Any other ID, for example one that starts with `eu.` or `global.`, is used as written. The variable works with and without a gateway.

## What changes for users

- **Keys.** A personal Amazon Bedrock API key no longer works. Its owner replaces it with a gateway key in **Account Settings**, or clears it to use the space or platform key.
- **CLIs.** For anyone whose Bedrock credential is a key, OpenCode and Codex are marked "not supported by the Bedrock gateway". On the intent compose page they are greyed out: choose Claude Code or Kiro. In **Space Settings → Agent** they carry the same mark but can still be selected as the **Recommended CLI**, so a space that recommends OpenCode or Codex needs a new recommendation.
- **Kiro** keeps its own API key and is not affected.
- **Costs.** [Cost figures](intent-observability.md#where-prices-come-from) stay estimates from AWS list prices for the inference region. The gateway's own accounting is the billing record.

## Troubleshooting

The gateway decides whether a key, a model or a budget is accepted. In tests against a stand-in gateway, Claude Code 2.1.296 retried responses with HTTP status 401, 403 and 429 for about three minutes before the stage failed.

| What you see                                                                                                                                   | Cause                                                                                                                                                                                               | What to do                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| The deployment stops with `Refusing Terraform plan: it changes bedrock_gateway_url`                                                            | Intents are started, running or parked                                                                                                                                                              | Finish or cancel the listed intents, or see **Deploying with parked intents** in step 2                                                     |
| The deployment stops with `Error: Attribute redefined`                                                                                         | The `.tfvars` file sets a variable twice, for example `bedrock_model`                                                                                                                               | Keep one line for each variable (step 3)                                                                                                    |
| The key field reads **Bedrock Bearer Token**                                                                                                   | The setting is not deployed                                                                                                                                                                         | Check the `.tfvars` file and deploy again (step 3)                                                                                          |
| A stage fails with "The pinned agent credential was rejected; rotate it at the selected credential scope"                                      | The gateway answered 401 or 403: a wrong or expired key, an Amazon Bedrock API key that was not replaced, or a model the key may not use. Claude Code reports both the same way                     | Repeat the check from step 1 with that key and model                                                                                        |
| A stage fails with the gateway's own message                                                                                                   | 429: a budget or rate limit was reached. It is not recognized as an exhausted credential unless the gateway's wording says so                                                                       | Check the account's limits in the gateway                                                                                                   |
| `Bedrock streaming response has content-type "..."; expected "application/vnd.amazon.eventstream"`                                             | The gateway changes the `Content-Type` of streamed responses                                                                                                                                        | Fix the gateway, or set `bedrock_gateway_disable_content_type_guard = true` and deploy                                                      |
| The check from step 1 passes, but agent runs fail to connect                                                                                   | The runtime cannot reach the gateway, or `bedrock_gateway_url` differs from the URL you checked                                                                                                     | Compare the URL and its path prefix, the gateway's address allow-list (see [Before you start](#before-you-start)) and the sandbox allowlist |
| An agent run fails, and its error or the logs name `Credential material is unsupported by this runtime`                                        | The runtime's code is from before this platform release: an environment revision built on an earlier Standard revision, or a Standard runtime session from before the update. It is refused the key | Publish Standard's newest revision and rebuild the environment (step 4). In Standard, try again after 15 minutes without agent activity     |
| An agent run fails, and its error or the logs name `This runtime is not configured for the Bedrock gateway that the key belongs to`            | The runtime does not have the deployment's `bedrock_gateway_url`: a runtime session from before the deployment, or an environment revision built before it. It is refused the key                   | Rebuild the environment (step 4). In Standard, try again after 15 minutes without agent activity                                            |
| An agent run fails, and its error or the logs name `This runtime is configured for a Bedrock gateway and cannot use an Amazon Bedrock API key` | The gateway was removed from the deployment, and this runtime session or environment revision is from before that                                                                                   | Rebuild the environment as in [Turn it off](#turn-it-off). In Standard, try again after 15 minutes without agent activity                   |

## Turn it off

The same two facts apply in reverse: from the deployment on, every saved Bedrock key is used as an Amazon Bedrock API key, and a runtime that still has the gateway setting is refused it.

1. Prepare as in step 2: the deployment refuses this change, too, while intents are started. Clear the gateway keys, or accept that each one is presented to Amazon Bedrock and rejected until its owner replaces it.
2. Remove `bedrock_gateway_url` from the `.tfvars` file and deploy as in step 3. The key field reads **Bedrock Bearer Token** again.
3. Rebuild the managed environments as in step 4. A revision that was built with the gateway keeps the setting and is refused the key, and so are the intents created on it.
4. Save Amazon Bedrock API keys and select models that your account serves. OpenCode and Codex are available with a key again.

## Limits

- The gateway is a deployment setting, like the inference region. Every Bedrock key at every scope is a gateway key; a single space cannot keep calling Amazon Bedrock with a key.
- The setting applies to Keys mode. In [IAM mode](bedrock-iam.md) all three CLIs keep calling Amazon Bedrock with the inference role.
- The gateway URL is not pinned to an intent. An intent in the Standard environment uses the gateway in every runtime session started after the deployment. An intent in a managed environment follows the revision it was created with, and runs only while that revision's gateway setting matches the deployment's.

## Test a gateway locally

Contributors can run Claude Code through a gateway with the local agent lifecycle test. It needs a checkout and Docker, makes real model calls, and runs on your machine, so it does not show that the deployed runtime can reach the gateway:

```sh
BEDROCK_GATEWAY_URL=https://gateway.example.com \
  BEDROCK_API_KEY=<gateway key> \
  BEDROCK_MODEL=eu.anthropic.claude-sonnet-5-5 AWS_REGION=eu-central-1 \
  E2E_CLIS=claude ./scripts/agent-e2e-testing.sh
```

See [Testing](../development/testing.md#local-multi-cli-e2e) for the prerequisites.
