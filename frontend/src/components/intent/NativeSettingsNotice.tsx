/** Shared explanation only; admission and the runtime remain the capability owners. */
export function NativeSettingsNotice() {
  return (
    <div className="space-y-2 text-sm text-muted-foreground">
      <p>
        Native uses the selected package and harness in a dedicated runtime. Platform managed
        environments, custom MCP servers and uploaded custom rules do not apply. Instructions and
        configuration in the pinned repository and package remain part of the workspace.
      </p>
      <p>
        Start captures the project or platform default model for this harness and the starting
        member&apos;s effective credential scope. Agent tier assignments do not apply. Later
        settings changes do not retarget the run; credential rotation within the captured scope is
        allowed. With no model selection, the harness default does not pin an exact model.
      </p>
      <p>Native graph enrichment and optional debug archives are off.</p>
      <p>
        Harness availability does not establish live qualification for every model or package fork.
      </p>
    </div>
  );
}
