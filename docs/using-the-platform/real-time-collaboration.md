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

Your access level determines what you can do in a collaborative session:

| Role | Can edit | Can chat | Can comment |
|------|----------|----------|-------------|
| Admin | Yes | Yes | Yes |
| Editor | Yes | Yes | Yes |
| Viewer | No (read-only) | No | Yes |

Read-only access is enforced server-side on the Yjs sync protocol. Viewers receive document updates but their edit attempts are rejected.
