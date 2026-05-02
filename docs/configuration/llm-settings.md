# LLM Settings

AIDLC Collaborative uses Claude models via Amazon Bedrock for all LLM features: chat assistance, spec decomposition, readiness checks, and methodology-aware prompts.

## Setting up Bedrock

1. Make sure you have AWS credentials configured (see [Prerequisites](../getting-started/prerequisites.md))
2. Enable Claude model access in your AWS Bedrock console
3. Set the environment variable:

```bash
CLAUDE_CODE_USE_BEDROCK=1
```

## How the LLM is used

| Feature | What the LLM does |
|---------|-------------------|
| **Chat** | Answers questions, suggests improvements, updates spec documents |
| **Decompose** | Analyzes specs and generates implementation tasks |
| **Readiness check** | Evaluates whether a spec is complete enough for decomposition |
| **Methodology chat** | Assists with methodology editing and provides methodology-specific guidance |

## Model selection

The model is configured through the LLM settings page in the UI. Navigate to Settings and select the model and provider.

The platform uses the Vercel AI SDK (`ai` package) with the `@ai-sdk/amazon-bedrock` provider. It also supports `@ai-sdk/anthropic` for direct Anthropic API access.

!!! info "NEED IMAGE HERE"
    Screenshot of the Settings page showing the LLM configuration panel with model and provider selection.

## Agent execution

Agent execution (Stage 3) uses the **Claude CLI** directly, not the Bedrock API. The Claude CLI must be installed and configured separately on the server machine.

The CLI handles its own model selection and authentication. See the [Claude CLI documentation](https://docs.anthropic.com/en/docs/claude-code) for setup instructions.

## Changing settings at runtime

LLM settings can be changed from the Settings page in the UI without restarting the server. When you save new settings, the server invalidates its LLM client cache and creates a new client with the updated configuration.
