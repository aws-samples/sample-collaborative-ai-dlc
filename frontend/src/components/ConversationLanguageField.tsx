// Output-language override for one DRAFT intent (#784). Edits the raw BCP 47
// tag with a live display-name preview; only a VALIDATED tag (or an explicit
// clear) is committed to the collaborative draft, so a half-typed tag can
// never make the shared autosave fail for every member.

import { useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { conversationLanguageLabel, resolveConversationLanguage } from '@/lib/conversationLanguage';

interface Props {
  // The committed tag from the collaborative draft (null = none).
  value: string | null;
  disabled?: boolean;
  // Commit a validated tag, or null to clear.
  onChange: (tag: string | null) => void;
}

export function ConversationLanguageField({ value, disabled, onChange }: Props) {
  const [text, setText] = useState(value ?? '');
  const [error, setError] = useState<string | null>(null);
  const focusedRef = useRef(false);

  // Follow peer edits while the member is not typing here.
  useEffect(() => {
    if (!focusedRef.current) {
      setText(value ?? '');
      setError(null);
    }
  }, [value]);

  const commit = () => {
    const resolved = resolveConversationLanguage(text);
    if ('error' in resolved) {
      setError(resolved.error);
      return;
    }
    setError(null);
    setText(resolved.value?.tag ?? '');
    onChange(resolved.value?.tag ?? null);
  };

  const resolved = resolveConversationLanguage(text);
  const preview = 'error' in resolved ? null : conversationLanguageLabel(resolved.value);

  return (
    <div className="space-y-1.5" data-testid="conversation-language-field">
      <Label htmlFor="intent-conversation-language" className="text-sm font-medium">
        Output language
      </Label>
      <Input
        id="intent-conversation-language"
        placeholder='BCP 47 tag, e.g. "ko" — empty for the default'
        value={text}
        disabled={disabled}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        onFocus={() => {
          focusedRef.current = true;
        }}
        onBlur={() => {
          focusedRef.current = false;
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {preview
            ? `Agents write artifacts, questions and summaries in ${preview}; code and commit messages stay in English.`
            : 'Not set — agents keep the default behaviour.'}
        </p>
      )}
    </div>
  );
}
