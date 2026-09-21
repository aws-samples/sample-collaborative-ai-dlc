# Exporting a Workspace

You can export an intent as a [native AI-DLC](https://github.com/awslabs/aidlc-workflows/tree/v2) workspace and continue the workflow in a local agent harness. The export preserves the intent's methodology state and work products in a portable ZIP.

Use this when you want to inspect or continue the work outside Collaborative AIDLC. It is a point-in-time handoff, not a synchronized local copy of the intent.

## Export an intent

The export control appears beside **Discuss** in the intent header after the workflow has started.

1. Select the small arrow on the left side of the export control.
2. Choose a harness:
   - Claude
   - Codex
   - Kiro CLI
   - Kiro IDE
   - OpenCode
3. Select the download button beside the arrow.
4. Review the handoff warning, then choose **Download workspace**.

Choosing a harness only changes the export format. The ZIP is not prepared or downloaded until you select the download button and confirm.

The selected harness determines the configuration files, launch command, and AI-DLC continuation command included in the setup instructions. If you do not select another harness, the export uses the CLI configured for the intent.

## Which state is exported

The exported state depends on what the intent is doing:

- **Running:** the export uses the latest completed workflow checkpoint. Work from the stage currently in progress is not included.
- **Waiting:** the export uses the current parked state, including completed stages, answers, and available artifacts.
- **Succeeded, failed, or cancelled:** the export uses the current terminal state.

A running intent cannot be exported until it has completed at least one checkpoint. Retry after the current stage reaches a workflow boundary if the UI reports that no completed checkpoint is available.

## What the ZIP contains

The archive contains the selected native AI-DLC distribution and a projection of the intent, including:

- Harness-specific configuration and AI-DLC tools (.kiro, .claude, etc...)
- Workflow state and the continuation point
- The intent's pinned workflow projection, including custom scopes such as `feature-custom` and their stage execute/skip selection
- Completed methodology artifacts
- Recorded human questions and answers
- The workflow audit trail and runtime graph
- The approved unit-of-work dependency graph, when available
- Repository URLs, intent branches, and workspace layout metadata
- `export-manifest.json`, with the exported files, sizes, and SHA-256 hashes

The export keeps the AI-DLC methodology revision pinned by the intent so the local workspace uses the same methodology definition as the collaborative run. It registers the intent's selected projection as a native AI-DLC scope, preserving a customized workflow instead of reverting to a standard feature scope.

## What the ZIP does not contain

Source repositories and source-control credentials are not bundled in the archive. The setup dialog provides commands to clone or update each repository on its declared intent branch using your own Git credentials.

Active-stage work that has not reached a completed checkpoint is also excluded from a running-intent export.

!!! warning "Local work is not synchronized back"

    Decisions, approvals, artifacts, and code changes made in the exported workspace are not synchronized back to the original intent or added to its traceability history. Treat the export as a one-way handoff. Push local code through your normal source-control process if you want to preserve it.

## Set up the downloaded workspace

After the download starts, the setup dialog shows commands tailored to the archive's workspace layout and repositories. Follow them in order:

1. Create a local directory and extract the ZIP.
2. Clone or update the repositories on the branches listed by the export.
3. Start the selected harness, or open the directory in Kiro IDE.
4. Run the displayed AI-DLC continuation command inside the agent session.

For multi-repository projects, keep the cloned repositories as immediate children of the exported workspace. When offered, the workspace-sync command reads `repos.json` and creates this layout automatically.

The download URL is short-lived and expires after 15 minutes. Create another export if the download no longer starts.

## Warnings and compatibility

Read any warnings shown after the download. They can identify a legacy intent that did not pin its methodology revision or an older AI-DLC runtime that needs an explicit construction-unit continuation instruction.

An export may be unavailable when:

- The intent is still a draft or has not started.
- A running intent has no completed checkpoint yet.
- The workflow used incompatible edited methodology blocks.
- The execution contains stages from different AI-DLC methodology revisions.
- The intent changed while a parked-state export was being prepared. Retry to export a consistent snapshot.

Exporting does not stop, cancel, or otherwise modify the collaborative intent.
