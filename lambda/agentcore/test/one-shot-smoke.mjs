#!/usr/bin/env node
// One-shot smoke test — run INSIDE the deployed AgentCore container (or any
// box with the agent CLIs installed + authed) to verify the enrichment
// inference path end to end against the REAL CLI binaries:
//
//   node test/one-shot-smoke.mjs [claude|kiro]
//
// Checks, per available CLI:
//   1. the CLI answers a trivial JSON-only prompt,
//   2. parseClaudeOneShot / the kiro branch extract non-empty text,
//   3. extractJsonObject parses the answer,
//   4. (claude) token usage arrives; (kiro) the credit footer is captured.
//
// Run this once per pin bump / CLI upgrade (see docs/v2-field-test.md).
// Exits 0 when every requested CLI passes, 1 otherwise.

import { runOneShotPrompt } from '../cli/one-shot.js';
import { extractJsonObject } from '../cli/one-shot.js';
import { discoverInstalledClis } from '../cli/discover.js';

const PROMPT = [
  'Respond with ONLY this exact JSON object and nothing else:',
  '{"gist": "smoke test ok", "claims": ["one", "two"]}',
].join('\n');

const main = async () => {
  const requested = process.argv[2] ?? null;
  const availableClis = await discoverInstalledClis();
  console.error(`installed CLIs: ${availableClis.join(', ') || 'none'}`);
  const targets = requested ? [requested] : availableClis;
  if (!targets.length) {
    console.error('FAIL: no CLI installed');
    process.exit(1);
  }

  let failed = false;
  for (const cli of targets) {
    console.error(`\n── one-shot via ${cli} ──`);
    const started = Date.now();
    const out = await runOneShotPrompt({
      prompt: PROMPT,
      requestedCli: cli,
      availableClis,
      timeoutMs: 120_000,
    });
    const ms = Date.now() - started;
    console.error(JSON.stringify({ ...out, text: out.text?.slice(0, 200) }, null, 2));
    if (!out.ok) {
      console.error(
        `FAIL(${cli}): ${out.reason} after ${ms}ms${out.sample ? ` — sample: ${out.sample}` : ''}`,
      );
      failed = true;
      continue;
    }
    const parsed = extractJsonObject(out.text);
    if (parsed?.gist !== 'smoke test ok') {
      console.error(
        `FAIL(${cli}): answer did not round-trip through extractJsonObject: ${out.text?.slice(0, 200)}`,
      );
      failed = true;
      continue;
    }
    if (cli === 'claude' && !out.metrics?.tokensInput) {
      console.error(
        `WARN(${cli}): no token usage captured — the stream-json result shape may have changed; check parseClaudeOneShot`,
      );
    }
    console.error(`PASS(${cli}) in ${ms}ms — metrics: ${JSON.stringify(out.metrics)}`);
  }
  process.exit(failed ? 1 : 0);
};

main().catch((e) => {
  console.error('smoke crashed:', e);
  process.exit(1);
});
