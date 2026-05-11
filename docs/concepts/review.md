# Review

The Review phase is where the code produced during Construction is evaluated for quality, correctness, and alignment with requirements.

## How it works

1. The Construction Agent finishes and creates a pull request
2. Two review agents are launched automatically:
    - A **Blind Review Agent** that evaluates without seeing file details
    - A **Full Review Agent** that evaluates with complete context
3. Each agent produces a review with comments, risk scores, and reasoning
4. You add manual comments and make the final decision
5. The review passes or fails

## Blind review

The Blind Review Agent evaluates the work without seeing the actual file changes. It assesses:

- Whether the requirements and acceptance criteria are logically met based on the task descriptions and summaries
- Potential risks or gaps in the approach
- Questions about coverage

This provides an unbiased first pass that catches conceptual issues before diving into code details.

## Full review

The Full Review Agent evaluates with complete context, including the code changes. It assesses:

- Code quality and correctness
- Whether acceptance criteria are actually met in the implementation
- Risk scores for different aspects of the change
- Specific comments on code sections

## Manual review

After the automated reviews, you can:

- Read both the blind and full review assessments
- Add your own comments to either review
- Ask additional questions that require answers
- Make the final pass/fail decision

## Refinement loop

If the review fails:

1. You can launch a **Modify Agent** with the review feedback
2. The agent receives the specific comments and failures
3. It makes targeted changes to address the feedback
4. The sprint stays in Review for another evaluation round

This creates an iterative improvement cycle without going back to Inception.

## Review outcome

A review can result in:

- **Passed**: The pull request is ready to merge
- **Failed**: The work needs refinement (triggers the loop above)
