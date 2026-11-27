# Real-time Collaboration

Everything in a space is live: intent progress, agent output, gates, and discussions stream to every connected member, and collaborative documents sync instantly with no conflicts.

## How it works

Two real-time fabrics work together:

- The **application WebSocket channel** delivers agent progress, stage events, gate notifications, and discussion messages on a per-intent channel — this is what makes the workbench and observability views live.
- **Yjs**, a conflict-free replicated data type (CRDT) library, powers collaborative document editing: every user has a local copy, changes merge automatically without conflicts, and concurrent edits to the same line are both preserved.

## Presence

Collaborative surfaces show who else is currently viewing or editing. Each user has a colored cursor and a name label.

## Access levels

Realtime access is **membership-scoped**: every WebSocket connection (both the
Yjs collaboration fabric and the application event channel) requires a
short-lived, HMAC-signed scope token that is only issued to members of the
space. The token is bound to your signed-in identity, covers exactly the
intent/space you requested, and expires after ten minutes — connections are
transparently refreshed while you remain a member.

| Space role | Can read | Can post in discussions | Can redact discussion messages |
| ---------- | -------- | ----------------------- | ------------------------------ |
| Owner      | Yes      | Yes                     | Yes                            |
| Member     | Yes      | Yes                     | No                             |
| Viewer     | Yes      | No                      | No                             |
| Non-member | No       | No                      | No                             |

The server checks your stage permissions when you open or reconnect to a shared
answer, review, or stage document. An open editor reuses that decision for up to
30 seconds, then checks again on the next sync or save request. Read-only stage
editors request a sync every 30 seconds so newly granted access takes effect
without editing or reloading. Stage action controls also refresh every 30 seconds. Offline edits
sync on reconnect only if you still have permission. Submitting an answer,
approving a review, or saving a document through the API checks your current
permissions on each request. See [Stage responsibilities](projects.md#stage-responsibilities).
