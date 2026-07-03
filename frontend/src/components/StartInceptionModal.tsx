import { useCollaborativeInception } from '../hooks/useCollaborativeInception';
import { CollaborativeTextarea } from './CollaborativeTextarea';
import { GitRepoLink } from './GitRepoLink';
import type { UserPresence } from '../hooks/usePresence';
import type { GitProvider } from '@/services/gitProvider';

interface Props {
  projectId: string;
  projectName: string;
  gitRepo?: string;
  gitProvider: GitProvider;
  userId: string;
  userName: string;
  collaborators: UserPresence[];
  executionArn: string | null;
  onStart: (description: string) => Promise<void>;
  onClose: () => void;
}

export function StartInceptionModal({
  projectId,
  projectName,
  gitRepo,
  gitProvider,
  userId,
  userName,
  collaborators,
  executionArn,
  onStart,
  onClose,
}: Props) {
  const {
    description,
    status,
    startedBy,
    synced,
    remoteUsers,
    setDescription,
    setStatus,
    reset,
    setCursor,
  } = useCollaborativeInception(projectId, userId, userName);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!description.trim() || status === 'running') return;

    setStatus('running', userName);
    try {
      await onStart(description.trim());
      onClose();
    } catch {
      setStatus('drafting');
    }
  };

  // Show as running only if both Yjs state says running AND there's an actual execution
  const isRunning = status === 'running' && !!executionArn;
  // Stale state: Yjs says running but no execution exists
  const isStale = status === 'running' && !executionArn;
  const remoteUsersList = Array.from(remoteUsers.values());

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 max-w-lg w-full mx-4">
        <div className="flex justify-between items-start mb-2">
          <h2 className="text-xl font-semibold">Start Inception Agent</h2>
          <div className="flex items-center gap-2">
            {(collaborators.length > 0 || remoteUsersList.length > 0) && (
              <div className="flex -space-x-1 mr-2">
                {remoteUsersList.map((u, i) => (
                  <div
                    key={i}
                    className="w-6 h-6 rounded-full text-white text-xs flex items-center justify-center border-2 border-white"
                    style={{ backgroundColor: u.color }}
                    title={u.name}
                  >
                    {u.name.charAt(0)}
                  </div>
                ))}
              </div>
            )}
            <span
              className={`px-2 py-1 text-xs rounded ${synced ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}
            >
              {synced ? '● Live' : '○ Connecting...'}
            </span>
          </div>
        </div>

        <p className="text-sm text-gray-600 mb-4">
          Collaborate with your team on the project description. Everyone can edit in real-time.
        </p>

        <div className="bg-gray-50 rounded p-3 mb-4 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-500">Project:</span>
            <span className="font-medium">{projectName}</span>
          </div>
          {gitRepo && (
            <div className="flex justify-between mt-1">
              <span className="text-gray-500">Repository:</span>
              <GitRepoLink
                gitRepo={gitRepo}
                gitProvider={gitProvider}
                className="font-mono text-xs"
              />
            </div>
          )}
        </div>

        {isRunning && startedBy && (
          <div className="bg-blue-50 border border-blue-200 text-blue-700 px-4 py-3 rounded mb-4">
            <span className="font-medium">{startedBy}</span> started the agent...
          </div>
        )}

        {isStale && (
          <div className="bg-yellow-50 border border-yellow-200 text-yellow-700 px-4 py-3 rounded mb-4 flex justify-between items-center">
            <span>Previous agent run ended. Ready to start again.</span>
            <button onClick={reset} className="text-sm underline hover:no-underline">
              Reset
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Project Description
            <span className="text-xs text-gray-400 ml-2">(collaborative)</span>
          </label>

          {/* Remote cursor indicators */}
          {remoteUsersList.filter((u) => u.cursor).length > 0 && (
            <div className="flex gap-2 mb-1 text-xs">
              {remoteUsersList
                .filter((u) => u.cursor)
                .map((u, i) => (
                  <span
                    key={i}
                    className="px-1.5 py-0.5 rounded text-white"
                    style={{ backgroundColor: u.color }}
                  >
                    {u.name} editing
                  </span>
                ))}
            </div>
          )}

          <CollaborativeTextarea
            value={description}
            onChange={(val, cursor) => setDescription(val, cursor)}
            onCursorChange={setCursor}
            remoteUsers={remoteUsers}
            placeholder="Describe what you want to build, the main features, target users, and any technical requirements..."
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 min-h-[150px]"
            disabled={isRunning}
          />

          <div className="flex justify-end gap-2 mt-6">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded"
              disabled={isRunning}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600 disabled:opacity-50"
              disabled={isRunning || !description.trim()}
            >
              {isRunning ? 'Starting...' : 'Start Agent'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
