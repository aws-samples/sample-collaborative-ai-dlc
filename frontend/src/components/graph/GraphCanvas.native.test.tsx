import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { GraphCanvas } from './GraphCanvas';
import { getNodeCfg, TYPE_HIERARCHY } from './graphTypes';

afterEach(cleanup);
const nodes = [
  { id: 'artifact-node', type: 'Artifact', label: 'Pipe source', artifactId: 'code-file' },
];
it('opens the published file by keyboard using artifactId rather than the graph node identity', async () => {
  const open = vi.fn();
  render(
    <TooltipProvider>
      <GraphCanvas nodes={nodes} edges={[]} onOpenArtifact={open} />
    </TooltipProvider>,
  );
  const file = await screen.findByRole('button', { name: 'Open file for Pipe source' });
  expect(file).toHaveAttribute('tabindex', '0');
  fireEvent.keyDown(file, { key: 'Enter' });
  expect(open).toHaveBeenCalledWith('code-file');
});
it('keeps ordinary graph selection when no navigation prop is supplied', async () => {
  render(
    <TooltipProvider>
      <GraphCanvas nodes={nodes} edges={[]} />
    </TooltipProvider>,
  );
  expect(screen.queryByRole('button', { name: /Open file for/ })).not.toBeInTheDocument();
  fireEvent.click(await screen.findByText('Pipe source'));
  expect(screen.getByRole('heading', { name: 'Pipe source' })).toBeInTheDocument();
});
it('opens an assistant response by click and keyboard using interactionId', async () => {
  const open = vi.fn();
  const file = vi.fn();
  render(
    <TooltipProvider>
      <GraphCanvas
        nodes={[
          {
            id: 'graph-turn',
            type: 'NativeInteraction',
            label: 'AI-DLC turn',
            interactionId: 'interaction-1',
          },
        ]}
        edges={[]}
        onOpenInteraction={open}
        onOpenArtifact={file}
      />
    </TooltipProvider>,
  );
  const node = await screen.findByRole('button', { name: 'Open response for AI-DLC turn' });
  expect(screen.getByRole('button', { name: /^AI-DLC response\s*1$/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Unknown\s*1$/ })).not.toBeInTheDocument();
  expect(node).toHaveTextContent('Response');
  expect(node).not.toHaveTextContent('?');
  expect(node.querySelector('.lucide-message-square')).not.toBeNull();
  expect(getNodeCfg('NativeInteraction')).not.toBe(getNodeCfg('Artifact'));
  expect(TYPE_HIERARCHY).toContain('NativeInteraction');
  fireEvent.click(node);
  fireEvent.keyDown(node, { key: ' ' });
  expect(open.mock.calls).toEqual([['interaction-1'], ['interaction-1']]);
  expect(file).not.toHaveBeenCalled();
});
