// Fetch project-scoped custom agent rules (user-uploaded .md reference docs)
// from S3. Metadata ([{filename, s3Key}]) is snapshotted onto the intent at
// create and forwarded here by the orchestrator. Best-effort: a missing bucket,
// key, oversized object, or fetch error skips that doc — never fails the stage.
//
// The bodies are written into the selected CLI's NATIVE rules directory
// (Claude: .claude/rules, Kiro: .kiro/steering) by the stage materializer, so
// the CLI auto-loads them — mirroring the retired v1 pool-worker
// `writeScopedRules` (commit acd2d33) rather than concatenating into the prompt.

import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import path from 'node:path';
import { s3 as defaultS3 } from './clients.js';

// Hard cap on a single custom-rule body. The 100 KB limit is enforced in the
// browser at upload time, but a presigned PUT has no server-side size
// constraint — a crafted client could upload a much larger object and inflate
// the CLI context / runtime memory. This runtime HeadObject guard is the
// definitive enforcement: oversized objects are skipped before we read them.
// Keep in sync with the frontend MAX_FILE_SIZE (CustomRulesSection.tsx).
const MAX_RULE_BYTES = 100 * 1024;

// Sanity guard on a stored s3Key: it must live under the custom-rules/ prefix
// (matches the projects lambda's presign path) and carry a .md basename with no
// traversal. Defence in depth — the API already validated on write.
const isSafeKey = (s3Key) => {
  if (typeof s3Key !== 'string' || !s3Key.startsWith('custom-rules/')) return false;
  const base = path.basename(s3Key);
  return base.toLowerCase().endsWith('.md') && base !== '..' && base !== '.';
};

// Fetch the bodies of the project's custom rules from S3. Returns an array of
// { filename, body } for docs that exist and are within the size cap. Pure of
// filesystem effects — the caller writes them into the driver's rules dir.
export const fetchCustomRules = async ({
  customRules = [],
  env = process.env,
  s3 = defaultS3,
  log = (...a) => console.error('[custom-rules]', ...a),
} = {}) => {
  const bucket = env.ARTIFACTS_BUCKET;
  if (!bucket || !Array.isArray(customRules) || customRules.length === 0) return [];

  const out = [];
  for (const doc of customRules) {
    if (!doc || !isSafeKey(doc.s3Key)) {
      if (doc?.s3Key) log(`skipping unsafe key: ${doc.s3Key}`);
      continue;
    }
    const filename = doc.filename || path.basename(doc.s3Key);
    try {
      // Size guard first (HeadObject is cheap): skip oversized objects before
      // reading the body into memory.
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: doc.s3Key }));
      if (typeof head.ContentLength === 'number' && head.ContentLength > MAX_RULE_BYTES) {
        log(
          `skipping ${doc.s3Key}: ${head.ContentLength} bytes exceeds ${MAX_RULE_BYTES}-byte limit`,
        );
        continue;
      }
      const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: doc.s3Key }));
      const body = await result.Body.transformToString();
      out.push({ filename, body });
    } catch (err) {
      log(`failed to fetch ${doc.s3Key}: ${err.message}`);
    }
  }
  return out;
};
