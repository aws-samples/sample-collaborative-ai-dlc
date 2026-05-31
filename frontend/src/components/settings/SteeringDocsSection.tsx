import { useRef, useState } from 'react';
import type { SteeringDoc } from '../../services/projects';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Upload, Download, Trash2 } from 'lucide-react';

const MAX_STEERING_DOCS = 20;
const MAX_STEERING_FILE_SIZE = 100 * 1024; // 100 KB

export interface UploadUrl {
  filename: string;
  s3Key: string;
  uploadUrl: string;
}

interface Props {
  // Current docs (parent owns state so refresh-after-mutation lives there).
  docs: SteeringDoc[];
  // Persists metadata. Returns the presigned upload URLs from the server.
  onSaveMetadata: (docs: Array<{ filename: string }>) => Promise<{ uploadUrls?: UploadUrl[] }>;
  // Reloads from the server (used after upload/delete to refresh download URLs).
  onRefresh: () => Promise<void>;
  // True when the user is allowed to edit.
  canEdit: boolean;
  // Short helper text under the title. The "Maximum N docs..." sentence is appended automatically.
  description: string;
  // Title rendered in the card header. Defaults to "Steering Rules".
  title?: string;
  // Reports outcomes to the parent so messages render at the parent's chosen location.
  onSuccess?: (msg: string) => void;
  onError?: (msg: string) => void;
  onClearMessages?: () => void;
}

