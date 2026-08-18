import { stat } from 'node:fs/promises';
import {
  checkoutRepo as defaultCheckoutRepo,
  hasCheckout as defaultHasCheckout,
} from '../workspace.js';
import {
  checkoutRemoteRevision as defaultCheckoutRemoteRevision,
  repoTargetDir,
} from '../git-engine.js';
import { createGraphWriter, closeGraphSource } from '../mcp/graph-writer.js';

export const importHandoffArtifacts = async (payload, deps) => {
  const {
    projectId,
    intentId,
    executionId,
    humanTaskId,
    stageInstanceId,
    stageAttempt,
    unitSlug,
    sectionIndex,
    repositories = [],
    documents = {},
    workspaceDir,
  } = payload ?? {};
  const {
    openGraph,
    deriveArtifacts,
    checkoutRepo = defaultCheckoutRepo,
    checkoutRemoteRevision = defaultCheckoutRemoteRevision,
    hasCheckout = defaultHasCheckout,
    statFn = stat,
    createWriter = createGraphWriter,
  } = deps;
  if (
    !intentId ||
    !executionId ||
    !humanTaskId ||
    !stageInstanceId ||
    !unitSlug ||
    repositories.length === 0
  ) {
    return { ok: false, reason: 'missing_input' };
  }

  const multi = repositories.length > 1;
  for (const repository of repositories) {
    const dir = repoTargetDir({ url: repository.repository, workspaceDir, multi });
    if (!(await hasCheckout(dir, statFn))) {
      const cloned = await checkoutRepo({
        repo: repository.repository,
        branch: repository.branch,
        baseBranch: repository.branch,
        gitProvider: repository.provider,
        projectId,
        executionId,
        targetDir: dir,
      });
      if (!cloned?.cloned || !cloned?.branchOk) {
        return {
          ok: false,
          reason: 'handoff_checkout_failed',
          repository: repository.repository,
        };
      }
    }
    const checkedOut = await checkoutRemoteRevision({
      dir,
      repo: repository.repository,
      branch: repository.branch,
      sha: repository.submittedSha,
      gitProvider: repository.provider,
      projectId,
      executionId,
    });
    if (!checkedOut.ready) {
      return {
        ok: false,
        reason: checkedOut.reason ?? 'handoff_checkout_failed',
        repository: repository.repository,
        detail: checkedOut.detail ?? null,
      };
    }
  }

  let g;
  try {
    g = await openGraph();
    const graph = createWriter({
      g,
      scope: {
        projectId,
        intentId,
        executionId,
        stageInstanceId,
        stageAttempt,
        unitSlug,
        sectionIndex,
      },
    });
    const revisions = JSON.stringify(
      repositories.map(({ repository, baseSha, submittedSha }) => ({
        repository,
        baseSha,
        submittedSha,
      })),
    );
    const imported = [];
    for (const artifactType of ['code-generation-plan', 'code-summary']) {
      const document = documents[artifactType];
      if (!document?.content || !document?.sha256) {
        return { ok: false, reason: 'handoff_document_missing', artifactType };
      }
      const artifact = await graph.createArtifact({
        artifactType,
        id: `${unitSlug}-${artifactType}`,
        title:
          artifactType === 'code-generation-plan'
            ? `${unitSlug} code generation plan`
            : `${unitSlug} code summary`,
        content: document.content,
        props: {
          handoff_task_id: humanTaskId,
          handoff_content_sha256: document.sha256,
          handoff_revisions: revisions,
        },
      });
      imported.push(artifact.id);
    }
    const derived = await deriveArtifacts?.({
      projectId,
      intentId,
      executionId,
      stageInstanceId,
      unitSlug,
      sectionIndex,
      artifactTypes: ['code-generation-plan', 'code-summary'],
      enrichment: 'off',
    });
    if (derived?.ok === false) {
      return { ok: false, reason: 'handoff_derive_failed', detail: derived.reason ?? null };
    }
    return { ok: true, imported, repositories };
  } catch (error) {
    return { ok: false, reason: 'handoff_import_failed', detail: error.message };
  } finally {
    await closeGraphSource(g);
  }
};
