import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { nativePromptValid } from '@/services/nativeIntents';
import type { NativeIntentAdapter } from '@/contexts/adapters/nativeIntent';

export function NativePromptEditor({ adapter }: { adapter: NativeIntentAdapter }) {
  const { intent, promptDraft, savingPrompt, promptUncertain, startPending } = adapter;
  if (!intent || intent.execution || intent.promptRevision === undefined) return null;
  const changed = promptDraft && promptDraft.expectedRevision !== intent.promptRevision;
  return (
    <section className="space-y-3 rounded-md border p-4">
      <h2 className="font-medium">Task prompt</h2>
      {promptDraft ? (
        <>
          <Label htmlFor="native-saved-prompt">What would you like to build?</Label>
          <textarea
            id="native-saved-prompt"
            className="min-h-40 w-full rounded-md border bg-background p-3 text-sm"
            value={promptDraft.text}
            disabled={savingPrompt || promptUncertain}
            onChange={(event) => adapter.editPrompt(event.target.value)}
          />
          {changed && (
            <p role="status" className="text-sm">
              The saved prompt changed. Your edits are still shown. Reload the saved prompt before
              editing again.
            </p>
          )}
          {promptUncertain && (
            <p role="status" className="text-sm">
              Saving is not confirmed. Retry this save before making more changes.
            </p>
          )}
          {!nativePromptValid(promptDraft.text) && (
            <p className="text-sm">
              Enter a nonblank prompt of at most 64 KiB without null characters.
            </p>
          )}
          <div className="flex gap-2">
            <Button
              onClick={() => void adapter.savePrompt()}
              disabled={
                savingPrompt ||
                (!promptUncertain && Boolean(changed)) ||
                !nativePromptValid(promptDraft.text)
              }
            >
              {savingPrompt
                ? 'Saving prompt…'
                : promptUncertain
                  ? 'Retry prompt save'
                  : 'Save prompt'}
            </Button>
            <Button
              variant="outline"
              disabled={savingPrompt || promptUncertain}
              onClick={() => {
                adapter.discardPrompt();
                void adapter.refresh();
              }}
            >
              Reload saved prompt
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="whitespace-pre-wrap text-sm">
            {intent.prompt || 'Add a prompt before starting the agent.'}
          </p>
          <Button
            variant="outline"
            disabled={adapter.acting === 'start'}
            onClick={() => adapter.editPrompt(intent.prompt)}
          >
            {intent.prompt ? 'Edit prompt' : 'Add prompt'}
          </Button>
          {startPending && (
            <p className="text-sm">
              Start is not confirmed. Refresh status, retry Start, or save a revised prompt.
            </p>
          )}
        </>
      )}
    </section>
  );
}
