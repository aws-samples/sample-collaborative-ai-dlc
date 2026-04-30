import { AgentStatusPanel } from './AgentStatusPanel';
import { AgentOutputCard } from './AgentOutputCard';
import { AgentStreamPanel } from './AgentStreamPanel';
import type { AgentExecution } from '../services/agents';
import type { ToolCallEvent } from '../hooks/useAgentStatus';

interface Props {
  sprintId: string;
  projectId: string;
  userName: string;
  description: string;
  setDescription: (v: string) => void;
  descSynced: boolean;
  agentStatus: AgentExecution | null;
  streamingText: string;
  activeToolCall: string | null;
  toolCalls: ToolCallEvent[];
  completedOutput: string;
  onStartAgent: () => void;
  onCancelAgent: () => void;
  startingAgent: boolean;
}

export function InceptionView({
  description, setDescription, descSynced,
  agentStatus, streamingText, activeToolCall, toolCalls, completedOutput,
  onStartAgent, onCancelAgent, startingAgent,
}: Props) {
  const isRunning = agentStatus?.status === 'RUNNING';
  const isDone = agentStatus?.status === 'SUCCEEDED';
  const isFailed = agentStatus?.status === 'FAILED' || agentStatus?.status === 'ABORTED' || agentStatus?.status === 'TIMED_OUT';
  const canLaunch = !agentStatus || isFailed;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="text-center">
        <h2 className="text-2xl font-bold text-gray-900">💡 Inception</h2>
        <p className="text-gray-500 mt-1">Describe what you want to build.</p>
      </div>

      {/* Prompt */}
      <div className="bg-white rounded-lg shadow-lg">
        <div className="px-6 py-4 border-b flex justify-between items-center">
          <h3 className="font-semibold text-gray-900">Project Description</h3>
          <span className={`px-2 py-0.5 text-xs rounded ${descSynced ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>
            {descSynced ? '● Saved' : '○ Saving...'}
          </span>
        </div>
        <div className="p-6">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe what you want to build, the main features, target users, and any technical requirements..."
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 min-h-[250px] text-sm leading-relaxed"
            disabled={isRunning}
          />
        </div>
      </div>

      {/* Agent controls */}
      <div className="bg-white rounded-lg shadow-lg p-6">
        {isFailed && agentStatus && (
          <AgentStatusPanel status={agentStatus} />
        )}
        {canLaunch && !isDone && (
          <button
            onClick={onStartAgent}
            disabled={!description.trim() || startingAgent}
            className={`w-full py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 font-medium text-lg transition ${isFailed ? 'mt-3' : ''}`}
          >
            {startingAgent ? 'Starting Agent...' : isFailed ? '🔄 Retry Inception Agent' : '🚀 Launch Inception Agent'}
          </button>
        )}
        {agentStatus && !isFailed && (
          <AgentStatusPanel status={agentStatus} onCancel={isRunning ? onCancelAgent : undefined} />
        )}
        {isRunning && (
          <div className="mt-4">
            <AgentStreamPanel
              streamingText={streamingText}
              activeToolCall={activeToolCall}
              toolCalls={toolCalls}
              isStreaming={true}
            />
          </div>
        )}
        {isDone && completedOutput && (
          <div className="mt-4">
            <AgentOutputCard output={completedOutput} />
          </div>
        )}
      </div>
    </div>
  );
}
