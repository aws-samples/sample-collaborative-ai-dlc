import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { readConfig } from './config.js';
import { createCollaborationServer } from './service.js';
import { ClusterCoordinator } from './cluster.js';

const config = readConfig();
const userPoolId = process.env.COGNITO_USER_POOL_ID;
const clientId = process.env.COGNITO_CLIENT_ID;
if (!userPoolId || !clientId) throw new Error('Cognito user pool and client ID are required');
const verifier = CognitoJwtVerifier.create({ userPoolId, tokenUse: 'id', clientId });

let cluster = null;
if (config.clusterEnabled) {
  const { AwsStore } = await import('./aws-store.js');
  // ECS supplies this endpoint inside the task. No address is obtained from a
  // browser or other untrusted request.
  const metadataUri = process.env.ECS_CONTAINER_METADATA_URI_V4;
  if (!metadataUri) throw new Error('ECS task metadata is required for clustered Yjs');
  const metadataResponse = await fetch(`${metadataUri}/task`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!metadataResponse.ok) throw new Error('Unable to read ECS task metadata');
  const metadata = await metadataResponse.json();
  const address = metadata.Containers?.flatMap((container) => container.Networks ?? []).flatMap(
    (network) => network.IPv4Addresses ?? [],
  )[0];
  if (!metadata.TaskARN || !address) throw new Error('ECS task address is missing');
  cluster = new ClusterCoordinator({
    id: metadata.TaskARN,
    address: `ws://${address}:${config.port}`,
    store: new AwsStore({
      documentsTable: process.env.YJS_DOCUMENTS_TABLE,
      membersTable: process.env.YJS_MEMBERS_TABLE,
      bucket: process.env.YJS_SNAPSHOTS_BUCKET,
    }),
  });
}

const service = createCollaborationServer({
  config,
  cluster,
  verifyJwt: (token) => verifier.verify(token),
  secret: process.env.REALTIME_DOC_SECRET,
  enforceScope: process.env.DOC_TOKEN_ENFORCE !== 'false',
});
await service.listen();
console.log(`Yjs listening on ${config.port}; clustered=${config.clusterEnabled}`);
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    // Keep the termination budget below ECS stopTimeout. A stuck AWS request
    // cannot keep an old process alive after its ownership leases expire.
    const deadline = setTimeout(() => process.exit(1), config.shutdownMs + 1000);
    deadline.unref();
    service.close().then(
      () => process.exit(0),
      (error) => {
        console.error('Yjs shutdown failed:', error.message);
        process.exit(1);
      },
    );
  });
}
