import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface Props {
  title: string;
  prompt: string;
  onTitleChange: (value: string) => void;
  onPromptChange: (value: string) => void;
  disabled?: boolean;
  importing?: boolean;
}

export function IntentRequestFields({
  title,
  prompt,
  onTitleChange,
  onPromptChange,
  disabled = false,
  importing = false,
}: Props) {
  return (
    <>
      <div>
        <Label htmlFor="intent-title">Title</Label>
        <Input
          id="intent-title"
          value={title}
          disabled={disabled}
          onChange={(event) => onTitleChange(event.target.value)}
          placeholder="e.g. Add user authentication"
          className="mt-1.5"
          autoFocus
        />
      </div>
      <div>
        <Label htmlFor="intent-prompt">
          Prompt
          {importing && (
            <span className="ml-2 text-xs text-muted-foreground">Importing issue…</span>
          )}
        </Label>
        <textarea
          id="intent-prompt"
          value={prompt}
          disabled={disabled}
          onChange={(event) => onPromptChange(event.target.value)}
          rows={10}
          placeholder="Describe the intent — you can refine it together on the next step…"
          className="mt-1.5 w-full rounded-md border bg-background px-3 py-2 text-sm"
        />
      </div>
    </>
  );
}
