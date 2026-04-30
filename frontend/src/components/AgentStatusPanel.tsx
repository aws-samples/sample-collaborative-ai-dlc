import type { AgentExecution } from '../services/agents';

interface Props {
  status: AgentExecution | null;
  questionCount?: number;
  answeredCount?: number;
  onCancel?: () => void;
}

const statusColors: Record<string, string> = {
  RUNNING: 'bg-blue-100 text-blue-800 border-blue-200',
  SUCCEEDED: 'bg-green-100 text-green-800 border-green-200',
  FAILED: 'bg-red-100 text-red-800 border-red-200',
  TIMED_OUT: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  ABORTED: 'bg-gray-100 text-gray-800 border-gray-200',
};

const statusIcons: Record<string, string> = {
  RUNNING: '',
  SUCCEEDED: '',
  FAILED: '',
  TIMED_OUT: '',
  ABORTED: '',
};

export function AgentStatusPanel({ status, questionCount = 0, answeredCount = 0, onCancel }: Props) {
  if (!status) {
    return (
      <div className="border-2 border-dashed border-gray-200 rounded-lg p-6 text-center">
        <p className="text-gray-500 text-sm">No agent running</p>
      </div>
    );
  }

  const currentStatus = status.status || 'RUNNING';
  const statusClass = statusColors[currentStatus] || 'bg-gray-100 border-gray-200';
  const icon = statusIcons[currentStatus] || '';

  return (
    <div className={`border-2 rounded-lg p-4 ${statusClass}`}>
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-2xl">{icon}</span>
          <div>
            <h3 className="font-semibold">Inception {currentStatus === 'RUNNING' ? 'In Progress' : currentStatus}</h3>
            <p className="text-xs opacity-75">
              {currentStatus === 'RUNNING' ? 'Agent is analyzing your project...' : 'Agent execution ' + currentStatus.toLowerCase()}
            </p>
          </div>
        </div>
      </div>

      {currentStatus === 'RUNNING' && (
        <div className="mb-3 space-y-2">
          <div className="flex items-center gap-2 text-sm">
            <div className="animate-spin h-4 w-4 border-2 border-current border-t-transparent rounded-full"></div>
            <span>Working on inception...</span>
          </div>
          {questionCount > 0 && (
            <div className="text-xs">
              <span className="font-medium">{answeredCount}/{questionCount}</span> questions answered
            </div>
          )}
        </div>
      )}

      {currentStatus === 'RUNNING' && onCancel && (
        <button
          onClick={onCancel}
          className="mt-3 w-full px-3 py-2 text-sm bg-red-500 text-white rounded hover:bg-red-600 font-medium"
        >
          Cancel Agent
        </button>
      )}

      {currentStatus === 'SUCCEEDED' && (
        <div className="mt-3 text-sm">
          <p className="font-medium">Inception complete! Review your requirements and user stories below.</p>
        </div>
      )}

      {currentStatus === 'TIMED_OUT' && (
        <div className="mt-3 text-sm">
          <p className="font-medium">Agent timed out waiting for answers</p>
          <p className="text-xs mt-1 opacity-75">Answer the pending question to restart the agent automatically</p>
        </div>
      )}

      {currentStatus === 'FAILED' && (
        <div className="mt-3 text-sm">
          <p className="font-medium">Agent encountered an error</p>
          <p className="text-xs mt-1 opacity-75">Check CloudWatch logs for details</p>
        </div>
      )}
    </div>
  );
}
