import { Link, useNavigate } from 'react-router-dom';
import { ConnectionStatus } from './ConnectionStatus';
import type { Sprint } from '../services/sprints';
import type { UserPresence } from '../hooks/usePresence';

interface SprintNavProps {
  projectId: string;
  sprintId: string;
  sprint: Sprint | null;
  users: UserPresence[];
  connectionStatus: 'connected' | 'connecting' | 'disconnected';
  user: { username?: string; displayName?: string; email?: string } | null;
  hasArtifacts: boolean;
}

const PHASES = [
  { id: 'INCEPTION', label: 'Inception', path: '' },
  { id: 'CONSTRUCTION', label: 'Construction', path: '/construction' },
  { id: 'REVIEW', label: 'Review', path: '/review' },
];

const ACTIVITY_LABELS: Record<string, string> = {
  idle: '',
  description: 'editing description',
  question: 'answering question',
};

export function SprintNav({ projectId, sprintId, sprint, users, connectionStatus, user, hasArtifacts }: SprintNavProps) {
  const navigate = useNavigate();
  const currentPhase = sprint?.phase || 'INCEPTION';

  return (
    <nav className="bg-white shadow">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between h-16 items-center">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate(`/project/${projectId}`)} className="text-gray-600 hover:text-gray-900 flex items-center">
              <svg className="w-5 h-5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
              Project
            </button>
            <div className="h-6 w-px bg-gray-300" />
            <h1 className="text-xl font-semibold">{sprint?.name || '...'}</h1>
            <ConnectionStatus status={connectionStatus} />
          </div>
          <div className="flex items-center gap-3">
            {hasArtifacts && (
              <>
                <div className="flex gap-1 border rounded-lg p-1 bg-gray-50">
                  {PHASES.map(phase => (
                    <div
                      key={phase.id}
                      className={`px-3 py-1.5 text-sm rounded ${
                        currentPhase === phase.id
                          ? 'bg-indigo-600 text-white'
                          : 'text-gray-400'
                      }`}
                    >
                      {phase.label}
                    </div>
                  ))}
                </div>
                <Link to={`/project/${projectId}/sprint/${sprintId}/graph`} className="px-3 py-1.5 text-sm border rounded hover:bg-gray-50">
                  Graph View
                </Link>
              </>
            )}
            <div className="flex -space-x-2">
              {users.map((u, i) => {
                const activity = u.activity && u.activity !== 'idle'
                  ? ACTIVITY_LABELS[u.activity] || u.activity
                  : '';
                return (
                  <div
                    key={i}
                    className="relative group"
                  >
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-medium border-2 ${
                        activity ? 'border-green-400' : 'border-white'
                      }`}
                      style={{ backgroundColor: u.color }}
                    >
                      {u.name.charAt(0).toUpperCase()}
                    </div>
                    {/* Activity indicator dot */}
                    {activity && (
                      <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-green-400 border-2 border-white rounded-full" />
                    )}
                    {/* Tooltip */}
                    <div className="absolute top-full mt-1 left-1/2 -translate-x-1/2 hidden group-hover:block z-10">
                      <div className="bg-gray-900 text-white text-xs rounded px-2 py-1 whitespace-nowrap">
                        {u.name}
                        {activity && <span className="text-gray-300 ml-1">- {activity}</span>}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <span className="text-sm text-gray-700">{user?.displayName || user?.email}</span>
          </div>
        </div>
      </div>
    </nav>
  );
}
