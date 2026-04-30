# Review Phase - Operations Rules

**Purpose**: The Review phase validates that constructed code meets all requirements, user stories, and quality standards.

## Review Types

### Blind Review
The blind review agent examines code changes WITHOUT access to requirements or specifications. This produces an unbiased assessment of what the code actually does, its quality, and potential issues.

**The agent must:**
- Analyze git diffs and changed files
- Describe what the code implements
- Assess code quality, architecture, and patterns
- Identify potential bugs, security issues, and performance concerns
- NOT access the sprint graph for requirements/stories/tasks

### Full Review
The full review agent cross-references the implementation against all project artifacts.

**The agent must:**
- Read the complete sprint graph (requirements, user stories, tasks)
- Compare each requirement's acceptance criteria against the implementation
- Verify each user story is properly fulfilled
- Check that all tasks were completed as specified
- Create VALIDATES and REVIEWS edges in the graph
- Provide a clear PASS/FAIL verdict with reasoning

### Code Modification
When review identifies issues, a modification agent can be launched to fix specific problems.

**The agent must:**
- Only make the requested changes
- Commit changes with descriptive messages
- Not push (system handles pushing)
- Update Neptune if task/code file records need changes

## Quality Standards

1. **Completeness**: All requirements must have corresponding implementation
2. **Correctness**: Code must function as specified in acceptance criteria
3. **Code Quality**: Follow established patterns, proper error handling, clear naming
4. **Security**: No obvious vulnerabilities, proper input validation, secure auth flows
5. **Testing**: Adequate test coverage for critical paths
6. **Documentation**: Code is self-documenting or has appropriate comments

## Graph Integration

Review agents store their findings on the Review node:
- `blind_review`: Markdown content from blind review agent
- `full_review`: Markdown content from full review agent
- `comments`: Human reviewer comments
- `status`: PENDING | PASSED | FAILED

Review edges:
- `REVIEWS`: Review -> CodeFile (what was reviewed)
- `VALIDATES`: Review -> Requirement/UserStory (what was validated)
