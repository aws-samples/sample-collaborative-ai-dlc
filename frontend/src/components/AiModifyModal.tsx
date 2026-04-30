import { useState } from 'react';
import { sprintGraphService } from '../services/sprintGraph';

interface Props {
  artifactId: string;
  artifactType: string;
  artifactTitle: string;
  sprintId: string;
  projectId: string;
  onClose: () => void;
  onSubmit: (instruction: string, context: string) => Promise<void>;
}

export function AiModifyModal({ artifactId, artifactType, artifactTitle, sprintId, onClose, onSubmit }: Props) {
  const [instruction, setInstruction] = useState('');
  const [context, setContext] = useState('');
  const [loadingContext, setLoadingContext] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const loadGraphContext = async () => {
    setLoadingContext(true);
    try {
      const graph = await sprintGraphService.get(sprintId);
      // Find edges connected to this artifact
      const related = graph.edges
        .filter(e => e.source === artifactId || e.target === artifactId)
        .map(e => {
          const otherId = e.source === artifactId ? e.target : e.source;
          const other = graph.nodes.find(n => n.id === otherId);
          return other ? `[${other.type}] ${other.label} (${e.label})` : null;
        })
        .filter(Boolean);

      const thisNode = graph.nodes.find(n => n.id === artifactId);
      let ctx = `Artifact: [${artifactType}] "${artifactTitle}"\n`;
      if (thisNode) ctx += `Details: ${JSON.stringify(thisNode, null, 2)}\n`;
      if (related.length > 0) ctx += `\nRelated artifacts:\n${related.map(r => `  - ${r}`).join('\n')}`;
      else ctx += '\nNo related artifacts found in graph.';
      setContext(ctx);
    } catch {
      setContext('Failed to load graph context.');
    } finally {
      setLoadingContext(false);
    }
  };

  const handleSubmit = async () => {
    if (!instruction.trim()) return;
    setSubmitting(true);
    try {
      await onSubmit(instruction.trim(), context);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 max-w-lg w-full mx-4 max-h-[80vh] overflow-y-auto">
        <h2 className="text-lg font-semibold mb-1">🤖 AI Modify: {artifactTitle}</h2>
        <p className="text-sm text-gray-500 mb-4">Tell the agent what to change. It will use graph context to understand relationships.</p>

        {/* Graph context */}
        <div className="mb-4">
          <div className="flex justify-between items-center mb-1">
            <label className="text-sm font-medium text-gray-700">Graph Context</label>
            <button onClick={loadGraphContext} disabled={loadingContext} className="text-xs text-indigo-600 hover:underline">
              {loadingContext ? 'Loading...' : context ? 'Reload' : 'Load from graph'}
            </button>
          </div>
          {context && (
            <pre className="text-xs bg-gray-50 border rounded p-2 max-h-32 overflow-y-auto whitespace-pre-wrap">{context}</pre>
          )}
        </div>

        {/* Instruction */}
        <label className="block text-sm font-medium text-gray-700 mb-1">Modification Instruction</label>
        <textarea
          value={instruction}
          onChange={e => setInstruction(e.target.value)}
          placeholder="e.g. 'Split this requirement into two: one for the API and one for the UI' or 'Add acceptance criteria based on the linked user stories'"
          className="w-full px-3 py-2 border rounded-lg text-sm min-h-[100px] focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
        />

        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded" disabled={submitting}>Cancel</button>
          <button onClick={handleSubmit} disabled={!instruction.trim() || submitting} className="px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50">
            {submitting ? 'Sending...' : 'Send to Agent'}
          </button>
        </div>
      </div>
    </div>
  );
}
