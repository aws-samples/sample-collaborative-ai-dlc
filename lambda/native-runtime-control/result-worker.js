import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { nativeAuthorityPort } from './authority-client.js';
import { createNativePublications } from '../shared/native-publication.js';
import { createNativeArtifactRevisions } from '../shared/native-artifact-revision.js';
import { createNativeResultStorage } from './result-storage.js';
import { buildNativeResultArchive, resultEligibleFiles } from './result-archive.js';
import { resultFailure, resultJobMatches } from './result-store.js';

export const nativeResultProvenance = (execution, manifest, request, files) => ({
  schemaVersion: 1,
  projectId: execution.scope.projectId,
  executionId: execution.scope.executionId,
  publicationId: request.publicationId,
  publicationSequence: request.publicationSequence,
  packageId: manifest.packageId,
  configurationSha256: execution.configurationSha256,
  repository: manifest.repository,
  sourceBaseline: manifest.sourceBaseline?.receipt
    ? { status: 'captured', id: manifest.sourceBaseline.receipt.id }
    : { status: 'not_retained', reason: manifest.sourceBaseline?.unavailable ?? 'not_recorded' },
  verification: {
    workflowCompletion: 'not_verified',
    requiredChecks: 'not_recorded',
    finalReview: 'not_recorded',
    humanApproval: 'not_recorded',
  },
  files: files.map(({ object: _object, ...file }) => file),
});

export const createNativeResultWorker =
  ({ executions, jobs, revisions, storage }) =>
  async (input) => {
    const { projectId, executionId, requestId } = input ?? {};
    if (
      Object.keys(input ?? {})
        .toSorted()
        .join(',') !== 'executionId,projectId,requestId'
    )
      throw resultFailure('INVALID');
    const scope = { projectId, executionId };
    const claim = await jobs.claim(scope, requestId);
    if (!claim) return;
    let directory;
    let artifact;
    let admitted = false;
    let discard = false;
    const signal = AbortSignal.timeout(840_000);
    try {
      const execution = await executions.get(scope);
      if (!resultJobMatches(claim, execution, claim.request)) throw resultFailure('CONFLICT');
      const { manifest } = await revisions.publication(execution, claim.request);
      const files = resultEligibleFiles(manifest, claim.request);
      directory = await mkdtemp(join(tmpdir(), 'native-result-'));
      const path = join(directory, 'result');
      const readFile = (file) => {
        signal.throwIfAborted();
        return revisions.bytes(
          execution,
          {
            publicationId: claim.request.publicationId,
            publicationSequence: claim.request.publicationSequence,
            fileId: file.id,
            sha256: file.sha256,
          },
          { signal },
        );
      };
      let content;
      if (claim.request.fileId) {
        const bytes = await readFile(files[0]);
        await writeFile(path, bytes, { flag: 'wx', mode: 0o600, signal });
        content = { bytes: files[0].bytes, sha256: files[0].sha256 };
      } else {
        content = await buildNativeResultArchive({
          destination: path,
          files,
          readFile,
          signal,
          provenance: nativeResultProvenance(execution, manifest, claim.request, files),
        });
      }
      signal.throwIfAborted();
      artifact = await storage.upload(claim, path, content, signal);
      admitted = await jobs.finish(claim, artifact);
      if (!admitted) {
        discard = true;
        throw resultFailure('CONFLICT');
      }
    } catch {
      // If the ready write acknowledgement/readback is unavailable, its outcome
      // is unknown. Preserve that exact version: it may already be referenced.
      if (!artifact) await jobs.finish(claim, null);
      // Deliberately safe public failure state: provider errors may carry keys.
    } finally {
      try {
        if (artifact && discard) await storage.remove(claim, artifact);
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    }
  };

let worker;
export const handler = async (event) => {
  if (!worker) {
    const env = process.env;
    const s3 = new S3Client({});
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const publications = createNativePublications({
      s3,
      bucket: env.NATIVE_EXECUTION_PUBLICATION_BUCKET,
      accountId: env.NATIVE_RUNTIME_ACCOUNT_ID,
    });
    worker = createNativeResultWorker({
      executions: nativeAuthorityPort('results', 'execution', ['get']),
      jobs: nativeAuthorityPort('results', 'results', ['claim', 'finish']),
      revisions: createNativeArtifactRevisions({
        ddb,
        nativeTable: env.NATIVE_RUNTIME_BINDINGS_TABLE,
        publications,
      }),
      storage: createNativeResultStorage({
        s3,
        bucket: env.NATIVE_EXECUTION_PUBLICATION_BUCKET,
        accountId: env.NATIVE_RUNTIME_ACCOUNT_ID,
      }),
    });
  }
  return worker(event);
};
