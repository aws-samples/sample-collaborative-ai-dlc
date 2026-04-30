const { DynamoDBClient, GetItemCommand, QueryCommand } = require('@aws-sdk/client-dynamodb');

const ddb = new DynamoDBClient();

exports.handler = async (event) => {
  const { executionId, agentType, sprintId } = event;

  // If executionId + agentType provided, fetch specific output
  if (executionId && agentType) {
    const result = await ddb.send(new GetItemCommand({
      TableName: process.env.AGENT_OUTPUTS_TABLE,
      Key: {
        executionId: { S: executionId },
        agentType: { S: agentType },
      },
    }));

    if (!result.Item) {
      return { tasks: [], outputText: '' };
    }

    // Return both the structured output (if any) and the raw output text
    const response = {
      status: result.Item.status?.S || 'unknown',
      outputText: result.Item.outputText?.S || '',
      completedAt: result.Item.completedAt?.S || '',
    };

    // Try to parse structured output if present
    if (result.Item.output?.S) {
      try {
        const parsed = JSON.parse(result.Item.output.S);
        return { ...response, ...parsed };
      } catch {
        // Structured output not parseable, that's fine
      }
    }

    return response;
  }

  // If sprintId provided, fetch the latest agent output for that sprint
  if (sprintId) {
    // Query by sprintId using a GSI (if available) or scan with filter
    // For now, return empty -- the frontend should use executionId when possible
    return { tasks: [], outputText: '' };
  }

  return { tasks: [], outputText: '' };
};
