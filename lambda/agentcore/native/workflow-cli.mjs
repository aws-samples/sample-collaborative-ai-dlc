import { createNativeEngineClient, nativeEngineContext } from './workflow-client.js';
import { relocateNativeEngineArguments } from '../../shared/native-workflow-protocol.js';
try {
  const context = await nativeEngineContext(process.env.NATIVE_WORKFLOW_CONTEXT);
  const args = relocateNativeEngineArguments(
    process.argv.slice(2),
    context.project,
    '/tmp/native-workflow-engine/project',
  );
  const result = await createNativeEngineClient({
    context,
    forbiddenBytes: [process.env.AWS_BEARER_TOKEN_BEDROCK, process.env.KIRO_API_KEY].filter(
      Boolean,
    ),
  }).command(args);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
} catch (error) {
  const code = /^NATIVE_[A-Z0-9_]+$/.test(error?.code ?? '')
    ? error.code
    : 'NATIVE_ENGINE_UNAVAILABLE';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
