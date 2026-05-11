# Running Inception

The Inception phase turns a project description into structured requirements, user stories, and tasks. It is the first phase of the [AI-DLC methodology](https://github.com/awslabs/aidlc-workflows) lifecycle.

## Starting Inception

Navigate to your sprint and write a project description:

- For a **greenfield project** (new, from scratch): describe the system, its goals, constraints, and scope
- For a **brownfield project** (existing codebase): describe the feature, issue, or change you want to make

Choose **Launch Agent** to start the Inception Agent.

Before the agent runs, the system performs a readiness check on your description.

## Readiness check

The readiness check has two parts:

### Structural checks

These are fast, deterministic checks:

- Minimum content length
- Required information present
- Enough detail for the agent to work with

### AI analysis

If structural checks pass, the LLM reviews the description for:

- Clarity and completeness
- Ambiguous requirements
- Missing technical details
- Feasibility

You see the results in real time as the AI streams its analysis. If the check fails, you get specific feedback about what to improve.

### Bypassing readiness

If you believe the description is ready despite failing the readiness check, you can choose to proceed anyway.

## Generated artifacts

After Inception completes, you see:

- **Requirements** with titles, descriptions, and acceptance criteria
- **User stories** with descriptions and story points
- **Tasks** mapped to concrete implementation work

All artifacts are editable. You can refine them before moving to Construction.

## Questions

During Inception, the agent may ask clarifying questions. These appear in the UI as structured prompts with suggested answers. Answer them to help the agent produce better artifacts.

## Moving to Construction

Once you are satisfied with the generated artifacts, select a git branch and base branch, then launch the Construction Agent. The sprint transitions to the Construction phase.
