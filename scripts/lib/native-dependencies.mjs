import { createHash } from 'node:crypto';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ACTIVE = new Set([
  'REQUESTED',
  'UPGRADING',
  'DISPATCHING',
  'RUNNING',
  'AWAITING_USER',
  'WAITING_FOR_INPUT',
  'RECOVERING',
  'RECOVERY_REQUIRED',
  'CANCEL_REQUESTED',
]);

// Pure, deterministic inventory. Never emit prompts, answer text, credentials
// or private checkpoint contents. Unknown records remain protected.
export const nativeDependencyInventory = (records) => {
  const references = [];
  for (const row of records) {
    const id = hash([row.pk, row.sk]);
    if (row.sk === 'RUNTIME') {
      references.push({
        id,
        kind: 'preparation',
        status: row.status,
        executable: true, // A prepared draft can start; failed preparation can own resources.
        dependencies: [
          row.imageDigest,
          row.candidate?.packagePin?.packageId,
          row.candidate?.materializationId,
          row.runtimeArn,
          row.accessPointArn,
          row.archiveReceipt?.manifest?.versionId,
        ].filter(Boolean),
      });
    } else if (row.sk === 'EXECUTION') {
      references.push({
        id,
        kind: 'execution',
        status: row.status,
        executable:
          ACTIVE.has(row.status) ||
          Boolean(row.recovery?.canRecover) ||
          row.response?.deliveryStatus === 'pending' ||
          !['STOPPED', 'FAILED', 'CANCELLED'].includes(row.status),
        tuple: {
          rowSchema: row.schemaVersion,
          writerProtocol: row.writerGeneration === undefined ? 'legacy' : 'generation-v1',
          harness: row.configuration?.harness,
          configurationSha256: row.configurationSha256,
          acceptedCommandId: row.response?.commandId ?? null,
          checkpoint: row.recoveryCheckpoint?.id ?? null,
          publication: row.publication?.id ?? null,
        },
        dependencies: [
          row.configuration?.image?.digest,
          row.configuration?.packageId,
          row.configuration?.materializationId,
          row.target?.runtimeArn,
          row.recoveryCheckpoint?.id,
          row.publication?.id,
          row.writerGeneration === undefined ? 'native-legacy-decoder' : 'native-generation-v1',
          'native-publication-v1',
          'native-interaction-v1-v2',
          'native-answer-ledger-v1',
        ].filter(Boolean),
      });
    } else {
      const history =
        /^(PUBLICATION#|RESPONSE#|RESPONSE_REQUEST#|ANSWER#|OUTPUT#|PROMPT#|EVENT#)/.test(
          row.sk ?? '',
        );
      const control = ['OUTPUT_CURSOR', 'PROJECTION', 'REVOCATION'].includes(row.sk);
      references.push({
        id,
        kind: history ? 'history' : control ? 'control' : 'unknown',
        executable: !history && !control,
        dependencies: [],
      });
    }
  }
  return {
    schemaVersion: 1,
    records: records.length,
    executableReferences: references.filter((r) => r.executable).length,
    readableReferences: references.filter((r) => r.kind === 'history').length,
    references: references.toSorted((a, b) => a.id.localeCompare(b.id)),
  };
};

export const assertNativeRemoval = (
  inventory,
  { admissionClosed, dependencies, entireService = false },
) => {
  if (!admissionClosed) throw new Error('Close native admission before removal');
  if (inventory.schemaVersion !== 1) throw new Error('Unsupported dependency inventory');
  if (entireService && inventory.records !== 0)
    throw new Error('Native services or storage still have protected records or readable history');
  const blocked = inventory.references.filter(
    (ref) =>
      ref.kind === 'unknown' ||
      (ref.executable && ref.dependencies.some((dep) => dependencies.includes(dep))),
  );
  if (blocked.length) throw new Error(`Removal has ${blocked.length} protected dependencies`);
  return true;
};
