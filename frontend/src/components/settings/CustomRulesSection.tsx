// Upload / list / delete a project's custom agent rules — user-uploaded .md
// reference docs (coding standards, API references, framework guidelines)
// injected into the agent context at run time.

import { useRef, useState } from 'react';
import type { CustomRule } from '@/services/projects';
import { Button } from '@/components/ui/button';
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
import { FileText, Upload, Download, Trash2 } from 'lucide-react';
import { SettingsCard } from '@/components/settings/SettingsCard';

const MAX_CUSTOM_RULES = 20;
const MAX_FILE_SIZE = 100 * 1024; // 100 KB

export interface UploadUrl {
  filename: string;
  s3Key: string;
  uploadUrl: string;
}

interface Props {
  /** Current docs (parent owns state so refresh-after-mutation lives there). */
  docs: CustomRule[];
  /** Mints presigned upload URLs (does NOT persist metadata). */
  onPresign: (docs: Array<{ filename: string }>) => Promise<{ uploadUrls?: UploadUrl[] }>;
  /** Persists the final metadata set (after uploads succeed / on delete). */
  onCommit: (docs: Array<{ filename: string }>) => Promise<{ saved: boolean }>;
  /** Reloads from the server (used after upload/delete to refresh URLs). */
  onRefresh: () => Promise<void>;
  /** True when the user may edit. */
  canEdit: boolean;
  /** One-line description; the "Maximum N…" sentence is appended automatically. */
  description: string;
  /** Card title. Defaults to "Custom Agent Rules". */
  title?: string;
  /** Report outcomes to the parent so messages render at its chosen location. */
  onSuccess?: (msg: string) => void;
  onError?: (msg: string) => void;
  onClearMessages?: () => void;
}

export function CustomRulesSection({
  docs,
  onPresign,
  onCommit,
  onRefresh,
  canEdit,
  description,
  title = 'Custom Agent Rules',
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
      // 1) Presign (no persist yet) for the files we're uploading.
      const resp = await onPresign(files.map((f) => ({ filename: f.name })));
      const urlByName = new Map(resp.uploadUrls?.map((u) => [u.filename, u.uploadUrl]) ?? []);
      const missing = files.filter((f) => !urlByName.has(f.name));
      if (missing.length > 0) {
        throw new Error(
          `Server did not return upload URLs for: ${missing.map((f) => f.name).join(', ')}`,
        );
      }

      // 2) Upload each body to S3.
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
      const uploaded = results
        .map((r, i) => (r.status === 'fulfilled' ? files[i].name : null))
        .filter((n): n is string => n !== null);
      const failed = files.map((f) => f.name).filter((n) => !uploaded.includes(n));

      // 3) Commit metadata ONLY for objects that actually landed in S3. Keep the
      //    existing docs whose name was NOT successfully uploaded — so a FAILED
      //    replacement preserves the old rule (dropping only on success avoids
      //    the backend purging the existing object on a failed re-upload).
      const uploadedSet = new Set(uploaded);
      const kept = docs.filter((d) => !uploadedSet.has(d.filename));
      const nextDocs = [
        ...kept.map((d) => ({ filename: d.filename })),
        ...uploaded.map((filename) => ({ filename })),
      ];
      await onCommit(nextDocs);

      await onRefresh();
      const succeededCount = uploaded.length;
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
    // Reset so picking the same file(s) again triggers onChange.
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
      if (file.size > MAX_FILE_SIZE) {
        errors.push(`"${file.name}" is ${(file.size / 1024).toFixed(1)} KB. Maximum is 100 KB.`);
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
    if (projectedTotal > MAX_CUSTOM_RULES) {
      fail(`Maximum ${MAX_CUSTOM_RULES} custom rules (would result in ${projectedTotal})`);
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
      await onCommit(nextDocs.map((d) => ({ filename: d.filename })));
      await onRefresh();
      success(`Deleted ${filename}`);
    } catch (err) {
      fail(err instanceof Error ? err.message : 'Failed to delete file');
    } finally {
      setUploading(false);
      setConfirmDelete(null);
    }
  };

  const uploadButton = canEdit ? (
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
        disabled={uploading || docs.length >= MAX_CUSTOM_RULES}
        title={
          docs.length >= MAX_CUSTOM_RULES ? `Maximum ${MAX_CUSTOM_RULES} documents` : undefined
        }
        className="gap-1.5"
      >
        <Upload className="h-3.5 w-3.5" />
        {uploading ? 'Uploading…' : 'Upload File'}
      </Button>
    </>
  ) : null;

  return (
    <>
      <SettingsCard
        icon={<FileText />}
        title={title}
        description={
          canEdit
            ? `${description} Maximum ${MAX_CUSTOM_RULES} documents, 100 KB each. Only .md files.`
            : description
        }
        headerAction={uploadButton}
      >
        {docs.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">No custom rules.</p>
        ) : (
          <div className="divide-y divide-border border rounded-md">
            {docs.map((doc) => (
              <div key={doc.filename} className="px-3 py-2 flex items-center justify-between gap-2">
                <span className="font-mono text-xs truncate">{doc.filename}</span>
                {canEdit && (
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
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </SettingsCard>

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
