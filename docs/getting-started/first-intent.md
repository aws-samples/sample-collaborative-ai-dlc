# Your first intent

This guide walks you through creating a project and running your first intent end to end — from a one-line prompt to a pull request.

Before starting, make sure you have completed the [Setup](setup.md) steps, configured agent credentials in **Admin → Agents**, and can access your deployed application.

## Sign in

Open your deployed application URL (the CloudFront domain from your deployment). Sign in with your Cognito credentials.

## Create a project

From the dashboard, choose **Create new Project**:

1. Enter a name.
2. Choose the code host — **GitHub** or **GitLab** — and connect your account if prompted (in GitHub App mode there is nothing to connect).
3. Pick the repository that should back the project.
4. Optionally check **Enable GitHub/GitLab issue integration** to bind the repository's issue tracker in the same step.

Projects group related intents together. Each project has its own repositories, members, tracker bindings, and runtime settings — see [Projects and settings](../using-the-platform/projects.md).

## Create an intent

Inside your project, choose **New Intent**. The full-page form asks for:

- **Title** — for example, "Add user authentication". This also names the git branch (`aidlc/add-user-authentication`).
- **Prompt** — what you want built, in free-form text. If the project has a tracker bound, you can instead pick an issue from the **Import from tracker** panel; its title, body, and comments are imported for you.
- **Scope** — decides which workflow stages execute. Pick `feature` for a typical change, `bugfix` for a small fix, or a larger scope for greenfield work.
- **Base branch** (optional) — defaults to each repository's default branch; expand the section to pick a different base per repository.

A good prompt typically includes:

- **What** the feature or system does
- **Who** it is for (users, roles)
- **Constraints** or technical decisions
- **Scope** — what is in and what is out

For example:

> Build a user authentication system with email/password login and OAuth with Google. Users should be able to reset their password via email. The system should use JWT tokens and support role-based access control with admin and member roles.

## Start the intent

The intent opens as a **draft** on the workbench. Review the prompt, scope, and branch on the "Review & start" card, then start it.

The orchestrator compiles the workflow, checks out your repository, creates the intent branch, and begins walking the stages. The pipeline bar at the top shows the phases; the activity panel on the right streams the agent's output live.

## Answer questions and gates

Agents ask clarifying questions when things are ambiguous, and most stages end with a human validation gate. While the run waits, it consumes no compute — take your time.

- Answer questions directly on the workbench; structured options render as buttons.
- Add an optional **course correction** to any answer if you want to redirect the agent.
- Stage reviews show the LLM reviewer's findings; approve or request changes.

## Watch the work

- The **workbench** shows work products as they are produced — requirements, stories, designs, decisions — with per-artifact discussion threads.
- **Observability** (button in the pipeline bar) shows the execution as a diagram, graph, or list, with per-stage durations, sensor verdicts, token usage, and cost.
- **Graph** shows the traceability graph — from requirements down to units of work.

During construction, independent units of work run in parallel lanes. The fan-out is approved right on the unit-plan stage's review gate; the first lane (the walking skeleton) then pauses for your approval, and after that you choose whether the rest runs autonomously or gated per batch. At any of these gates you can request changes with feedback instead of approving — the engine revises the work and asks again.

## Review the result

When the execution succeeds, the platform opens a **pull request** (GitHub) or **merge request** (GitLab) from the intent branch onto the base branch. Review the code alongside the intent's artifacts and metrics.

Not happy with a stage's output? Open its detail view and **restart from this stage** with guidance — downstream work is redone, history is preserved.

## What's next

- [Creating intents](../using-the-platform/creating-intents.md) — the full reference for intent creation
- [Observing intents](../using-the-platform/intent-observability.md) — everything on the workbench, observability, graph, and audit pages
- [Git and tracker integration](../using-the-platform/git-integration.md) — connect trackers and understand branch/PR behavior
- [Managing workflows](../using-the-platform/workflows.md) — tailor the methodology (platform administrators)
