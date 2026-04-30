import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
  output: string;
}

export function AgentOutputCard({ output }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (!output) return null;

  const previewLines = output.split('\n').slice(0, 3).join('\n');

  return (
    <div className="bg-white rounded-lg shadow border-l-4 border-indigo-500">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-6 py-4 flex justify-between items-center text-left hover:bg-gray-50 transition"
      >
        <h3 className="font-semibold text-gray-900">Agent Output</h3>
        <svg
          className={`w-5 h-5 text-gray-500 transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {expanded ? (
        <div className="px-6 pb-4 max-h-96 overflow-y-auto prose prose-sm max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{output}</ReactMarkdown>
        </div>
      ) : (
        <div className="px-6 pb-4">
          <pre className="text-xs text-gray-500 whitespace-pre-wrap line-clamp-3 font-mono">{previewLines}</pre>
          <p className="text-xs text-indigo-600 mt-1">Click to expand</p>
        </div>
      )}
    </div>
  );
}
