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
      'Replay the retained request from its original writer and turn to recover the saved result. After confirmed workspace recovery, the replacement writer can inspect and explicitly abandon that operation.\n',
    );
  if (code === 'NATIVE_ENGINE_ORIGINAL_REQUEST_REQUIRED')
    process.stderr.write(
      "This historical operation needs its original request to identify any publication. Run aidlc engine operation abandon '<exact pending JSON>' '<retained original request JSON>'.\n",
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
