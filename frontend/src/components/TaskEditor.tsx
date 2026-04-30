import { useEffect } from 'react';
import { useCollaborativeArtifact } from '../hooks/useCollaborativeArtifact';
import { CollaborativeTextarea } from './CollaborativeTextarea';
import type { Task } from '../services/tasks';

interface Props {
  task: Task;
  sprintId: string;
  editing: boolean;
  userName: string;
  onSave: (updates: Partial<Task>) => Promise<void>;
  onDelete: () => Promise<void>;
  onEdit: () => void;
  onCancel: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  todo: 'bg-gray-100 text-gray-700',
  'in-progress': 'bg-blue-100 text-blue-700',
  done: 'bg-green-100 text-green-700',
};

export default function TaskEditor({ task, sprintId, editing, userName, onSave, onDelete, onEdit, onCancel, onFocus, onBlur }: Props) {
  const { values, setField, initFields, synced, remoteUsers, setCursor } = useCollaborativeArtifact<{ title: string; description: string; status: string }>(
    'task', sprintId, task.id, ['title', 'description', 'status'], userName, editing,
    async (v) => { await onSave({ title: v.title, description: v.description, status: v.status }); },
  );

  useEffect(() => {
    if (synced && editing) initFields({ title: task.title, description: task.description, status: task.status });
  }, [synced, editing]);

  const remoteCount = remoteUsers.size;

  if (!editing) {
    return (
      <div onClick={onEdit} className="p-4 border rounded hover:bg-gray-50 cursor-pointer">
        <div className="flex justify-between items-start">
          <h4 className="font-medium">{values.title || task.title}</h4>
          <div className="flex items-center gap-2">
            <span className={`px-2 py-0.5 text-xs rounded ${STATUS_COLORS[task.status] || STATUS_COLORS.todo}`}>{task.status}</span>
            {remoteCount > 0 && <span className="text-xs text-indigo-500">{remoteCount} editing</span>}
            <button onClick={(e) => { e.stopPropagation(); onDelete(); }} className="text-gray-400 hover:text-red-600 p-1">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
            </button>
          </div>
        </div>
        <p className="text-sm text-gray-600 mt-1">{values.description || task.description}</p>
      </div>
    );
  }

  return (
    <div className="p-4 border-2 border-indigo-300 rounded bg-indigo-50" onClick={e => e.stopPropagation()}>
      {remoteCount > 0 && (
        <div className="flex items-center gap-1 mb-2">
          {Array.from(remoteUsers.values()).map((u, i) => (
            <div key={i} className="w-5 h-5 rounded-full text-white text-xs flex items-center justify-center" style={{ backgroundColor: u.color }}>{u.name?.charAt(0)}</div>
          ))}
          <span className="text-xs text-indigo-600">collaborating</span>
        </div>
      )}
      <input value={values.title || ''} onChange={e => setField('title', e.target.value, e.target.selectionStart ?? undefined)} className="w-full px-2 py-1 border rounded text-sm font-medium mb-2" placeholder="Title" />
      <CollaborativeTextarea
        value={values.description || ''}
        onChange={(val, cursor) => setField('description', val, cursor)}
        onCursorChange={setCursor}
        remoteUsers={remoteUsers}
        placeholder="Description"
        className="w-full px-2 py-1 border rounded text-sm mb-2"
        rows={3}
        onFocus={onFocus}
        onBlur={onBlur}
      />
      <select value={values.status || task.status} onChange={e => setField('status', e.target.value)} className="px-2 py-1 border rounded text-sm mb-2">
        <option value="todo">Todo</option>
        <option value="in-progress">In Progress</option>
        <option value="done">Done</option>
      </select>
      <div className="flex gap-2">
        <button onClick={() => onSave({ title: values.title, description: values.description, status: values.status })} className="px-3 py-1 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700">Save</button>
        <button onClick={onCancel} className="px-3 py-1 text-sm border rounded hover:bg-gray-50">Cancel</button>
      </div>
    </div>
  );
}
