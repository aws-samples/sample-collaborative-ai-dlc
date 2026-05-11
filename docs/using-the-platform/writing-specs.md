# Writing Specs

The spec editor is the main workspace for defining what you want to build. It combines a Markdown editor, an LLM chat assistant, and collaboration tools.

## The editor layout

The spec editor has three panels:

- **Left** -- File explorer showing all documents in the spec
- **Center** -- The Markdown editor
- **Right** -- Contextual panel (chat, comments, version history)

## Writing in Markdown

The editor supports standard Markdown with GitHub-flavored extensions (tables, task lists, fenced code blocks) with syntax highlighting.

Changes are saved automatically. There is no save button.

## Using the LLM assistant

Open the chat panel on the right side. The assistant can:

- **Answer questions** about the spec, the codebase, or technical topics
- **Suggest improvements** based on what you have written so far
- **Update the document** directly by writing to the editor
- **Read linked repositories** to understand the existing codebase

### Tips for good prompts

- Be specific about what you want: "Add a section about error handling for the login endpoint"
- Reference the spec content: "The requirements in section 3 are too vague, make them testable"
- Ask for structure: "Reorganize this spec to follow our API Design methodology"

### Methodology-aware chat

If the spec has a methodology assigned, the assistant uses it as context. It will guide the conversation based on the methodology's templates and ask questions that help fill in required sections.

You can change the methodology from the dropdown above the chat panel. Changing it resets the chat history because the system prompt changes.

## Comments

### Adding a comment

1. Select text in the editor
2. Choose the comment button (or use the right panel)
3. Type your comment and submit

### Replying and resolving

- Choose a comment to expand it and see replies
- Add replies in the thread
- Choose **Resolve** when the comment has been addressed

### Comments and the LLM

The assistant sees all active comments. You can ask it to address specific comments:

> Look at the open comments and update the spec to address them.

## Documents

A spec can have multiple documents. Use the file explorer on the left to:

- Create new documents
- Switch between documents
- See the document tree

Each document has its own collaboration room, so multiple users can edit different documents simultaneously.

## Version history

Open the version history from the right panel to see previous snapshots of the spec. Versions are created automatically when meaningful changes are detected.
