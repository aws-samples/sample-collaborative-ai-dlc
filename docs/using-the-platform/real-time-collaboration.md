# Real-time Collaboration

Everything in a project is live: intent progress, agent output, gates, and discussions stream to every connected member, and collaborative documents sync instantly with no conflicts.

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
project. The token is bound to your signed-in identity, covers exactly the
intent/project you requested, and expires after ten minutes — connections are
transparently refreshed while you remain a member.

| Role (project graph) | Can connect & edit | Can post in discussions | Can redact discussion messages |
| -------------------- | ------------------ | ----------------------- | ------------------------------ |
| Owner                | Yes                | Yes                     | Yes                            |
| Admin                | Yes                | Yes                     | Yes                            |
| Member               | Yes                | Yes                     | No                             |
| Non-member           | No (403)           | No                      | No                             |

Two things to be aware of:

- There is **no role-level read-only mode** on the Yjs sync protocol — every
  project member can edit collaborative documents. Durable writes are
  independently authorized in the REST layer.
- **Active-session window**: when a member is removed from a project, their
  already-open connections remain authorized for at most the remaining token
  lifetime (≤ 10 minutes) before the server closes them.
