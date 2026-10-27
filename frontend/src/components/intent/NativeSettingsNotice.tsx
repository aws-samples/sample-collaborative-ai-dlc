/** Shared explanation only; admission and the runtime remain the capability owners. */
export function NativeSettingsNotice() {
  return (
    <div className="space-y-2 text-sm text-muted-foreground">
      <p>
        The release target is AI-DLC 2.11.1 with Claude Code, Codex, OpenCode and Kiro. Complete
        deployed qualification is still pending for every harness. Kiro is temporarily unavailable
        for new native executions pending AI-DLC input and authentication qualification; it remains
        required for release.
      </p>
      <p>
        Current requests use a written prompt and one connected GitHub, GitLab or Bitbucket
        repository. Attachments and tracker imports are planned for this release.
      </p>
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
    </div>
  );
}
