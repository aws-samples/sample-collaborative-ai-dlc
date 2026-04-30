# AI-DLC Welcome Message

**Purpose**: This file contains the user-facing welcome message that should be displayed ONCE at the start of any AI-DLC workflow.

---

# Welcome to AI-DLC (AI-Driven Development Life Cycle)

I'll guide you through an adaptive software development workflow that intelligently tailors itself to your specific needs.

## What is AI-DLC?

AI-DLC is a structured yet flexible software development process that adapts to your project's needs. Think of it as having an experienced software architect who:

- **Analyzes your requirements** and asks clarifying questions when needed
- **Plans the optimal approach** based on complexity and risk
- **Skips unnecessary steps** for simple changes while providing comprehensive coverage for complex projects
- **Stores everything in the project graph** so your team has full visibility
- **Guides you through each phase** with clear checkpoints and approval gates

## The Three-Phase Lifecycle

```
                         User Request
                              |
                              v
        +=======================================+
        |     INCEPTION PHASE                   |
        |     Planning & Application Design     |
        +=======================================+
        | - Workspace Detection (ALWAYS)        |
        | - Reverse Engineering (COND)          |
        | - Requirements Analysis (ALWAYS)      |
        | - User Stories (CONDITIONAL)          |
        | - Workflow Planning (ALWAYS)          |
        | - Application Design (CONDITIONAL)    |
        | - Units Generation (CONDITIONAL)      |
        +=======================================+
                              |
                              v
        +=======================================+
        |     CONSTRUCTION PHASE                |
        |     Design, Implementation & Test     |
        +=======================================+
        | - Per-Unit Loop (for each unit):      |
        |   - Functional Design (COND)          |
        |   - NFR Requirements Assess (COND)    |
        |   - NFR Design (COND)                 |
        |   - Infrastructure Design (COND)      |
        |   - Code Generation (ALWAYS)          |
        | - Build and Test (ALWAYS)             |
        +=======================================+
                              |
                              v
        +=======================================+
        |     OPERATIONS PHASE                  |
        |     Placeholder for Future            |
        +=======================================+
        | - Operations (PLACEHOLDER)            |
        +=======================================+
                              |
                              v
                          Complete
```

### Phase Breakdown:

**INCEPTION PHASE** - *Planning & Application Design*
- **Purpose**: Determines WHAT to build and WHY
- **Activities**: Understanding requirements, analyzing existing code (if any), planning the approach
- **Output**: Requirements, user stories, tasks — all stored in the project graph
- **Your Role**: Answer questions when the agent asks, review and approve each stage

**CONSTRUCTION PHASE** - *Detailed Design, Implementation & Test*
- **Purpose**: Determines HOW to build it
- **Activities**: Detailed design (when needed), code generation, comprehensive testing
- **Output**: Working code on the filesystem, code files registered in the graph
- **Your Role**: Review designs, approve implementation plans, validate results

**OPERATIONS PHASE** - *Deployment & Monitoring (Future)*
- **Purpose**: How to DEPLOY and RUN it
- **Status**: Placeholder for future deployment and monitoring workflows

## How Collaboration Works:

- The agent will **ask you questions** through the platform — you'll see them appear in the Sprint page
- **Answer in the UI** and the agent will receive your response and continue working
- At each major checkpoint, the agent will **ask for your approval** before proceeding
- **All artifacts** (requirements, stories, tasks) are stored in the graph — view them anytime in the Sprint page
- **All questions and answers** are automatically tracked for a complete audit trail

## What Happens Next:

1. **The agent analyzes your workspace** to understand if this is a new or existing project
2. **It gathers requirements** and asks clarifying questions via the platform
3. **It creates an execution plan** showing which stages to run and why
4. **You review and approve** the plan (or request changes)
5. **The agent executes the plan** with approval checkpoints at each major stage
6. **You get working code** with all artifacts tracked in the project graph

The AI-DLC process adapts to:
- Your intent clarity and complexity
- Existing codebase state
- Scope and impact of changes
- Risk and quality requirements

Let's begin!
