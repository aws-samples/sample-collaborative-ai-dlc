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
        Requests use a written prompt, supported attachments, imported tracker issue text and files,
        and one connected GitHub.com, GitLab.com or Bitbucket Cloud repository. Start captures the
        saved input revision, exact file contents and the repository&apos;s current default-branch
        commit. Finish or explicitly exclude failed imports before starting.
      </p>
      <p>
        Native uses the selected package and harness in a dedicated runtime. Platform managed
        environments, custom MCP servers and uploaded custom rules do not apply. Instructions and
        configuration in the pinned repository and package remain part of the workspace. Built-in
        native tools remain available. Imported content cannot authorize tool actions or approve
        workflow gates.
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
