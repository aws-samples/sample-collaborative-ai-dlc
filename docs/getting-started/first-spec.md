# Your first sprint

This guide walks you through creating your first sprint and running the Inception phase.

Before starting, make sure you have completed the [Setup](setup.md) steps and can access your deployed application.

## Sign in

Open your deployed application URL (the CloudFront domain from your deployment). Sign in with your Cognito credentials.

## Create an organization

On the home page, choose **New Organization**. Enter a name (for example, "My Team") and a URL slug (for example, "my-team"). Choose **Create**.

Organizations are the top-level container. Each organization has its own projects, members, and settings.

## Create a project

Inside your organization, choose **New Project**. Enter a name and slug. Choose **Create**.

Projects group related sprints together. Each project can have its own git repositories, members, and methodology.

## Create a sprint

Inside your project, choose **New Sprint**. Enter a name (for example, "User Authentication") and choose **Create**.

This opens the Inception page where you describe what you want to build.

## Write your project description

In the description area, write what you want to build in free-form text. This is the input for the Inception Agent.

A good description typically includes:

- **What** the feature or system does
- **Who** it is for (users, roles)
- **Constraints** or technical decisions
- **Scope** — what is in and what is out

For example:

> Build a user authentication system with email/password login and OAuth with Google. Users should be able to reset their password via email. The system should use JWT tokens and support role-based access control with admin and member roles.

## Launch the Inception Agent

Choose **Launch Agent** to start the Inception phase. The agent:

1. Analyzes your description
2. Asks clarifying questions when things are ambiguous
3. Generates requirements, user stories, and tasks

Answer the agent's questions as they appear — they help remove ambiguity and produce better artifacts.

## Review the generated artifacts

Once Inception completes, you see structured artifacts:

- **Requirements** with acceptance criteria
- **User stories** with story points
- **Tasks** ready for construction

All artifacts are editable in real time. Refine them collaboratively with your team before moving to Construction.

## What's next

Once your artifacts are ready, you can:

- [Launch Construction](../using-the-platform/running-agents.md) to start building
- [Invite collaborators](../using-the-platform/real-time-collaboration.md) to refine artifacts together
- [Connect a GitHub repo](../using-the-platform/git-integration.md) to push tasks as issues
