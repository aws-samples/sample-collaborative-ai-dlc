// Seeds the SYSTEM baseline block library from the official aidlc-workflows
// repo at a pinned commit. The seed is the single fetch point: it downloads the
// repo tarball at the pinned ref, parses every core/** file, and writes:
//   - editable BLOCKS (stage/agent/scope/rule/sensor/knowledge/skill/template)
//     into the blocks table, each with its markdown body externalized to S3;
//   - the SENSOR check SCRIPTS (core/tools/aidlc-sensor-<id>.ts) to S3 as each
//     sensor's scriptRef;
//   - the `aidlc-v2` default WORKFLOW (phases + placements + rule refs) derived
//     from the parsed stages;
//   - the INTERNAL RUNTIME files (engine tools, hooks, protocols, conductor) to
//     a commit-pinned S3 snapshot under aidlc-runtime/<ref>/<repo-path> — NOT
//     editable blocks, but available for the execution layer to inject.
//   - a body-free METHODOLOGY CATALOG under aidlc-catalogs/v1/<ref>.json so
//     historical exports survive replacement of the mutable SYSTEM catalog.
//
// The pinned ref comes from the AIDLC_REPO_REF env var (set by Terraform) and
// can be overridden per-invoke with {"ref":"<sha|tag|branch>"}.
//
// Admin one-shot, invoked directly via `aws lambda invoke` (no API route):
//
//   # Dry-run first to preview what would be written
//   aws lambda invoke \
//     --function-name $(terraform output -raw seed_blocks_lambda_name) \
//     --payload '{"dryRun":true}' --cli-binary-format raw-in-base64-out /tmp/out.json
//
//   # Apply (insert-only: adds blocks new since the last run, skips existing)
//   aws lambda invoke \
//     --function-name $(terraform output -raw seed_blocks_lambda_name) \
//     --payload '{}' --cli-binary-format raw-in-base64-out /tmp/out.json
//
//   # Reseed the whole SYSTEM baseline fresh (e.g. after bumping the pin)
//   aws lambda invoke \
//     --function-name $(terraform output -raw seed_blocks_lambda_name) \
//     --payload '{"reseed":true}' --cli-binary-format raw-in-base64-out /tmp/out.json
//
//   # Seed from a specific ref instead of the pinned default
//   aws lambda invoke \
//     --function-name $(terraform output -raw seed_blocks_lambda_name) \
//     --payload '{"reseed":true,"ref":"v2"}' --cli-binary-format raw-in-base64-out /tmp/out.json
//
//   # Stage one allowlisted AI-DLC release into immutable release storage only
//   # (no SYSTEM blocks, no DynamoDB access, no aidlc-runtime/ or aidlc-catalogs/
//   # writes). Preview first, then publish:
//   aws lambda invoke \
//     --function-name $(terraform output -raw seed_blocks_lambda_name) \
//     --payload '{"importRelease":true,"profile":"v2.9.0","dryRun":true}' \
//     --cli-binary-format raw-in-base64-out /tmp/out.json
//   aws lambda invoke \
//     --function-name $(terraform output -raw seed_blocks_lambda_name) \
//     --payload '{"importRelease":true,"profile":"v2.9.0"}' \
//     --cli-binary-format raw-in-base64-out /tmp/out.json
//
//   # After an importer revision bump, publish the SAME profile's corrected
//   # closure at the new revision (a new i<N> prefix; older closures are never
//   # touched), then upgrade the registry record with
//   # PATCH /aidlc-releases/{releaseId} {"expectedRevision":<n>,"importerRevision":<N>}:
//   aws lambda invoke \
//     --function-name $(terraform output -raw seed_blocks_lambda_name) \
//     --payload '{"importRelease":true,"profile":"v2.9.0","importerRevision":2}' \
//     --cli-binary-format raw-in-base64-out /tmp/out.json
//
//   # Stage a CUSTOM FORK commit (import-only, never runnable). The fork must be
//   # pinned to an exact 40-hex SHA and must name the official profile whose
//   # frontmatter dialect it is parsed with:
//   aws lambda invoke \
//     --function-name $(terraform output -raw seed_blocks_lambda_name) \
//     --payload '{"importRelease":true,"custom":{"repository":"acme/aidlc-workflows-fork","sha":"<40-hex-sha>","baseProfile":"v2.9.0"},"dryRun":true}' \
//     --cli-binary-format raw-in-base64-out /tmp/out.json
//
// Three modes:
//   - Default (insert-only): a conditional write skips any block that already
//     exists, so re-running only inserts blocks added since the last run. Safe,
//     but it CANNOT update an existing baseline block.
//   - reseed: DELETES every SYSTEM-owned partition (BLOCK#SYSTEM#* and
//     WF#SYSTEM#*) first, then writes the full current baseline fresh. Scoped to
//     SYSTEM only — customer forks (BLOCK#default# / WF#default#) are untouched.
//     Combine with dryRun to preview the clear without deleting.
//   - importRelease: stages one release commit under
//     aidlc-releases/v1/<sha>/i<importerRevision>/ (official) or
//     aidlc-releases/v1/custom/<owner>/<name>/<sha>/i<importerRevision>/ (fork)
//     plus its content-addressed bodies/scripts/runtime objects, and returns
//     before touching DynamoDB. An official commit is resolved only from the
//     compatibility profile allowlist and a fork only from an exact SHA, so this
//     mode rejects {"ref":...} and cannot be combined with reseed.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { Logger } from '@aws-lambda-powertools/logger';
import {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SYSTEM_TENANT } from '../shared/tenant.js';
import { fetchCoreFiles } from '../shared/repo-fetch.js';
import { resolveAidlcRepoRef } from '../shared/aidlc-ref.js';
import { buildFromFiles } from '../shared/block-mappers.js';
import { customProfile, profileFor } from '../shared/aidlc-compatibility-profiles.js';
import {
  AIDLC_RELEASE_IMPORTER_REVISION,
  buildReleaseBundle,
  publishReleaseBundle,
  releaseKeyArgs,
  releaseManifestKey,
} from '../shared/aidlc-release.js';
import {
  buildMethodologyCatalog,
  methodologyCatalogKey,
  writeMethodologyCatalog,
} from '../shared/methodology-catalog.js';
import {
  LATEST,
  blockPk,
  versionSk,
  catalogGsi1Pk,
  buildBodyRef,
  buildScriptRef,
} from '../shared/blocks.js';
import {
  META,
  workflowPk,
  phaseSk,
  placementSk,
  ruleRefSk,
  scopeRefSk,
  workflowVersionSk,
  workflowGsi1Pk,
} from '../shared/workflows.js';

