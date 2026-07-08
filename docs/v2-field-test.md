# V2 Granular-Graph Field Test — Runbook

How to deploy, smoke-check, and run the first real-world test of the granular
graph mechanism (docs/v2-graph-context.md), and how to judge the result.

## 1. Deployment checklist (terraform apply)

This feature set changes infrastructure — a plain code deploy is not enough:

- **New SSM parameter** `/{project}/{env}/derive-enrichment` (agentcore module;
  `ignore_changes` — the Admin UI owns the value after first apply).
- **IAM**: agents lambda (rw on the new param), intents lambda (ro on the new
  param + `bedrock-agentcore:InvokeAgentRuntime` for the derive backfill).
- **Intents lambda env**: `AGENTCORE_RUNTIME_ARN`.
- **New API Gateway routes**: `GET .../intents/{id}/audit` (note: the audit
  route existed in code but was never routed before this work) and
  `POST .../intents/{id}/derive` — the deployment trigger includes them, but
  verify the stage redeployed (`terraform apply` output) or the Audit page
  404s.
- Removed: the `v2_derive_enrichment` terraform var / `V2_DERIVE_ENRICHMENT`
  container env (replaced by the Admin setting).

## 2. Container smoke test (once per deploy / pin bump / CLI upgrade)

The enrichment path depends on the REAL CLI binaries' output shapes. Verify
in the deployed container (or any box with the CLIs installed + authed):

```
node lambda/agentcore/test/one-shot-smoke.mjs           # all installed CLIs
node lambda/agentcore/test/one-shot-smoke.mjs claude    # one CLI
```

PASS per CLI = the CLI answered, the parser extracted text, the JSON
round-tripped. A `WARN … no token usage captured` on claude means the
stream-json result shape changed — fix `parseClaudeOneShot` before enabling
`llm` mode (enrichment would still work, but spend would be uncosted).

## 3. Pin-bump procedure (aidlc_repo_ref)

1. Bump `aidlc_repo_ref` in terraform/variables.tf.
2. `node scripts/snapshot-upstream-artifacts.mjs` and commit the regenerated
   `lambda/shared/upstream-artifact-ids.json`.
3. `npm test` — the pin-drift tests fail if upstream renamed any artifact id
   the extraction registry targets; realign the registry before deploying.
4. Re-run the container smoke test after the image rebuilds.

## 4. Test protocol

Run **at least two comparable intents** on a representative project (same
scope, similar size), one with the Admin enrichment toggle **off**, one **on**
(Platform Admin → Agents → Graph Enrichment; the snapshot is taken at intent
create, so flip BEFORE creating the intent).

Everything below reads off each intent's **Audit** page (or
`GET .../intents/{id}/audit`).

### Pass criteria

| #   | Signal                           | Where                                 | Target                                                                                                                |
| --- | -------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1   | Structure-contract compliance    | derivation card, `complianceRate`     | ≥ 0.9 on registered types (`requirements`, `stories`, `personas`, `components`, `decisions`, story map, contracts)    |
| 2   | Derivation health                | derivation card                       | `failures: 0`; items > 0 for every registered artifact                                                                |
| 3   | Compact-read adoption            | enrichment card, `compactShare`       | materially above the pre-feature baseline; `get_items`/`get_section`/`get_coverage` calls > 0 in construction lanes   |
| 4   | Enrichment ROI (llm intent only) | enrichment card + prompt-context line | enrichment tokens ≪ full-read bytes avoided vs the off intent; `enrichment-unused` advisory ABSENT                    |
| 5   | Prompt cost                      | prompt-context line                   | `compiledContextBytes` share of `promptBytes` stays modest (≲ 25%); total prompt sizes comparable to pre-feature runs |
| 6   | Coverage integrity               | advisories + graph-coverage findings  | findings actionable, no false positives on a healthy run                                                              |

### Failure diagnosis

- `structured-block-missing` advisories → agents ignored the contracts; check
  the artifact prose vs. the injected contract (prompt is reproducible), then
  consider wording fixes before flipping `strictStructuredBlocks`.
- `v2.derive.enrichment_skipped` events carry the failure reason **and a
  bounded raw-output sample** — enough to diagnose CLI/model issues from the
  event feed.
- One-shot timeouts surface as reason `timeout`; the per-derive budget as
  `budget_exhausted` (rerun via the backfill below — unchanged artifacts are
  free).

## 5. Backfill

`POST /projects/{projectId}/intents/{intentId}/derive` (platform admin,
refused while RUNNING) projects an existing intent's artifacts — use it for
intents predating the feature, or to apply enrichment after flipping the
toggle. Idempotent.

## 6. After the test

- Compliance ≥ target → flip `strictStructuredBlocks` on the authored
  `required-sections` sensor rows (data change) so absent blocks start
  blocking.
- Adoption low → inspect reads-by-tool: if full `get_artifact` dominates,
  tighten the annex's compact-first ladder or the tool descriptions.
- Decide `graph-coverage` severity: the platform injects it as advisory;
  promote to an authored blocking row where the findings proved trustworthy.
