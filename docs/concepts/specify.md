# Specify

The Specify stage is where teams define what they want to build. It combines a collaborative Markdown editor with an LLM assistant that helps refine requirements.

## How it works

1. A user creates a spec inside a project
2. The spec opens in a real-time collaborative editor
3. Multiple users can edit simultaneously (changes sync instantly via Yjs CRDT)
4. A chat panel provides LLM assistance that understands the spec content
5. Comments can be attached to specific text selections
6. The spec can have multiple documents (files) organized in a tree

## The editor

The editor uses CodeMirror 6 and supports standard Markdown. It has two modes:

- **Edit mode** where you write Markdown directly
- **Preview mode** that renders the Markdown

Both modes support text selection for commenting. Changes are saved automatically.

## LLM assistance

The chat panel connects to an LLM (Claude via Amazon Bedrock) that has access to:

- The full spec content
- All documents attached to the spec
- The contents of any git repositories linked to the project
- Active comments and their context
- The selected methodology (if one is assigned)

The assistant can update the spec document directly through tool calls. When it does, you see the changes appear in the editor.

## Documents

A spec can contain multiple documents organized in a file tree. This is useful for large specs that cover several areas. The default document is created when the spec is first opened. You can add more documents through the file explorer.

## Comments

Comments work like a review system:

- Select any text in the editor and add a comment
- Comments support threaded replies
- Comments can be resolved when addressed
- The LLM assistant sees all active comments and can address them

## Version history

Every spec has a version history. New versions are created automatically when changes are detected. You can view previous versions to see how the spec evolved over time.

## Readiness

Before a spec moves to the Decompose stage, it goes through a readiness check that verifies:

- The spec has enough content (minimum word count)
- Key sections are present (requirements, acceptance criteria)
- An AI analysis confirms the spec is clear and complete enough for decomposition

See [Decomposing Specs](../using-the-platform/decomposing-specs.md) for details on the readiness check.
