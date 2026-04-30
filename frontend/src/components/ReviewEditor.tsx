import { useEffect } from 'react';
import { useCollaborativeArtifact } from '../hooks/useCollaborativeArtifact';
import { CollaborativeTextarea } from './CollaborativeTextarea';
import type { Review, ReviewStatus } from '../services/reviews';

interface Props {
  review: Review | null;
  sprintId: string;
  userName: string;
  onCreate: () => Promise<void>;
  onSave: (updates: { status?: ReviewStatus; comments?: string }) => Promise<void>;
  onFocus?: () => void;
  onBlur?: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  PENDING: 'bg-yellow-100 text-yellow-800',
  PASSED: 'bg-green-100 text-green-800',
  FAILED: 'bg-red-100 text-red-800',
};

export default function ReviewEditor({ review, sprintId, userName, onCreate, onSave, onFocus, onBlur }: Props) {
  const { values, setField, initFields, synced, remoteUsers, setCursor } = useCollaborativeArtifact<{ comments: string }>(
    'review', sprintId, review?.id || 'pending', ['comments'], userName, true,
    async (v) => { await onSave({ comments: v.comments }); },
  );

  useEffect(() => {
    if (synced && review) initFields({ comments: review.comments });
  }, [synced, review?.id]);

  if (!review) {
    return (
      <div className="text-center py-4">
        <p className="text-gray-500 mb-3">No review started yet</p>
        <button onClick={onCreate} className="px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700">Start Review</button>
      </div>
    );
  }

  const remoteCount = remoteUsers.size;

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <span className={`px-3 py-1 text-sm rounded font-medium ${STATUS_COLORS[review.status]}`}>{review.status}</span>
        {remoteCount > 0 && (
          <div className="flex items-center gap-1">
            {Array.from(remoteUsers.values()).map((u, i) => (
              <div key={i} className="w-5 h-5 rounded-full text-white text-xs flex items-center justify-center" style={{ backgroundColor: u.color }}>{u.name?.charAt(0)}</div>
            ))}
            <span className="text-xs text-indigo-600">collaborating</span>
          </div>
        )}
      </div>
      <CollaborativeTextarea
        value={values.comments || ''}
        onChange={(val, cursor) => setField('comments', val, cursor)}
        onCursorChange={setCursor}
        remoteUsers={remoteUsers}
        placeholder="Review comments..."
        className="w-full px-3 py-2 border rounded text-sm"
        rows={4}
        onFocus={onFocus}
        onBlur={onBlur}
      />
      <div className="flex gap-2 mt-3">
        <button onClick={() => onSave({ status: 'PASSED', comments: values.comments })} className="px-3 py-1.5 text-sm bg-green-600 text-white rounded hover:bg-green-700">Pass</button>
        <button onClick={() => onSave({ status: 'FAILED', comments: values.comments })} className="px-3 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700">Fail</button>
        <button onClick={() => onSave({ comments: values.comments })} className="px-3 py-1.5 text-sm border rounded hover:bg-gray-50">Save Comments</button>
      </div>
    </div>
  );
}
