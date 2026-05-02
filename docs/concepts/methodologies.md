# Methodologies

Methodologies are reusable templates that standardize how specs are written and reviewed across an organization.

## What is a methodology

A methodology is a collection of files (templates, guidelines, checklists) that define how a type of spec should be structured. For example:

- A "Feature Spec" methodology might require sections for user stories, technical design, and rollback plan
- A "Bug Fix" methodology might require sections for reproduction steps, root cause, and regression tests
- An "API Design" methodology might require sections for endpoints, request/response schemas, and error codes

## How they work

1. An organization creates one or more methodologies
2. Each methodology contains files written in Markdown (templates, guides, prompts)
3. When a spec has a methodology assigned, the LLM assistant uses the methodology files as additional context
4. The assistant follows the methodology's structure and asks questions based on it

## Methodology editor

Methodologies have their own editor, separate from the spec editor. The methodology editor includes:

- A code editor for the methodology files
- A chat panel for discussing changes with the LLM
- Comments for review and feedback
- Version history with diffing between versions

!!! info "NEED IMAGE HERE"
    Screenshot of the methodology editor showing the code editor, file list, and chat panel.

## Versioning

Methodologies support versioning. When you publish a new version:

- The current files are frozen as a snapshot
- Existing specs using the methodology keep their version
- New specs get the latest version
- You can restore a previous version if needed

## Impact on the LLM

When a methodology is active, it changes how the LLM assistant behaves:

- The methodology files are injected into the system prompt
- The assistant guides the conversation based on the methodology's structure
- The assistant has tools to interact with methodology files (read, update)
- The methodology context persists across the entire chat session
