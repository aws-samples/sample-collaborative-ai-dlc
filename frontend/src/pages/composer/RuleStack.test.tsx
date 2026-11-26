import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { RuleStack } from './RuleStack';
import type { Workflow } from '@/services/workflows';
import type { Block } from '@/services/blocks';

const workflow = (ruleRefs: Workflow['ruleRefs']): Workflow => ({
  id: 'wf',
  workflowId: 'wf',
  name: 'Workflow',
  objective: '',
  owner: 'default',
  basedOn: null,
  defaultScope: null,
  status: 'DRAFT',
  version: 1,
  readOnly: false,
  createdAt: '',
  updatedAt: '',
  phases: [],
  placements: [],
  scopeRefs: [],
  ruleRefs,
});

const rule = (overrides: Partial<Block> & { id: string }): Block =>
  ({
    blockId: overrides.id,
    blockType: 'RULE',
    tenantId: 'SYSTEM',
    name: overrides.id,
    version: 1,
    readOnly: true,
    hasBody: true,
    bodyBytes: 10,
    hasScript: false,
    scriptBytes: 0,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  }) as Block;

const ruleLib: Block[] = [
  rule({ id: 'aidlc-org', name: 'Org', layer: 'org' }),
  rule({ id: 'aidlc-project', name: 'Project', layer: 'project' }),
  rule({
    id: 'team-language',
    name: 'Team Language',
    layer: 'team',
    tenantId: 'default',
    readOnly: false,
  }),
  rule({ id: 'no-layer', name: 'No Layer', layer: undefined }),
  rule({ id: 'stage-rule', name: 'Stage Rule', layer: 'stage' }),
];

const renderStack = (props: Partial<Parameters<typeof RuleStack>[0]> = {}) => {
  const onAddRule = vi.fn();
  const onRemoveRule = vi.fn();
  render(
    <MemoryRouter>
      <RuleStack
        workflow={workflow([
          { ruleId: 'aidlc-org', layer: 'org', ruleTenant: 'SYSTEM' },
          { ruleId: 'ghost-rule', layer: 'team', ruleTenant: 'SYSTEM' },
        ])}
        ruleLib={ruleLib}
        unresolved={['ghost-rule']}
        readOnly={false}
        onAddRule={onAddRule}
        onRemoveRule={onRemoveRule}
        {...props}
      />
    </MemoryRouter>,
  );
  return { onAddRule, onRemoveRule };
};

describe('RuleStack', () => {
  it('lists attached refs per layer in chain order and flags unresolved ones', () => {
    renderStack();
    const layers = screen.getAllByTestId(/rule-layer-/).map((el) => el.dataset.testid);
    expect(layers).toEqual(['rule-layer-org', 'rule-layer-team']);
    expect(within(screen.getByTestId('rule-layer-org')).getByText('Org')).toBeInTheDocument();
    const team = screen.getByTestId('rule-layer-team');
    expect(within(team).getByText('ghost-rule')).toBeInTheDocument();
    expect(within(team).getByText(/unresolved/)).toBeInTheDocument();
  });

  it('attaches a library rule with the layer and tenant taken from the block', () => {
    const { onAddRule } = renderStack();
    fireEvent.click(screen.getByRole('button', { name: 'Attach Team Language to the workflow' }));
    expect(onAddRule).toHaveBeenCalledWith('team-language', 'team', 'default');
  });

  it('removes an attached ref', () => {
    const { onRemoveRule } = renderStack();
    fireEvent.click(screen.getByRole('button', { name: 'Remove ghost-rule from the team layer' }));
    expect(onRemoveRule).toHaveBeenCalledWith('team', 'ghost-rule');
  });

  it('disables already-attached, layerless, and stage-layer rules with a reason', () => {
    renderStack();
    expect(screen.getByRole('button', { name: 'Attach Org to the workflow' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Attach No Layer to the workflow' })).toBeDisabled();
    expect(screen.getByText(/set its layer first/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Attach Stage Rule to the workflow' }),
    ).toBeDisabled();
    expect(screen.getByText(/not applied to runs yet/)).toBeInTheDocument();
  });

  it('treats a rule as attached by id and shows one block per id, the library copy first', () => {
    renderStack({
      workflow: workflow([{ ruleId: 'team-language', layer: 'project', ruleTenant: 'default' }]),
      ruleLib: [
        ...ruleLib,
        rule({ id: 'team-language', name: 'Team Language (SYSTEM)', layer: 'org' }),
      ],
      unresolved: [],
    });
    expect(screen.queryByText('Team Language (SYSTEM)')).not.toBeInTheDocument();
    // Filed under project, applied at the block's team layer.
    const team = screen.getByTestId('rule-layer-team');
    expect(within(team).getByText(/filed under project/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Attach Team Language to the workflow' }),
    ).toBeDisabled();
  });

  it('blocks a SYSTEM rule the release in force does not ship', () => {
    renderStack({
      workflow: workflow([]),
      ruleLib: [rule({ id: 'legacy-rule', name: 'Legacy Rule', layer: 'org', notInRelease: true })],
      unresolved: [],
    });
    expect(
      screen.getByRole('button', { name: 'Attach Legacy Rule to the workflow' }),
    ).toBeDisabled();
    expect(screen.getByText(/Not in the release new intents run/)).toBeInTheDocument();
  });

  it('hides mutation controls when read-only', () => {
    renderStack({ readOnly: true });
    expect(screen.queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Attach Team Language to the workflow' }),
    ).toBeDisabled();
  });
});
