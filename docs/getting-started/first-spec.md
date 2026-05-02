# Your first spec

This guide walks you through creating a spec from scratch and using the LLM assistant to refine it.

Before starting, make sure you have completed the [Setup](setup.md) steps and can access your deployed application.

## Sign in

Open your deployed application URL (the CloudFront domain from your deployment). Sign in with your Cognito credentials.

## Create an organization

On the home page, choose **New Organization**. Enter a name (for example, "My Team") and a URL slug (for example, "my-team"). Choose **Create**.

Organizations are the top-level container. Each organization has its own projects, members, and settings.

## Create a project

Inside your organization, choose **New Project**. Enter a name and slug. Choose **Create**.

Projects group related specs together. Each project can have its own git repositories, members, and methodology.

## Create a spec

Inside your project, choose **New Spec**. Enter a title (for example, "User Authentication") and choose **Create**.

This opens the spec editor with three panels:

- **Left panel**: file explorer showing all documents in this spec
- **Center panel**: the Markdown editor (collaborative, real-time)
- **Right panel**: chat, comments, or other tools

## Write your spec

Start writing in the editor. The default document is a Markdown file where you describe what you want to build.

A good spec typically includes:

- **Overview** of what the feature does
- **Requirements** listed clearly
- **Technical constraints** or decisions
- **Acceptance criteria** for each requirement

## Use the LLM assistant

Open the chat panel on the right side. Type a message like:

> Help me flesh out the requirements for this authentication feature. I want email/password login and OAuth with Google.

The assistant reads your spec content and responds with suggestions. It can:

- Ask clarifying questions
- Suggest missing requirements
- Propose technical approaches
- Update the spec document directly using tools

When the assistant updates the document, the changes appear in the editor in real time.

## Attach a methodology (optional)

If your organization has methodology templates, you can select one from the dropdown above the chat panel. The methodology guides the LLM to ask the right questions and structure the spec according to your team's standards.

## What's next

Once your spec is complete, you can:

- [Decompose it into tasks](../using-the-platform/decomposing-specs.md)
- [Invite collaborators](../using-the-platform/real-time-collaboration.md) to edit together
- [Connect a GitHub repo](../using-the-platform/git-integration.md) to push tasks as issues
