import type { BlockType } from '@/services/blocks';

// Declarative field config driving the generic simple-block form. Each block
// type lists the extra attributes (beyond the common id/name/description/body)
// it exposes as plain inputs. Stages are NOT here — they have a dedicated
// three-compartment editor (StageEditor) — so this covers the simple types.

export interface BlockField {
  key: string;
  label: string;
  // text: single-line input · textarea: multi-line · csv: comma-separated → string[]
  kind: 'text' | 'textarea' | 'csv';
  placeholder?: string;
  help?: string;
}

// Whether this type's body editor is shown, and what to call it.
export interface BlockTypeForm {
  fields: BlockField[];
  bodyLabel?: string; // omit to hide the body editor
  bodyHelp?: string;
}

export const SIMPLE_BLOCK_FORMS: Partial<Record<BlockType, BlockTypeForm>> = {
  agent: {
    fields: [
      { key: 'displayName', label: 'Display name', kind: 'text', placeholder: 'Architect Agent' },
      { key: 'modelOverride', label: 'Model override', kind: 'text', placeholder: 'opus | sonnet' },
      { key: 'disallowedTools', label: 'Disallowed tools', kind: 'text', placeholder: 'Task' },
    ],
    bodyLabel: 'Persona',
    bodyHelp: 'Responsibilities, collaboration, and knowledge-loading order.',
  },
  scope: {
    fields: [
      {
        key: 'depth',
        label: 'Depth',
        kind: 'text',
        placeholder: 'Minimal | Standard | Comprehensive',
      },
      {
        key: 'keywords',
        label: 'Keywords',
        kind: 'csv',
        placeholder: 'mvp, minimum viable',
        help: 'Comma-separated natural-language triggers for auto-selection.',
      },
    ],
    bodyLabel: 'Rationale',
    bodyHelp: 'Why these stages run, why others skip.',
  },
  rule: {
    fields: [
      {
        key: 'layer',
        label: 'Layer',
        kind: 'text',
        placeholder: 'org | team | project | grouping',
        help: 'Determines precedence — later layers win.',
      },
      {
        key: 'groupingRef',
        label: 'Phase (when layer = grouping)',
        kind: 'text',
        placeholder: 'ideation | construction | …',
      },
    ],
    bodyLabel: 'Constraint',
    bodyHelp: 'The constraint text and its rationale.',
  },
  sensor: {
    fields: [
      {
        key: 'mode',
        label: 'Mode',
        kind: 'text',
        placeholder: 'deterministic | llm-judged',
        help: 'deterministic self-halts; llm-judged escalates to a human.',
      },
      { key: 'severity', label: 'Severity', kind: 'text', placeholder: 'advisory | blocking' },
      {
        key: 'command',
        label: 'Command',
        kind: 'text',
        placeholder: 'bun {{HARNESS_DIR}}/tools/aidlc-sensor-linter.ts',
        help: 'How a deterministic check is run. AI-DLC sensors are TypeScript run via Bun.',
      },
      { key: 'runtime', label: 'Runtime', kind: 'text', placeholder: 'bun' },
      { key: 'matches', label: 'Matches (glob)', kind: 'text', placeholder: '**/*.{ts,js}' },
      {
        key: 'category',
        label: 'Category',
        kind: 'text',
        placeholder: 'code-quality | document-shape',
      },
      { key: 'timeoutSeconds', label: 'Timeout (seconds)', kind: 'text', placeholder: '30' },
    ],
    bodyLabel: 'Script',
    bodyHelp: 'The check script (TypeScript). Stored in S3, run by the command above.',
  },
  knowledge: {
    fields: [],
    bodyLabel: 'Document',
    bodyHelp: 'Markdown reference loaded by agents on activation.',
  },
};
