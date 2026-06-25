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
  // When set, the type also shows a second editor for the block's executable
  // script (stored separately from the body as scriptRef — e.g. a SENSOR check).
  scriptLabel?: string;
  scriptHelp?: string;
}

export const SIMPLE_BLOCK_FORMS: Partial<Record<BlockType, BlockTypeForm>> = {
  agent: {
    fields: [
      { key: 'displayName', label: 'Display name', kind: 'text', placeholder: 'Architect Agent' },
      { key: 'modelOverride', label: 'Model override', kind: 'text', placeholder: 'opus | sonnet' },
      { key: 'disallowedTools', label: 'Disallowed tools', kind: 'text', placeholder: 'Task' },
      {
        key: 'tools',
        label: 'Tools allowlist',
        kind: 'csv',
        placeholder: 'read, shell',
        help: 'Optional. When set, restricts the agent to these tools (reviewers use read, shell).',
      },
      {
        key: 'examples',
        label: 'Knowledge examples',
        kind: 'csv',
        placeholder: 'tech-stack.md, infrastructure-preferences.md',
        help: 'Example team-knowledge files this agent reads (V2 agent frontmatter).',
      },
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
        key: 'testStrategy',
        label: 'Test strategy',
        kind: 'text',
        placeholder: 'Minimal | Standard | Comprehensive',
        help: 'Test depth, orthogonal to depth. Defaults to depth when left blank.',
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
        placeholder: 'org | team | project | phase',
        help: 'Chain: org → team → team-learnings → project → project-learnings → phase → stage; later layers win.',
      },
      {
        key: 'phase',
        label: 'Phase (when layer = phase)',
        kind: 'text',
        placeholder: 'ideation | inception | construction | operation',
        help: 'A phase rule attaches to every stage in that phase.',
      },
      {
        key: 'pairing',
        label: 'Paired sensor',
        kind: 'text',
        placeholder: 'required-sections | feedforward-only',
        help: 'Optional. Binds this rule (feedforward) to a sensor (feedback), or "feedforward-only".',
      },
    ],
    bodyLabel: 'Constraint',
    bodyHelp: 'The constraint text and its rationale.',
  },
  sensor: {
    fields: [
      {
        key: 'command',
        label: 'Command',
        kind: 'text',
        placeholder: 'bun {{HARNESS_DIR}}/tools/aidlc-sensor-linter.ts',
        help: 'How the deterministic check is run. AI-DLC sensors are TypeScript run via Bun. (The LLM-judged half of verification is a stage reviewer, not a sensor.)',
      },
      { key: 'severity', label: 'Severity', kind: 'text', placeholder: 'advisory' },
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
    bodyLabel: 'Manifest',
    bodyHelp: 'The sensor manifest prose (what it checks, failure mode). Stored in S3.',
    scriptLabel: 'Script',
    scriptHelp: 'The check script (TypeScript) the command above runs. Stored in S3.',
  },
  knowledge: {
    fields: [
      {
        key: 'tier',
        label: 'Tier',
        kind: 'text',
        placeholder: 'methodology | team',
        help: 'methodology ships in the baseline; team is accrued per-project.',
      },
      {
        key: 'agentRef',
        label: 'Agent',
        kind: 'text',
        placeholder: 'aidlc-product-agent | shared',
        help: 'The agent this knowledge attaches to, or "shared" for the cross-cutting corpus.',
      },
    ],
    bodyLabel: 'Document',
    bodyHelp: 'Markdown reference loaded by agents on activation.',
  },
  artifact: {
    fields: [
      {
        key: 'terminal',
        label: 'Terminal',
        kind: 'text',
        placeholder: 'true | false',
        help: 'A terminal artifact is a deliberate end-of-flow output no stage consumes.',
      },
    ],
    bodyLabel: 'Notes',
    bodyHelp: 'Optional notes on the artifact and its shape.',
  },
  skill: {
    fields: [
      {
        key: 'argumentHint',
        label: 'Argument hint',
        kind: 'text',
        placeholder: '"" | <stage-slug>',
        help: 'Hint shown for the slash-command argument when the skill is invoked.',
      },
      {
        key: 'userInvocable',
        label: 'User-invocable',
        kind: 'text',
        placeholder: 'true | false',
        help: 'Whether the user can invoke this skill directly as a slash command.',
      },
      {
        key: 'classification',
        label: 'Classification',
        kind: 'text',
        placeholder: 'read-only',
        help: 'Side-effect class, e.g. read-only (never mutates workflow state or emits audit events).',
      },
    ],
    bodyLabel: 'Instructions',
    bodyHelp: 'The runner-pack instructions (SKILL.md body).',
  },
  template: {
    fields: [],
    bodyLabel: 'Template',
    bodyHelp: 'The scaffold template body, including any {{SLOT:…}} placeholders.',
  },
};
