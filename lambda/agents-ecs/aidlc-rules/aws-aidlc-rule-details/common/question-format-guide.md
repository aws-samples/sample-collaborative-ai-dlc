# Question Format Guide

## MANDATORY: Use `ask_question` MCP Tool for ALL Human Input

### Rule: `ask_question` is the ONLY Way to Get User Input

**CRITICAL**: You must NEVER ask questions in chat, create question files, or use `[Answer]:` tags. ALL questions to the team MUST use the `ask_question` MCP tool.

The `ask_question` tool:

- Sends structured questions with selectable options to all connected team members via WebSocket
- **BLOCKS** until someone answers (up to 10 minutes)
- Returns the answer text directly to you (showing which options were selected or custom free-text answers)
- Automatically creates a Question node in Neptune (this IS the audit trail)
- Users always have the option to provide free-text answers instead of (or in addition to) selecting predefined options

---

## How to Ask Questions

### Structured Question Format

Every question must include:

- `text`: The question text (markdown supported)
- `type`: Either `"single"` (user picks exactly one) or `"multi"` (user picks one or more)
- `options`: An array of predefined answer choices, each with a `label` and optional `description`

Users always see an "Other (free text)" option in addition to your predefined options.

### Single Question (single-select)

When you need one decision with clear alternatives:

```
Call `ask_question` with:
{
  questions: [{
    text: "What authentication method should this application use?",
    type: "single",
    options: [
      { label: "OAuth", description: "Delegated auth via Google/GitHub" },
      { label: "Username/Password", description: "Traditional credential-based login" },
      { label: "SSO", description: "Enterprise single sign-on via SAML/OIDC" },
      { label: "MFA", description: "Multi-factor authentication" }
    ]
  }]
}
```

The tool blocks. The team sees the question with radio buttons in the platform UI. Someone selects an option (or writes a custom answer). The answer is returned directly to you.

### Single Question (multi-select)

When multiple choices can apply simultaneously:

```
Call `ask_question` with:
{
  questions: [{
    text: "Which platforms should be supported?",
    type: "multi",
    options: [
      { label: "Web", description: "Browser-based responsive application" },
      { label: "iOS", description: "Native iOS mobile app" },
      { label: "Android", description: "Native Android mobile app" },
      { label: "Desktop", description: "Electron or native desktop app" }
    ]
  }]
}
```

The tool blocks. The team sees checkboxes and can select multiple options. The answer shows all selected options.

### Batched Questions (Multiple Related Questions)

When you have several related questions, batch them into a single `ask_question` call so the team can answer all at once:

```
Call `ask_question` with:
{
  questions: [
    {
      text: "What is the primary authentication method?",
      type: "single",
      options: [
        { label: "OAuth", description: "Delegated auth via Google/GitHub" },
        { label: "Username/Password" },
        { label: "SSO", description: "Enterprise single sign-on" }
      ]
    },
    {
      text: "Which platforms should be supported?",
      type: "multi",
      options: [
        { label: "Web" },
        { label: "iOS" },
        { label: "Android" }
      ]
    },
    {
      text: "Are there compliance requirements?",
      type: "multi",
      options: [
        { label: "HIPAA" },
        { label: "SOC2" },
        { label: "PCI-DSS" },
        { label: "None" }
      ]
    }
  ]
}
```

The tool blocks. The team sees all questions at once, each with its own set of options. They answer all questions and submit once. The full set of answers is returned to you.

### Follow-up / Clarification

When a previous answer was unclear, call `ask_question` again with a targeted follow-up:

```
Call `ask_question` with:
{
  questions: [{
    text: "You mentioned 'mix of OAuth and SSO' — can you clarify the split?",
    type: "single",
    options: [
      { label: "OAuth for external, SSO for internal", description: "External users use OAuth, employees use SSO" },
      { label: "SSO for external, OAuth for internal", description: "The reverse" },
      { label: "Both available for all users", description: "Users can choose either method" }
    ]
  }]
}
```

The tool blocks until clarification is received.

### Approval Gates

For intra-phase stage completion approvals:

```
Call `ask_question` with:
{
  questions: [{
    text: "Requirements analysis is complete. I identified 5 functional requirements and 3 non-functional requirements:\n- [brief summary of key requirements]\n\nDo you approve these requirements so I can continue with User Stories inside Inception?",
    type: "single",
    options: [
      { label: "Approve", description: "Continue to the User Stories stage inside Inception" },
      { label: "Request changes", description: "Describe what needs to change in the free text below" }
    ]
  }]
}
```

