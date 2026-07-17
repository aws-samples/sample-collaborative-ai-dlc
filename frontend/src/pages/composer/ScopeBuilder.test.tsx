import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ScopeBuilder } from './ScopeBuilder';
import type { Workflow } from '@/services/workflows';
import type { Block } from '@/services/blocks';

const workflow: Workflow = {
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
  phases: [
    {
      phaseId: 'ideation',
      name: 'Ideation',
      kind: 'phase',
      path: '01',
      parentPath: null,
      order: 1,
    },
  ],
  placements: [
    {
      stageId: 'capture',
      stageTenant: 'SYSTEM',
      pinnedVersion: null,
      phasePath: '01',
      order: 0,
      scopeMembership: {},
    },
    {
      stageId: 'design',
      stageTenant: 'SYSTEM',
      pinnedVersion: null,
      phasePath: '01',
      order: 1,
      scopeMembership: {},
    },
  ],
  scopeRefs: [],
  ruleRefs: [],
};

const stagesById = {
  capture: { id: 'capture', blockId: 'capture', name: 'Capture', phase: 'ideation' },
  design: { id: 'design', blockId: 'design', name: 'Design', phase: 'ideation' },
} as unknown as Record<string, Block>;

describe('ScopeBuilder', () => {
  it('creates a scope from phase selections', async () => {
    const onSaveScope = vi.fn().mockResolvedValue(undefined);
    render(
      <ScopeBuilder
        workflow={workflow}
        scopeLib={[]}
        stagesById={stagesById}
        activeScope={null}
        readOnly={false}
        preview={null}
        onSelectScope={vi.fn()}
        onRemoveScope={vi.fn()}
        onSaveScope={onSaveScope}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /new/i }));
    fireEvent.change(screen.getByLabelText(/scope name/i), {
      target: { value: 'MVP Scope' },
    });
    fireEvent.click(screen.getByLabelText(/ideation/i));
    fireEvent.click(screen.getByRole('button', { name: /create scope/i }));

    await waitFor(() => expect(onSaveScope).toHaveBeenCalled());
    expect(onSaveScope).toHaveBeenCalledWith({
      scopeId: 'mvp-scope',
      name: 'MVP Scope',
      stageIds: ['capture', 'design'],
      createBlock: true,
      setDefault: true,
    });
  });
});
