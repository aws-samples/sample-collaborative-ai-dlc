import type { BlockType } from '@/services/blocks';

// Declarative field config driving the generic simple-block form. Each block
// type lists the extra attributes (beyond the common id/name/description/body)
// it exposes as plain inputs. Skills are NOT here — they have a dedicated
// three-compartment editor (SkillEditor) — so this covers the six simple types.

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
  grouping: {
    fields: [
      {
        key: 'kind',
        label: 'Kind',
        kind: 'text',
        placeholder: 'phase | stage | track | …',
        help: 'A free label, not an enum — name it to fit your methodology.',
      },
    ],
  },
  agent: {
    fields: [
      { key: 'modelOverride', label: 'Model override', kind: 'text', placeholder: 'e.g. opus' },
      { key: 'disallowedTools', label: 'Disallowed tools', kind: 'text' },
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
        placeholder: 'Light | Standard | Deep',
      },
      {
        key: 'keywords',
        label: 'Keywords',
        kind: 'csv',
        placeholder: 'mvp, minimum viable',
        help: 'Comma-separated natural-language triggers.',
      },
    ],
    bodyLabel: 'Rationale',
    bodyHelp: 'Why these skills, why skip those.',
  },
  guardrail: {
    fields: [
      {
        key: 'layer',
        label: 'Layer',
        kind: 'text',
        placeholder: 'org | team | project | grouping',
        help: 'Determines precedence — later layers win.',
      },
    ],
    bodyLabel: 'Constraint',
    bodyHelp: 'The constraint text and its rationale.',
  },
  postcondition: {
    fields: [
      {
        key: 'mode',
        label: 'Mode',
        kind: 'text',
        placeholder: 'deterministic | llm-judged',
        help: 'deterministic self-halts; llm-judged escalates to a human.',
      },
      { key: 'severity', label: 'Severity', kind: 'text', placeholder: 'blocking | advisory' },
      { key: 'statement', label: 'Statement', kind: 'textarea' },
      { key: 'category', label: 'Category', kind: 'text', placeholder: 'security, naming, …' },
    ],
  },
  knowledge: {
    fields: [],
    bodyLabel: 'Document',
    bodyHelp: 'Markdown reference loaded by agents on activation.',
  },
};