If the response is "Request changes" (with or without free text), treat it as a change request. Make the requested changes, then call `ask_question` again with the updated summary.

Do not use approval gates for phase-boundary transitions. Inception → Construction, Construction → Review, and Review → Completed are user-initiated UI actions. At a phase boundary, update the Sprint node (`current_stage` plus `phase_status: "ready_for_transition"`), provide a final summary, and exit without calling `ask_question`.

---

## Option Design Guidelines

### Provide 3-6 Options

- Too few options don't guide the conversation
- Too many options overwhelm the user
- Aim for 3-6 well-differentiated choices per question

### Use Clear, Concise Labels

- Labels should be 1-4 words
- Use descriptions for longer explanations
- Labels should be mutually exclusive for single-select questions

### Add Descriptions for Non-Obvious Options

- Skip descriptions when the label is self-explanatory (e.g., "Yes", "No", "Web", "iOS")
- Add descriptions when the option needs context or disambiguation

### Cover the Common Cases

- Include the most likely answers as predefined options
- Users can always use "Other (free text)" for unexpected answers
- Don't try to enumerate every possible answer — focus on the 80% case

---

## Question Quality Guidelines

### Be Specific and Clear

- Questions should be unambiguous and focused on one topic (or clearly numbered if batched)
- Provide context about WHY you're asking
- Options should cover the most likely answers

### Be Comprehensive

- Cover all necessary information before proceeding
- Consider functional requirements, non-functional requirements, user scenarios, and business context
- When in doubt, ask — it's better to ask too many questions than to make assumptions

### Be Concise

- Keep each question focused
- Don't repeat information the team already provided
- Reference previous answers when asking follow-ups

---

## Ambiguity and Contradiction Detection

**MANDATORY**: After receiving an answer, you MUST analyze it for contradictions and ambiguities before proceeding.

### Detecting Ambiguities

Look for unclear or borderline responses:

- Custom free-text answers that are vague: "depends", "maybe", "not sure", "probably"
- Undefined terms: references to concepts without clear definitions
- Incomplete answers: questions answered only with free text that lacks detail
- Answers that combine options without clear decision rules

### Detecting Contradictions

Look for logically inconsistent answers:

- Scope mismatch: "Bug fix" but "Entire codebase affected"
- Risk mismatch: "Low risk" but "Breaking changes"
- Timeline mismatch: "Quick fix" but "Multiple subsystems"
- Impact mismatch: "Single component" but "Significant architecture changes"
- Answers that conflict with previously provided information

### Resolving Ambiguities

If ANY ambiguity or contradiction is detected, call `ask_question` again with targeted follow-up:

```
Call `ask_question` with:
{
  questions: [{
    text: "I detected some ambiguity in your response that I need to clarify:\n\nYou selected 'Both A and B' — what specific criteria should determine when to use A vs B?",
    type: "single",
    options: [
      { label: "Always A first, B as fallback" },
      { label: "A for case X, B for case Y", description: "Explain the split in free text" },
      { label: "User chooses at runtime" }
    ]
  }]
}
```

### Resolution Rules

- **NEVER proceed with ambiguous answers.** Keep asking until clear.
- **NEVER make assumptions** about what the team meant. Ask for clarification.
- **Each follow-up should reference** the specific answer that was unclear.
- **Provide options** that represent likely interpretations.
- **Maximum 3 rounds** of clarification on the same topic. If still unclear after 3 rounds, summarize your best understanding and ask for explicit confirmation.

---

## When to Ask Questions

### ALWAYS Ask When:

- Requirements have ANY ambiguity or missing detail
- Multiple valid implementation approaches exist
- Business context or goals are unclear
- Non-functional requirements (performance, security, scalability) are unspecified
- User personas or workflows are not well-defined
- Approval is needed to proceed to the next stage

### Default to Asking

**When in doubt, ask the question.** The cost of asking upfront is far less than implementing the wrong solution based on assumptions. Overconfidence leads to poor outcomes.

---

## Summary

- **ALWAYS** use the `ask_question` MCP tool for all human input
- **ALWAYS** provide structured options with `type` and `options` fields
- **ALWAYS** analyze answers for ambiguities and contradictions
- **ALWAYS** ask follow-up questions when answers are unclear
- **ALWAYS** use `ask_question` for approval gates
- **NEVER** create question files or use `[Answer]:` tags
- **NEVER** ask questions in chat
- **NEVER** proceed with ambiguous answers
- **NEVER** make assumptions about unclear responses
