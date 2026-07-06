# Discussions

A chat-like discussion thread can be attached to any intent- or sprint-scoped
entity — an agent question, an intent artifact, a requirement, a user story, a
task, the review, a general-info item, the inception prompt, or the intent or
sprint itself. Team members chat in real time, and every message is durably
stored as a vertex in the scope's graph.

Sprint-scoped (v1) threads are now **read-only**: existing discussions stay
viewable, but posting, resolving, and redaction are available only on
intent-scoped (v2) threads.

## Opening a thread

Look for the speech-bubble icon:

- on agent question cards (pending and answered),
- in the actions row of requirement / user story / task / general-info cards,
- on the inception "Project Description" card and the review card,
- in the **Discuss** tab of the activity panel, which lists every thread of
  the sprint with unread counts and a search box.

Threads are created lazily — one thread per entity. The first person to open
the discussion creates it; everyone after that joins the same thread.

Threads open **non-modally** in the activity panel's Discuss tab on the right,
so the rest of the app stays fully usable while a discussion is open. The back
arrow in the thread header returns to the thread list.

## Messages

- Markdown is supported (no raw HTML).
- `@` opens a mention picker over the project members. Mentioned users who are
  **currently online** get an in-app notification with a jump-to-thread link.
  Offline users see the unread badge on their next visit — there is no email
  or push delivery in v1.
- Messages are persisted first, then delivered: even if your tab crashes right
  after sending, the message reaches everyone.
- Unread badges only clear when you have actually **seen** the newest message
  (the thread is scrolled to the bottom in a visible tab) — merely opening the
  thread does not mark anything read. The thread opens at a "New" divider
  marking your first unread message.

## Resolving a thread

Any project member can resolve a thread (the action is fully audited — the
resolver's name is shown in the thread header). When resolving you can record
a **resolution summary** — the durable "what did we decide" — and optionally
mark one message as the accepted outcome.

Resolved threads can be reopened by any member.

## Moderation (redaction)

Project **admins and owners** can redact any message from the message context
menu. Redaction **replaces** the content with `[redacted by {name}]` — the
original text is purged from the database while the audit trail (who redacted,
when) is preserved.

Known limitation: copies of the original text may persist in the memory of
clients that already rendered it.

## Roles at a glance

| Action                                  | Member | Admin / Owner |
| --------------------------------------- | ------ | ------------- |
| View threads & messages, search         | ✓      | ✓             |
| Post messages, mention, typing/presence | ✓      | ✓             |
| Resolve / reopen (audited)              | ✓      | ✓             |
| Redact a message                        | ✗      | ✓             |

Non-members get a 403 on everything, including realtime access.

## Design notes

- **One thread per entity** (v1): busy entities may mix decision and
  implementation topics in one thread. The data model is ready for multiple
  titled threads without migration when the need materializes.
- Messages live in the sprint graph (`Discussion` / `DiscussionMessage`
  vertices), so discussions are queryable collaboration context for both
  humans and agents — not throwaway chat history. Deleting a sprint deletes
  its discussions.
- Search is sprint-scoped substring search (minimum 3 characters); full-text
  search is a named follow-up.