const logger = new Logger({ persistentKeys: { component: 'seed-blocks' } });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const blocksTable = () => process.env.BLOCKS_TABLE;
const artifactsBucket = () => process.env.ARTIFACTS_BUCKET;
const defaultRef = () => process.env.AIDLC_REPO_REF;

const isConditionalCheckFailed = (err) => err?.name === 'ConditionalCheckFailedException';

// The S3 prefix for the commit-pinned internal runtime snapshot.
const runtimePrefix = (ref) => `aidlc-runtime/${ref}`;
const runtimeKey = (ref, repoPath) => `${runtimePrefix(ref)}/${repoPath}`;

// Builds the two stored items (V#latest pointer + V#1 snapshot) for a block,
// with its body (and, for a sensor, its script) externalized to S3.
const buildItems = (block, bodyRef, scriptRef, now, sourceRef) => {
  const { type, id, name, body, script, ...attrs } = block;
  void body; // externalized into bodyRef
  void script; // externalized into scriptRef
  const base = {
    pk: blockPk(SYSTEM_TENANT, type, id),
    tenantId: SYSTEM_TENANT,
    blockType: type,
    blockId: id,
    name,
    version: 1,
    sourceRef,
    bodyRef,
    ...(scriptRef ? { scriptRef } : {}),
    createdAt: now,
    updatedAt: now,
    ...attrs,
  };
  return {
    latest: { ...base, sk: LATEST, GSI1PK: catalogGsi1Pk(SYSTEM_TENANT, type), GSI1SK: name },
    snapshot: { ...base, sk: versionSk(1) },
  };
};

const workflowSnapshotItem = (item, version) => {
  const snapshot = { ...item, sk: workflowVersionSk(version, item.sk), version };
  delete snapshot.GSI1PK;
  delete snapshot.GSI1SK;
  if (snapshot.type === 'StagePlacement' && snapshot.pinnedVersion == null) {
    // Baseline block versions are seeded as V#1 in the same run.
    snapshot.pinnedVersion = 1;
  }
  return snapshot;
};

