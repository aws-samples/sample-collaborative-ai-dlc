import { nativePublicationView } from '../shared/native-publication.js';
import { nativeInteractionView } from '../shared/native-interaction.js';
import { NATIVE_ARTIFACT_CONTEXT_MAX_FILE_BYTES } from '../shared/native-artifact-revision.js';
import {
  nativeMemberDecision,
  nativeVerificationSummary,
  nativeWorkflowDefinition,
} from '../shared/native-completion-evidence.js';

const invalid = () => {
  throw Object.assign(new Error('The named publication could not be verified'), {
    code: 'NATIVE_ARTIFACT_REVISION_INVALID',
  });
};

// Reads use admitted bytes and structured authority receipts only. No runtime,
// projection, image-policy or mutable project configuration is consulted.
export const createNativeRevisionApi = ({ read, revisions, interactions, store }) => {
  const locate = async (draft, target, recheck) => {
    const row = await read(draft, recheck);
    if (!row?.publication || !revisions) invalid();
    const located = await revisions.publication(row, target);
    return { row, ...located };
  };
  const finish = async (draft, row, recheck) => {
    const current = await read(draft, recheck);
    if (
      current?.bindingId !== row.bindingId ||
      current.attemptId !== row.attemptId ||
      current.configurationSha256 !== row.configurationSha256
    )
      invalid();
    // A new head, recovery or cancellation cannot retarget an immutable read.
  };
  const decision = async (row, found, manifest) => {
    if (!found.interaction) return { interaction: null, facts: null };
    const body = await interactions.read(
      {
        ...found.identity,
        bindingId: row.bindingId,
        runtimeSessionId: found.runtimeSessionId,
      },
      found.interaction,
    );
    if (
      body.packageId !== manifest.packageId ||
      body.harness !== row.configuration.harness ||
      body.publicationId !== found.receipt.id ||
      body.sequence !== manifest.sequence ||
      body.nativeSessionId !== manifest.nativeSessionId ||
      body.contentSha256 !== found.interactionContentSha256
    )
      invalid();
    return {
      interaction: nativeInteractionView(found.interaction, body),
      facts: await store.historicalAnswer(row, found),
    };
  };
  return {
    async history(draft, before, recheck) {
      const row = await read(draft, recheck);
      const page = row
        ? await revisions.list(row, before)
        : { items: [], nextBefore: null, gaps: [] };
      if (row) await finish(draft, row, recheck);
      return page;
    },
    async revision(draft, target, recheck) {
      const { row, found, manifest } = await locate(draft, target, recheck);
      if (target.evidence) {
        const { interaction, facts } = await decision(row, found, manifest);
        const memberDecision = nativeMemberDecision(interaction, facts?.response);
        await finish(draft, row, recheck);
        return {
          schemaVersion: 1,
          context: {
            ...found.identity,
            configurationSha256: row.configurationSha256,
            packageId: manifest.packageId,
            harness: row.configuration.harness,
          },
          ...nativeVerificationSummary(
            found.receipt.id,
            manifest.sequence,
            manifest.packageId,
            row.configuration.harness,
          ),
          definition: nativeWorkflowDefinition(manifest.packageId, row.configuration.harness),
          effectivePlan: 'not_recorded',
          engineApplication: 'not_recorded',
          terminalOutcome: 'not_recorded',
          memberDecision,
          // Delivery is an independent transport observation, never application.
          decisionDelivery: !memberDecision
            ? null
            : facts.delivered
              ? 'delivered'
              : facts.uncertain
                ? 'uncertain'
                : 'unknown',
        };
      }
      if (target.source) {
        const { baseline } = await revisions.source(row, target);
        await finish(draft, row, recheck);
        return {
          projectId: row.scope.projectId,
          executionId: row.scope.executionId,
          publicationId: found.receipt.id,
          publicationSequence: manifest.sequence,
          baseline: baseline
            ? {
                id: baseline.receipt.id,
                repository: baseline.manifest.repository,
                files: nativePublicationView(baseline.receipt, baseline.manifest).files,
                inventory: 'native-public-files',
              }
            : null,
          status: baseline ? 'captured' : 'not_retained',
          reason: baseline ? null : (manifest.sourceBaseline?.unavailable ?? 'not_recorded'),
        };
      }
      await finish(draft, row, recheck);
      return {
        ...nativePublicationView(found.receipt, manifest),
        context: { ...found.identity, packageId: manifest.packageId },
        outcome: manifest.outcome,
        interactionId: found.interaction?.id ?? null,
        verification: nativeVerificationSummary(
          found.receipt.id,
          manifest.sequence,
          manifest.packageId,
          row.configuration.harness,
        ),
      };
    },
    async revisionFile(draft, target, recheck) {
      const row = await read(draft, recheck);
      if (!row?.publication || !revisions) invalid();
      const result = await revisions.read(row, target, {
        maxBytes: NATIVE_ARTIFACT_CONTEXT_MAX_FILE_BYTES,
        sourceBaseline: target.source === true,
      });
      await finish(draft, row, recheck);
      return result;
    },
    async revisionInteraction(draft, target, recheck) {
      const { row, found, manifest } = await locate(draft, target, recheck);
      const { interaction, facts } = await decision(row, found, manifest);
      if (!interaction) {
        await finish(draft, row, recheck);
        return { interaction: null, answer: null };
      }
      let answer = null;
      if (facts) {
        const { response, delivered, uncertain, publication, retained } = facts;
        // The observation names the command consumed by publication admission.
        // Verify that exact publication still exists before exposing its link.
        if (publication) await revisions.publication(row, publication);
        const pointer = row.response?.commandId === response.commandId ? row.response : null;
        const deliveryStatus = delivered
          ? 'delivered'
          : uncertain ||
              retained?.delivery === 'uncertain' ||
              (pointer && row.recovery?.reason === 'DELIVERY_UNCERTAIN')
            ? 'uncertain'
            : (pointer?.deliveryStatus ?? 'unknown');
        answer = {
          id: response.commandId,
          interactionId: response.interactionId,
          sequence: response.sequence,
          actorId: response.actorId,
          text: response.text,
          acceptedAt: new Date(response.acceptedAt).toISOString(),
          context: {
            publicationId: found.receipt.id,
            publicationSequence: manifest.sequence,
            contentSha256: response.contentSha256,
            epoch: response.epoch,
            membershipRecorded: Boolean(response.member),
          },
          deliveryStatus,
          deliveredAt: delivered?.recordedAt ?? null,
          uncertainAt: uncertain?.recordedAt ?? null,
          resultingPublication: publication,
          ...(retained ? { resumeRetention: retained } : {}),
          applicationStatus: 'not_recorded',
          rejectionStatus: 'not_recorded',
          approvalStatus: 'not_recorded',
        };
      }
      await finish(draft, row, recheck);
      return { interaction, answer };
    },
  };
};
