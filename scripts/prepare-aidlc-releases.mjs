// Publish and register the official catalogs after the seed Lambda is deployed.
// Registration does not approve a version or change an existing channel.
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AIDLC_COMPATIBILITY_PROFILES } from '../lambda/shared/aidlc-compatibility-profiles.js';
import { AIDLC_RELEASE_IMPORTER_REVISION } from '../lambda/shared/aidlc-release-importer.js';

export async function prepareSupportedReleases({ invoke, onPrepared = () => {} }) {
  const prepared = [];
  for (const profile of Object.values(AIDLC_COMPATIBILITY_PROFILES)) {
    const response = await invoke({
      prepareRelease: true,
      profile: profile.id,
      importerRevision: AIDLC_RELEASE_IMPORTER_REVISION,
    });
    if (response.FunctionError || response.StatusCode !== 200) {
      throw new Error(
        `AI-DLC ${profile.upstreamVersion} preparation failed. Check the seed Lambda logs.`,
      );
    }
    let result;
    try {
      result = JSON.parse(new TextDecoder().decode(response.Payload));
    } catch {
      throw new Error(
        `AI-DLC ${profile.upstreamVersion} preparation returned an invalid response.`,
      );
    }
    if (
      result.mode !== 'prepareRelease' ||
      result.profile !== profile.id ||
      result.releaseId !== profile.releaseId ||
      result.sourceSha !== profile.upstreamRef ||
      result.importerRevision !== AIDLC_RELEASE_IMPORTER_REVISION ||
      !['registered', 'already-registered'].includes(result.registration)
    ) {
      throw new Error(
        `AI-DLC ${profile.upstreamVersion} was not prepared by the deployed importer.`,
      );
    }
    prepared.push(result);
    onPrepared(profile);
  }
  return prepared;
}

async function main() {
  const functionName = process.env.SEED_BLOCKS_FUNCTION;
  const region = process.env.AWS_REGION;
  if (!functionName || !region)
    throw new Error('SEED_BLOCKS_FUNCTION and AWS_REGION are required.');
  const client = new LambdaClient({ region, maxAttempts: 1 });
  try {
    await prepareSupportedReleases({
      invoke: (event) =>
        client.send(
          new InvokeCommand({
            FunctionName: functionName,
            InvocationType: 'RequestResponse',
            Payload: Buffer.from(JSON.stringify(event)),
          }),
          { abortSignal: AbortSignal.timeout(330_000) },
        ),
      onPrepared: (profile) => console.log(`Prepared AI-DLC ${profile.upstreamVersion}.`),
    });
  } finally {
    client.destroy();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
