import { describe, expect, it } from 'vitest';
import { ApiError } from '@/services/api';
import { nativeExportErrorMessage } from './nativeExportError';

const refusal = (body: Record<string, unknown>) =>
  new ApiError(409, String(body.error ?? 'Request failed'), body);

describe('nativeExportErrorMessage', () => {
  it('lists a few customized blocks, counts the rest and says export does not support them', () => {
    const message = nativeExportErrorMessage(
      refusal({
        error: 'The workflow uses edited methodology blocks that cannot yet be exported',
        code: 'export_edited_blocks',
        incompatibleBlocks: [
          'STAGE:acme-requirements',
          'AGENT:acme-architect',
          'SENSOR:acme-lint',
          'RULE:acme-naming',
          'KNOWLEDGE:acme-glossary',
          'RULE:acme-security',
          'RULE:acme-logging',
        ],
      }),
    );

    expect(message).toContain(
      'stage acme-requirements, agent acme-architect, sensor acme-lint, rule acme-naming, knowledge acme-glossary and 2 more.',
    );
    expect(message).not.toContain('acme-security');
    expect(message).toContain('methodology blocks customized in Collaborative AI-DLC: stage');
    expect(message).toContain('Exporting these customizations is not yet supported.');
    expect(message).not.toContain('fork');
  });

  it('still explains the refusal when the block list is missing or malformed', () => {
    for (const incompatibleBlocks of [undefined, [], 'AGENT:x', [42, '', null]]) {
      const message = nativeExportErrorMessage(
        refusal({ error: 'edited', code: 'export_edited_blocks', incompatibleBlocks }),
      );
      expect(message).toMatch(
        /customized in Collaborative AI-DLC\. Exporting these customizations is not yet supported\.$/,
      );
    }
  });

  it('keeps an entry without a type prefix as written', () => {
    expect(
      nativeExportErrorMessage(
        refusal({ code: 'export_edited_blocks', incompatibleBlocks: ['legacy-block'] }),
      ),
    ).toContain(': legacy-block.');
  });

  it('says when to retry an export of a running intent without a checkpoint', () => {
    expect(
      nativeExportErrorMessage(
        refusal({
          error: 'No completed workflow checkpoint is available yet',
          code: 'export_checkpoint_unavailable',
        }),
      ),
    ).toBe(
      'No completed workflow checkpoint is available yet. Try again after the current stage completes.',
    );
  });

  it('adds the detail of an incompatible snapshot without its internal prefix', () => {
    expect(
      nativeExportErrorMessage(
        refusal({
          error: 'This workflow snapshot is not compatible with native AI-DLC export',
          code: 'export_snapshot_incompatible',
          detail: 'native-export: projected plan is missing native stage foo',
        }),
      ),
    ).toBe(
      'This workflow snapshot is not compatible with native AI-DLC export. Details: projected plan is missing native stage foo',
    );
    expect(
      nativeExportErrorMessage(
        refusal({ error: 'Not compatible', code: 'export_snapshot_incompatible' }),
      ),
    ).toBe('Not compatible');
  });

  it('keeps the server message for other refusals and plain errors', () => {
    expect(
      nativeExportErrorMessage(
        refusal({ error: 'Mixed revisions', code: 'export_mixed_aidlc_refs' }),
      ),
    ).toBe('Mixed revisions');
    expect(nativeExportErrorMessage(new ApiError(500, 'Boom'))).toBe('Boom');
    expect(nativeExportErrorMessage(new Error('offline'))).toBe('offline');
    expect(nativeExportErrorMessage('nope')).toBe('Failed to export workflow');
  });
});