// Builds the items for a baseline workflow partition: the META header (carrying
// the workflow catalog GSI1 keys), the inline phase tree, stage placements, rule
// refs, and immutable V#1 workflow snapshot rows.
const buildWorkflowItems = (wf, now, sourceRef) => {
  const pk = workflowPk(SYSTEM_TENANT, wf.id);
  const meta = {
    pk,
    sk: META,
    type: 'Workflow',
    tenantId: SYSTEM_TENANT,
    workflowId: wf.id,
    name: wf.name,
    objective: wf.objective ?? '',
    basedOn: null,
    defaultScope: wf.defaultScope ?? null,
    status: 'PUBLISHED',
    version: 1,
    sourceRef,
    createdAt: now,
    updatedAt: now,
    GSI1PK: workflowGsi1Pk(SYSTEM_TENANT),
    GSI1SK: wf.name,
  };
  const phases = (wf.phases ?? []).map((node) => ({
    pk,
    sk: phaseSk(node.path, node.phaseId),
    type: 'Phase',
    phaseId: node.phaseId,
    name: node.name ?? node.phaseId,
    kind: node.kind ?? 'phase',
    path: node.path,
    parentPath: node.path.includes('.') ? node.path.split('.').slice(0, -1).join('.') : null,
    order: Number(node.path.split('.').at(-1)),
  }));
  const placements = (wf.placements ?? []).map((p) => ({
    pk,
    sk: placementSk(p.stageId),
    type: 'StagePlacement',
    stageId: p.stageId,
    stageTenant: p.stageTenant ?? SYSTEM_TENANT,
    pinnedVersion: p.pinnedVersion ?? null,
    phasePath: p.phasePath ?? null,
    order: typeof p.order === 'number' ? p.order : 0,
    scopeMembership: p.scopeMembership ?? {},
  }));
  const ruleRefs = (wf.ruleRefs ?? []).map((rr) => ({
    pk,
    sk: ruleRefSk(rr.layer, rr.ruleId),
    type: 'RuleRef',
    ruleId: rr.ruleId,
    layer: rr.layer,
    ruleTenant: rr.ruleTenant ?? SYSTEM_TENANT,
  }));
  const scopeRefs = (wf.scopeRefs ?? []).map((sr) => ({
    pk,
    sk: scopeRefSk(sr.scopeId),
    type: 'ScopeRef',
    scopeId: sr.scopeId,
    scopeTenant: sr.scopeTenant ?? SYSTEM_TENANT,
  }));
  const liveItems = [meta, ...phases, ...placements, ...ruleRefs, ...scopeRefs];
  const snapshots = liveItems.map((item) => workflowSnapshotItem(item, 1));
  return {
    meta,
    children: [...phases, ...placements, ...ruleRefs, ...scopeRefs, ...snapshots],
  };
};

// Deletes every SYSTEM-owned partition (BLOCK#SYSTEM#* and WF#SYSTEM#*) so the
// imported baseline can be rewritten fresh. Scoped by a FilterExpression on the
// pk prefix — user-created/forked rows are never matched. Returns the count of
// deleted items (or, on dryRun, the count that would be deleted).
const clearSystemPartitions = async (dryRun) => {
  const keys = [];
  let lastKey;
  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: blocksTable(),
        FilterExpression: 'begins_with(pk, :blockSys) OR begins_with(pk, :wfSys)',
        ExpressionAttributeValues: {
          ':blockSys': `BLOCK#${SYSTEM_TENANT}#`,
          ':wfSys': `WF#${SYSTEM_TENANT}#`,
        },
        ProjectionExpression: 'pk, sk',
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of page.Items || []) keys.push({ pk: item.pk, sk: item.sk });
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);

  if (dryRun) return keys.length;

  for (let i = 0; i < keys.length; i += 25) {
    const group = keys.slice(i, i + 25);
    await ddb.send(
      new BatchWriteCommand({
        RequestItems: {
          [blocksTable()]: group.map((Key) => ({ DeleteRequest: { Key } })),
        },
      }),
    );
  }
  return keys.length;
};

