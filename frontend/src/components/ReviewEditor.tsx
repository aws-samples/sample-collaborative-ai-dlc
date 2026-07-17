import { useEffect, useState } from 'react';
import { useCollaborativeArtifact } from '../hooks/useCollaborativeArtifact';
import { CollaborativeTextarea } from './CollaborativeTextarea';
import type { Review, ReviewStatus } from '../services/reviews';
import { gitProviderTerminology, type GitProvider } from '../services/gitProvider';

interface Props {
  review: Review | null;
  sprintId: string;
  userName: string;
  gitProvider: GitProvider;
  readOnly?: boolean;
  onCreate: () => Promise<void>;
  onSave: (updates: { status?: ReviewStatus; comments?: string }) => Promise<void>;
  onSendToProvider: () => Promise<void>;
  onFocus?: () => void;
  onBlur?: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  PENDING: 'bg-yellow-100 text-yellow-800',
  PASSED: 'bg-green-100 text-green-800',
  FAILED: 'bg-red-100 text-red-800',
  PARTIAL: 'bg-yellow-100 text-yellow-800',
};

const VERDICT_BUTTONS: Array<{ status: ReviewStatus; label: string; className: string }> = [
  { status: 'PASSED', label: 'Pass', className: 'bg-green-600 text-white hover:bg-green-700' },
  {
    status: 'PARTIAL',
    label: 'Partial',
    className: 'bg-yellow-500 text-white hover:bg-yellow-600',
  },
  { status: 'FAILED', label: 'Fail', className: 'bg-red-600 text-white hover:bg-red-700' },
];

export default function ReviewEditor({
  review,
  sprintId,
  userName,
  gitProvider,
  readOnly = false,
  onCreate,
  onSave,
  onSendToProvider,
  onFocus,
  onBlur,
}: Props) {
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<'success' | 'error' | null>(null);
  const term = gitProviderTerminology(gitProvider);

  const { values, setField, initFields, synced, remoteUsers, setCursor } =
    useCollaborativeArtifact<{ comments: string }>(
      'review',
      sprintId,
      review?.id || 'pending',
      ['comments'],
      userName,
      !readOnly,
      async (v) => {
        await onSave({ comments: v.comments });
      },
    );

  // Seed the collaborative comments ONCE per review (keyed on id) when synced —
  // not on every review mutation, which would clobber live edits with stale props.
  useEffect(() => {
    if (synced && review) initFields({ comments: review.comments });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [synced, review?.id]);

  const handleVerdict = async (status: ReviewStatus) => {
    if (readOnly) return;
    await onSave({ status, comments: values.comments });
  };

  const handleSendToProvider = async () => {
    setSending(true);
    setSendResult(null);
    try {
      await onSendToProvider();
      setSendResult('success');
      setTimeout(() => setSendResult(null), 2000);
    } catch {
      setSendResult('error');
      setTimeout(() => setSendResult(null), 3000);
    } finally {
      setSending(false);
    }
  };

  if (!review) {
    return (
      <div className="text-center py-4">
        <p className="text-gray-500 mb-3">No review started yet</p>
        <button
          onClick={onCreate}
          disabled={readOnly}
          className="px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Start Review
        </button>
      </div>
    );
  }

  const remoteCount = remoteUsers.size;
  const canSendToProvider = review.status !== 'PENDING' && !readOnly;

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <span className={`px-3 py-1 text-sm rounded font-medium ${STATUS_COLORS[review.status]}`}>
          {review.status}
        </span>
        {remoteCount > 0 && (
          <div className="flex items-center gap-1">
            {Array.from(remoteUsers.values()).map((u, i) => (
              <div
                key={i}
                className="w-5 h-5 rounded-full text-white text-xs flex items-center justify-center"
                style={{ backgroundColor: u.color }}
              >
                {u.name?.charAt(0)}
              </div>
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
        className="w-full px-3 py-2 border rounded text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        rows={4}
        onFocus={onFocus}
        onBlur={onBlur}
        disabled={readOnly}
      />
      <div className="flex gap-2 mt-3">
        {VERDICT_BUTTONS.map(({ status, label, className }) => (
          <button
            key={status}
            onClick={() => handleVerdict(status)}
            disabled={readOnly}
            className={`px-3 py-1.5 text-sm rounded disabled:opacity-50 disabled:cursor-not-allowed ${
              review.status === status
                ? `${className} ring-2 ring-offset-1 ring-current`
                : 'border text-muted-foreground hover:bg-gray-50'
            }`}
          >
            {label}
          </button>
        ))}
        <button
          onClick={handleSendToProvider}
          disabled={!canSendToProvider || sending}
          className={`px-3 py-1.5 text-sm rounded ml-auto disabled:opacity-50 disabled:cursor-not-allowed ${
            sendResult === 'success'
              ? 'bg-green-600 text-white'
              : sendResult === 'error'
                ? 'bg-red-600 text-white'
                : 'bg-indigo-600 text-white hover:bg-indigo-700'
          }`}
          title={
            review.status === 'PASSED'
              ? `Post to ${term.changeRequestShort} and mark sprint as COMPLETED`
              : `Post the review verdict and comments to the ${term.label} ${term.changeRequestShort}`
          }
        >
          {sending
            ? 'Sending...'
            : sendResult === 'success'
              ? 'Sent!'
              : sendResult === 'error'
                ? 'Failed'
                : `Send to ${term.label}`}
        </button>
      </div>
    </div>
  );
}
