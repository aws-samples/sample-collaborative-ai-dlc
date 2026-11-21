import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { GraphCanvas } from './GraphCanvas';
import { getNodeCfg, TYPE_HIERARCHY } from './graphTypes';

afterEach(cleanup);
const nodes = [
  { id: 'artifact-node', type: 'Artifact', label: 'Pipe source', artifactId: 'code-file' },
];
it('exposes the source destination as a keyboard-accessible link', async () => {
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <Routes>
        <Route
          path="/"
          element={
            <TooltipProvider>
              <GraphCanvas
                nodes={nodes}
                edges={[]}
                sourceLinks={new Map([['artifact-node', '/source']])}
              />
            </TooltipProvider>
          }
        />
        <Route path="/source" element={<p>Named file</p>} />
      </Routes>
    </MemoryRouter>,
  );
  const file = await screen.findByRole('link', { name: 'Open file for Pipe source' });
  expect(file).toHaveAttribute('href', '/source');
  file.focus();
  expect(file).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(await screen.findByText('Named file')).toBeVisible();
});
it('keeps ordinary graph selection when no navigation prop is supplied', async () => {
  render(
    <TooltipProvider>
      <GraphCanvas nodes={nodes} edges={[]} />
    </TooltipProvider>,
  );
  expect(screen.queryByRole('link', { name: /Open file for/ })).not.toBeInTheDocument();
  fireEvent.click(await screen.findByText('Pipe source'));
  expect(screen.getByRole('heading', { name: 'Pipe source' })).toBeInTheDocument();
});
it('opens an assistant response by click and keyboard using interactionId', async () => {
  const open = vi.fn();
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
});