const putObject = (key, body, contentType) =>
  s3.send(
    new PutObjectCommand({
      Bucket: artifactsBucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );

// Stages one release commit into immutable release storage. This path
// deliberately shares nothing with the SYSTEM seed below: no DynamoDB access,
// no SYSTEM partition clear, and no aidlc-runtime/ or aidlc-catalogs/ writes,
// so an import can never change what a running intent resolves to.
//
// Two mutually exclusive sources: an allowlisted official `profile` id, or a
// `custom` fork pinned to an exact SHA. A custom import lands on its own
// `custom/<owner>/<name>/` prefix, is recorded T0, and is never runnable.
const importRelease = async ({ event, dryRun, reseed }) => {
  if (reseed) {
    throw new Error('seed-blocks: importRelease cannot be combined with reseed');
  }
  if (event?.ref != null) {
    throw new Error(
      'seed-blocks: importRelease resolves its commit from the profile allowlist — remove "ref"',
    );
  }
  // Optional explicit revision assertion. The importer can only ever produce its
  // OWN revision (older ones were produced by mappers that no longer exist), so
  // naming a revision is how an operator states "publish the closure at the
  // revision I am about to upgrade the registry to" — and a payload written for
  // a different deployment fails here instead of publishing an unexpected prefix.
  if (
    event?.importerRevision != null &&
    event.importerRevision !== AIDLC_RELEASE_IMPORTER_REVISION
  ) {
    throw new Error(
      `seed-blocks: importRelease publishes importer revision ${AIDLC_RELEASE_IMPORTER_REVISION}, not ${String(event.importerRevision)}`,
    );
  }
  const requested = event?.profile;
  const requestedCustom = event?.custom ?? null;
  if (requested != null && requestedCustom != null) {
    throw new Error('seed-blocks: importRelease takes either "profile" or "custom", not both');
  }

  let profile = null;
  let source = null;
  if (requestedCustom != null) {
    if (typeof requestedCustom !== 'object' || Array.isArray(requestedCustom)) {
      throw new Error(
        'seed-blocks: importRelease "custom" must be an object { repository, sha, baseProfile }',
      );
    }
    profile = customProfile({
      repository: requestedCustom.repository,
      sha: requestedCustom.sha,
      baseProfileId: requestedCustom.baseProfile,
    });
    const [owner, repo] = profile.sourceRepository.split('/');
    source = { owner, repo };
  } else {
    // Profile id only (never a raw SHA) so the invoke payload is self-describing.
    profile = typeof requested === 'string' ? profileFor(requested) : null;
    if (!profile || profile.id !== requested) {
      throw new Error(`seed-blocks: unknown AI-DLC release profile "${String(requested)}"`);
    }
  }

  const files = source
    ? await fetchCoreFiles(profile.upstreamRef, source)
    : await fetchCoreFiles(profile.upstreamRef);
  const bundle = buildReleaseBundle({ profile, files });
  const { manifest, objects } = bundle;
  const summary = {
    mode: 'importRelease',
    dryRun,
    profile: profile.id,
    custom: manifest.custom === true,
    sourceRepository: manifest.sourceRepository,
    trustTier: manifest.trustTier,
    releaseId: manifest.releaseId,
    sourceSha: manifest.sourceSha,
    importerRevision: manifest.importerRevision,
    mapperFingerprint: manifest.mapperFingerprint ?? null,
    manifestKey: releaseManifestKey(releaseKeyArgs(manifest)),
    catalogKey: manifest.catalog.key,
    closureDigest: manifest.closureDigest,
    objectCount: objects.length,
    runtimeFileCount: manifest.runtimeFiles.length,
    compatibility: manifest.compatibility,
  };

  if (dryRun) {
    logger.info('seed-blocks importRelease dry-run', summary);
    return { ...summary, status: 'dry-run' };
  }

  const published = await publishReleaseBundle({ s3, bucket: artifactsBucket(), bundle });
  logger.info('seed-blocks importRelease result', { ...summary, status: published.status });
  return { ...summary, status: published.status };
};

export const handler = async (event, context) => {
  if (context) logger.addContext(context);
  const dryRun = event?.dryRun === true;
  const reseed = event?.reseed === true;
  if (event?.importRelease === true) {
    return importRelease({ event, dryRun, reseed });
  }
  const configuredRef = event?.ref || defaultRef();
  if (!configuredRef) {
    throw new Error('seed-blocks: no repo ref — set AIDLC_REPO_REF or pass {"ref":"<sha>"}');
  }
  const ref = await resolveAidlcRepoRef(configuredRef);
  const now = new Date().toISOString();
  const seeded = [];
  const skipped = [];

  // Fetch + parse the pinned repo. Hard-fails (no fallback) — a partial or
  // stale seed is worse than a clear failure the operator retries.
  const files = await fetchCoreFiles(ref);
  const { blocks, workflow, sensorScripts, runtimeFiles } = buildFromFiles(files);
  const methodologyCatalog = buildMethodologyCatalog({
    ref,
    blocks,
    workflow,
    sensorScripts,
  });

  // Preserve the structured methodology before a reseed replaces the mutable
  // SYSTEM catalog. Historical intents can reconstruct their exact plan from
  // this commit-pinned snapshot without retaining duplicate Markdown bodies.
  if (!dryRun) {
    await writeMethodologyCatalog({
      s3,
      bucket: artifactsBucket(),
      catalog: methodologyCatalog,
    });
  }

  // Reseed: clear the SYSTEM baseline first so the writes below land fresh.
  let cleared = 0;
  if (reseed) {
    cleared = await clearSystemPartitions(dryRun);
  }

  for (const block of blocks) {
    const bodyRef = block.body ? buildBodyRef(block.body) : null;
    const script = block.type === 'SENSOR' ? sensorScripts.get(block.id)?.content : null;
    const scriptRef = script ? buildScriptRef(script) : null;

    if (dryRun) {
      seeded.push(`${block.type}#${block.id}`);
      continue;
    }

    if (bodyRef) {
      await putObject(bodyRef.s3Key, block.body, 'text/markdown');
    }
    if (scriptRef) {
      await putObject(scriptRef.s3Key, script, 'text/plain');
    }

    const { latest, snapshot } = buildItems(block, bodyRef, scriptRef, now, ref);
    try {
      // Guard on V#latest only — its absence means the block is new. The
      // snapshot write follows unconditionally so a half-seeded block heals.
      await ddb.send(
        new PutCommand({
          TableName: blocksTable(),
          Item: latest,
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      await ddb.send(new PutCommand({ TableName: blocksTable(), Item: snapshot }));
      seeded.push(`${block.type}#${block.id}`);
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        skipped.push(`${block.type}#${block.id}`);
        continue;
      }
      throw err;
    }
  }

  // The default workflow: the "from default" fork source. Guard on the META
  // item; only when it is newly created do we write the children.
  const wf = workflow;
  if (dryRun) {
    seeded.push(`WORKFLOW#${wf.id}`);
  } else {
    const { meta, children } = buildWorkflowItems(wf, now, ref);
    try {
      await ddb.send(
        new PutCommand({
          TableName: blocksTable(),
          Item: meta,
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      for (const child of children) {
        await ddb.send(new PutCommand({ TableName: blocksTable(), Item: child }));
      }
      seeded.push(`WORKFLOW#${wf.id}`);
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        skipped.push(`WORKFLOW#${wf.id}`);
      } else {
        throw err;
      }
    }
  }

  // Internal runtime snapshot: the engine tools, hooks, protocols, and
  // conductor, written to a commit-pinned S3 prefix so the execution layer can
  // load the exact files this baseline was seeded from. Content-addressed by
  // commit, so re-seeding the same ref just overwrites identical bytes.
  let runtimeWritten = 0;
  for (const [repoPath, content] of runtimeFiles) {
    if (dryRun) {
      runtimeWritten += 1;
      continue;
    }
    const contentType = repoPath.endsWith('.ts') ? 'text/plain' : 'text/markdown';
    await putObject(runtimeKey(ref, repoPath), content, contentType);
    runtimeWritten += 1;
  }

  // A manifest pins what this snapshot contains, for execution-time discovery.
  if (!dryRun) {
    await putObject(
      `${runtimePrefix(ref)}/manifest.json`,
      JSON.stringify(
        {
          ref,
          seededAt: now,
          runtimeFiles: [...runtimeFiles.keys()].toSorted(),
          sensorScripts: [...sensorScripts.values()].map((s) => s.path).toSorted(),
        },
        null,
        2,
      ),
      'application/json',
    );
  }

  const result = {
    dryRun,
    reseed,
    ref,
    cleared,
    total: blocks.length + 1,
    runtimeFiles: runtimeWritten,
    sensorScripts: sensorScripts.size,
    methodologyCatalog: methodologyCatalogKey(ref),
    seeded,
    skipped,
  };
  logger.info('seed-blocks result', { ...result, seeded: seeded.length });
  return result;
};
