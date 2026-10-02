// A persistent process using the native SDK provider, like a long-running CLI.
import { BedrockClient, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock';
import { fromHttp } from '@aws-sdk/credential-providers';
let time = Date.now();
Date.now = () => time;
let authorization;
const client = new BedrockClient({
  region: process.env.AWS_REGION,
  credentials: fromHttp(),
  requestHandler: {
    handle: async (request) => {
      authorization = request.headers.authorization;
      return {
        response: {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from('{"inferenceProfileSummaries":[]}'),
        },
      };
    },
  },
});
process.on('message', async (message) => {
  time = message.time;
  try {
    await client.send(new ListInferenceProfilesCommand({}));
    process.send({ authorization, pid: process.pid, region: process.env.AWS_REGION });
  } catch (error) {
    process.send({ error: error.name });
  }
});
process.on('disconnect', () => {
  client.destroy();
  process.exit(0);
});
