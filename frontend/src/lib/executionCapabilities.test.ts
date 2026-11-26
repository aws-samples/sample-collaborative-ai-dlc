import { describe, expect, it } from 'vitest';
import {
  executionCapabilityReason,
  executionGateResponseReason,
  type UiExecutionCapability,
} from './executionCapabilities';

const capabilities: UiExecutionCapability[] = [
  'artifactEdit',
  'artifactVerify',
  'quorumEdit',
  'answerRevision',
  'workflowRewind',
  'workflowRecompose',
  'workflowCompose',
  'unitPullRequests',
  'parallelUnits',
  'nativeExport',
  'derive',
  'stageSkipping',
  'questionAnswer',
  'gateApproval',
];

describe('executionCapabilityReason', () => {
  it.each(['question', 'approval', 'review-verdict', 'validation'] as const)(
    'guards %s responses with their explicit capability',
    (kind) => {
      const capability = kind === 'question' ? 'questionAnswer' : 'gateApproval';
      expect(executionGateResponseReason({}, { kind })).toBeNull();
      expect(
        executionGateResponseReason(
          { executionBackend: 'platform', executionCapabilities: { [capability]: false } },
          { kind },
        ),
      ).toBe('Disabled for this execution');
      expect(executionGateResponseReason({ executionBackend: 'native' }, { kind })).toBe(
        kind === 'question'
          ? 'Answering native questions is not available yet'
          : 'Native approvals are not available yet',
      );
    },
  );

  it.each(capabilities)(
    'preserves legacy behavior and server restrictions for %s',
    (capability) => {
      expect(executionCapabilityReason({}, capability)).toBeNull();
      expect(executionCapabilityReason({ executionBackend: 'platform' }, capability)).toBeNull();
      expect(
        executionCapabilityReason(
          {
            executionBackend: 'platform',
            executionCapabilities: { [capability]: true },
          },
          capability,
        ),
      ).toBeNull();
      expect(
        executionCapabilityReason(
          {
            executionCapabilities: { [capability]: false },
          },
          capability,
        ),
      ).toBe('Disabled for this execution');
      expect(
        executionCapabilityReason(
          {
            executionBackend: 'platform',
            executionCapabilities: { [capability]: false },
          },
          capability,
        ),
      ).toBe('Disabled for this execution');
    },
  );

  it.each(capabilities)(
    'fails closed for %s on native and unknown backends, even with server true',
    (capability) => {
      for (const executionBackend of ['native', 'future-backend', '']) {
        expect(executionCapabilityReason({ executionBackend }, capability)).not.toBeNull();
        expect(
          executionCapabilityReason(
            {
              executionBackend,
              executionCapabilities: { [capability]: true },
            },
            capability,
          ),
        ).not.toBeNull();
      }
    },
  );
});
