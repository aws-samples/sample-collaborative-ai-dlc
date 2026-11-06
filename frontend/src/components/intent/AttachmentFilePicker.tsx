import { useRef } from 'react';
import { Paperclip } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ATTACHMENT_ACCEPT } from '@/services/attachmentUploads';

export function AttachmentFilePicker({
  disabled,
  onFiles,
}: {
  disabled: boolean;
  onFiles: (files: FileList | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">Attachments</span>
        <input
          ref={input}
          type="file"
          className="hidden"
          data-testid="attachment-picker"
          accept={ATTACHMENT_ACCEPT}
          multiple
          disabled={disabled}
          onChange={(event) => {
            onFiles(event.target.files);
            event.target.value = '';
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => input.current?.click()}
        >
          <Paperclip className="mr-1.5 h-3.5 w-3.5" />
          Attach files
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        PDF, DOCX, XLSX, text, Markdown, CSV, HTML, or images (PNG, JPEG, WebP, SVG). Up to 50
        files, 5 MB each, 25 MB total.
      </p>
    </div>
  );
}
