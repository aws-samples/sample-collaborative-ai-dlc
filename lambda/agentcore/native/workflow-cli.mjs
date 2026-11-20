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
  if (code === 'NATIVE_ENGINE_RESULT_SAVED')
    process.stderr.write(
      'The originating writer can recover the saved result by replaying its retained request.\n',
    );
  if (
    [
      'NATIVE_ENGINE_PENDING',
      'NATIVE_ENGINE_BUSY',
      'NATIVE_ENGINE_JOB_UNCERTAIN',
      'NATIVE_ENGINE_CANCELLED',
      'NATIVE_ENGINE_TIMEOUT',
    ].includes(code)
  )
    process.stderr.write(
      "Inspect with aidlc engine operation pending. To discard that unfinished operation, run aidlc engine operation abandon '<exact pending JSON>'.\n",
    );
  process.exitCode = 1;
}
