# Real-time Collaboration

Multiple users can edit the same spec simultaneously. Changes sync instantly with no conflicts.

## How it works

AIDLC Collaborative uses **Yjs**, a conflict-free replicated data type (CRDT) library, with **Y-WebSocket** for real-time synchronization. This means:

- Every user has a local copy of the document
- Changes are merged automatically without conflicts
- Even if users edit the same line at the same time, both changes are preserved
- The system works offline and syncs when the connection is restored

## Presence

The editor shows who else is currently viewing or editing the spec. Each user has a colored cursor and a name label.

## Chat collaboration

The chat history is also shared across users. When the LLM assistant responds, all connected users see the response. Chat messages are synced through the same Yjs infrastructure.

## Access levels

Realtime access is **membership-scoped**: every WebSocket connection (both the
Yjs collaboration fabric and the application event channel) requires a
short-lived, HMAC-signed scope token that is only issued to members of the
project. The token is bound to your signed-in identity, covers exactly the
sprint/project you requested, and expires after ten minutes — connections are
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