export function SteeringDocsSection({
  docs,
  onSaveMetadata,
  onRefresh,
  canEdit,
  description,
  title = 'Steering Rules',
  onSuccess,
  onError,
  onClearMessages,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState<{
    files: File[];
    conflicts: string[];
  } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const success = (msg: string) => onSuccess?.(msg);
  const fail = (msg: string) => onError?.(msg);
  const clear = () => onClearMessages?.();

  const performUpload = async (files: File[]) => {
    if (files.length === 0) return;
    clear();
    setUploading(true);
    try {
      // Files matching an existing filename replace that slot (same s3Key);
      // new filenames are appended.
      const fileNames = new Set(files.map((f) => f.name));
      const kept = docs.filter((d) => !fileNames.has(d.filename));
      const nextDocs = [...kept, ...files.map((f) => ({ filename: f.name, s3Key: '' }))];

      const resp = await onSaveMetadata(nextDocs.map((d) => ({ filename: d.filename })));
      const urlByName = new Map(resp.uploadUrls?.map((u) => [u.filename, u.uploadUrl]) ?? []);
      const missing = files.filter((f) => !urlByName.has(f.name));
      if (missing.length > 0) {
        throw new Error(
          `Server did not return upload URLs for: ${missing.map((f) => f.name).join(', ')}`,
        );
      }

      const results = await Promise.allSettled(
        files.map((f) =>
          fetch(urlByName.get(f.name)!, {
            method: 'PUT',
            headers: { 'Content-Type': 'text/markdown' },
            body: f,
          }).then((r) => {
            if (!r.ok) throw new Error(`${f.name}: HTTP ${r.status}`);
            return f.name;
          }),
        ),
      );
      const failed = results
        .map((r, i) => (r.status === 'rejected' ? files[i].name : null))
        .filter((n): n is string => n !== null);

      await onRefresh();
      const succeededCount = files.length - failed.length;
      if (failed.length === 0) {
        success(
          succeededCount === 1 ? `Uploaded ${files[0].name}` : `Uploaded ${succeededCount} files`,
        );
      } else if (succeededCount > 0) {
        fail(`Uploaded ${succeededCount} of ${files.length}. Failed: ${failed.join(', ')}`);
      } else {
        fail(`Upload failed for: ${failed.join(', ')}`);
      }
    } catch (err) {
      fail(err instanceof Error ? err.message : 'Failed to upload files');
    } finally {
      setUploading(false);
    }
  };

  const handleFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    // Reset the input so picking the same file(s) again triggers onChange.
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (picked.length === 0) return;
    clear();

    const errors: string[] = [];
    const valid: File[] = [];
    for (const file of picked) {
      if (!file.name.toLowerCase().endsWith('.md')) {
        errors.push(`"${file.name}" is not a Markdown file (.md required)`);
        continue;
      }
      if (file.size > MAX_STEERING_FILE_SIZE) {
        errors.push(
          `"${file.name}" is ${(file.size / 1024).toFixed(1)} KB. Maximum allowed is 100 KB.`,
        );
        continue;
      }
      valid.push(file);
    }

    if (errors.length > 0) {
      fail(errors.join(' '));
      if (valid.length === 0) return;
    }

    const existingNames = new Set(docs.map((d) => d.filename));
    const conflicts = valid.filter((f) => existingNames.has(f.name)).map((f) => f.name);
    const newCount = valid.length - conflicts.length;
    const projectedTotal = docs.length + newCount;
    if (projectedTotal > MAX_STEERING_DOCS) {
      fail(`Maximum ${MAX_STEERING_DOCS} steering documents (would result in ${projectedTotal})`);
      return;
    }

    if (conflicts.length > 0) {
      setConfirmReplace({ files: valid, conflicts });
      return;
    }
    performUpload(valid);
  };

  const handleDelete = async (filename: string) => {
    clear();
    setUploading(true);
    try {
      const nextDocs = docs.filter((d) => d.filename !== filename);
      await onSaveMetadata(nextDocs.map((d) => ({ filename: d.filename })));
      await onRefresh();
      success(`Deleted ${filename}`);
    } catch (err) {
      fail(err instanceof Error ? err.message : 'Failed to delete file');
    } finally {
      setUploading(false);
      setConfirmDelete(null);
    }
  };

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">{title}</CardTitle>
            {canEdit && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".md,text/markdown"
                  multiple
                  className="hidden"
                  onChange={handleFileSelected}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading || docs.length >= MAX_STEERING_DOCS}
                  title={
                    docs.length >= MAX_STEERING_DOCS
                      ? `Maximum ${MAX_STEERING_DOCS} documents`
                      : undefined
                  }
                >
                  <Upload className="h-3.5 w-3.5 mr-1" />
                  {uploading ? 'Uploading...' : 'Upload File'}
                </Button>
              </>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {description} Maximum {MAX_STEERING_DOCS} documents, 100 KB each. Only <code>.md</code>{' '}
            files.
          </p>
          {docs.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              No steering rules uploaded.
            </p>
          ) : (
            <div className="divide-y divide-border border rounded-md">
              {docs.map((doc) => (
                <div
                  key={doc.filename}
                  className="px-3 py-2 flex items-center justify-between gap-2"
                >
                  <span className="font-mono text-xs truncate">{doc.filename}</span>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      asChild={!!doc.downloadUrl}
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-muted-foreground hover:text-foreground"
                      disabled={!doc.downloadUrl}
                      title="Download"
                    >
                      {doc.downloadUrl ? (
                        <a
                          href={doc.downloadUrl}
                          download={doc.filename}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <Download className="h-3.5 w-3.5" />
                        </a>
                      ) : (
                        <Download className="h-3.5 w-3.5" />
                      )}
                    </Button>
                    {canEdit && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        onClick={() => setConfirmDelete(doc.filename)}
                        disabled={uploading}
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Confirm Replace */}
      <AlertDialog
        open={!!confirmReplace}
        onOpenChange={(open) => {
          if (!open) setConfirmReplace(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmReplace && confirmReplace.conflicts.length === 1
                ? 'Replace File?'
                : 'Replace Files?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmReplace && (
                <>
                  {confirmReplace.conflicts.length === 1 ? (
                    <>
                      A file named{' '}
                      <span className="font-mono font-semibold text-foreground">
                        {confirmReplace.conflicts[0]}
                      </span>{' '}
                      already exists. Replace it with the new upload?
                    </>
                  ) : (
                    <>
                      The following files already exist and will be replaced:
                      <ul className="mt-2 list-disc list-inside font-mono text-foreground">
                        {confirmReplace.conflicts.map((name) => (
                          <li key={name}>{name}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {confirmReplace && confirmReplace.conflicts.length < confirmReplace.files.length && (
              <AlertDialogAction
                onClick={() => {
                  if (confirmReplace) {
                    const conflictSet = new Set(confirmReplace.conflicts);
                    const filtered = confirmReplace.files.filter((f) => !conflictSet.has(f.name));
                    setConfirmReplace(null);
                    performUpload(filtered);
                  }
                }}
              >
                Skip Conflicts
              </AlertDialogAction>
            )}
            <AlertDialogAction
              onClick={() => {
                if (confirmReplace) {
                  const files = confirmReplace.files;
                  setConfirmReplace(null);
                  performUpload(files);
                }
              }}
            >
              {confirmReplace && confirmReplace.conflicts.length === 1 ? 'Replace' : 'Replace All'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirm Delete */}
      <AlertDialog
        open={!!confirmDelete}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete File?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDelete && (
                <>
                  Permanently delete{' '}
                  <span className="font-mono font-semibold text-foreground">{confirmDelete}</span>?
                  This cannot be undone.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmDelete) handleDelete(confirmDelete);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
