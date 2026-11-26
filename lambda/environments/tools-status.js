import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DescribeImagesCommand, ECRClient } from '@aws-sdk/client-ecr';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  RETRYABLE_ECR_ERRORS,
  createBuildLifecycleHandler,
  isUnsupportedScan,
  readGateScan,
  streamToString,
} from './build-lifecycle.js';
import { createToolStore } from './tool-store.js';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ecr = new ECRClient({});
const s3 = new S3Client({});
const defaultStore = createToolStore({ ddb });

const failVersion = async (store, version, reason, detail = null, patch = {}) =>
  store.updateVersion(
    version.toolId,
    version.versionId,
    {
      status: 'FAILED',
      failure: {
        reason,
        detail,
        failedAt: new Date().toISOString(),
      },
      ...patch,
    },
    { fromStatus: version.status },
  );

const readContextJson = async (version, name, s3Client) => {
  if (!version.contextPrefix) return null;
  try {
    const result = await s3Client.send(
      new GetObjectCommand({
        Bucket: process.env.BUILD_CONTEXT_BUCKET,
        Key: `${version.contextPrefix}/${name}`,
      }),
    );
    return JSON.parse(await streamToString(result.Body));
  } catch (error) {
    if (['NoSuchKey', 'NotFound'].includes(error?.name)) return null;
    throw error;
  }
};

const readBuildResult = (version, s3Client) =>
  readContextJson(version, 'tool-result.json', s3Client);

// ECR could not scan the image: the version waits for an administrator, who
// can continue without a scan (UNSUPPORTED) or rebuild it
// (SCAN_ELIGIBILITY_EXPIRED: ECR no longer scans an image this old).
const scanUnavailablePatch = (version, status, description, imageDigest) => ({
  status: 'SECURITY_REVIEW',
  scanFindings: {
    status,
    description,
    severityCounts: {},
    findings: [],
    findingsTruncated: false,
    evaluatedAt: new Date().toISOString(),
    imageDigest,
  },
  verification: {
    ...version.verification,
    securityScan: status,
  },
  failure: null,
});

// The gate on a scan ECR could run: Critical, High or a partial read go to
// review, anything else is ready to publish.
const scanResultPatch = (version, gateScan, imageDigest) => {
  const { severityCounts, findings, findingsTruncated, incomplete } = gateScan;
  const scanFindings = {
    status: gateScan.scan.imageScanStatus?.status,
    severityCounts,
    findings,
    findingsTruncated,
    ...(incomplete ? { incomplete: true } : {}),
    evaluatedAt: new Date().toISOString(),
    imageDigest,
  };
  if (
    Number(severityCounts.CRITICAL ?? 0) > 0 ||
    Number(severityCounts.HIGH ?? 0) > 0 ||
    incomplete
  ) {
    return { status: 'SECURITY_REVIEW', scanFindings, failure: null };
  }
  return {
    status: 'READY',
    scanFindings,
    verification: {
      ...version.verification,
      securityScan: 'PASSED',
      completedAt: scanFindings.evaluatedAt,
    },
    failure: null,
  };
};

const inspectToolImage = async ({ store, version, ecrClient = ecr, s3Client = s3 }) => {
  if (!['BUILDING', 'SCANNING'].includes(version.status)) {
    return { version, ignored: true };
  }
  try {
    const result = await readBuildResult(version, s3Client);
    if (!result) return { version, pending: true };
    const described = await ecrClient.send(
      new DescribeImagesCommand({
        repositoryName: process.env.TOOL_ECR_REPOSITORY_NAME,
        imageIds: [{ imageTag: version.imageTag }],
      }),
    );
    const image = described.imageDetails?.[0];
    if (!image?.imageDigest) return { version, pending: true };
    const maxBytes = Number(process.env.MAX_TOOL_IMAGE_MB || 1536) * 1024 * 1024;
    if (Number(image.imageSizeInBytes ?? 0) > maxBytes) {
      return {
        version: await failVersion(
          store,
          version,
          'tool_image_size_exceeded',
          `Tool artifact is ${image.imageSizeInBytes} bytes; maximum is ${maxBytes}`,
          {
            imageUri: process.env.TOOL_ECR_REPOSITORY_URI,
            imageDigest: image.imageDigest,
            imageSizeBytes: image.imageSizeInBytes ?? result.imageSizeBytes ?? null,
            source: result.source,
            verification: result.verification,
          },
        ),
      };
    }
    let scanning = version;
    if (version.status === 'BUILDING') {
      scanning = await store.updateVersion(
        version.toolId,
        version.versionId,
        {
          status: 'SCANNING',
          imageUri: process.env.TOOL_ECR_REPOSITORY_URI,
          imageDigest: image.imageDigest,
          imageSizeBytes: image.imageSizeInBytes ?? result.imageSizeBytes ?? null,
          source: result.source,
          verification: result.verification,
          failure: null,
        },
        { fromStatus: 'BUILDING' },
      );
    }
    const gateScan = await readGateScan({
      ecrClient,
      repositoryName: process.env.TOOL_ECR_REPOSITORY_NAME,
      imageDigest: image.imageDigest,
    });
    if (gateScan.pending) return { version: scanning, pending: true };
    const scanStatus = gateScan.scan.imageScanStatus?.status;
    const scanDescription = gateScan.scan.imageScanStatus?.description ?? null;
    if (isUnsupportedScan(scanStatus, scanDescription)) {
      return {
        version: await store.updateVersion(
          scanning.toolId,
          scanning.versionId,
          scanUnavailablePatch(scanning, 'UNSUPPORTED', scanDescription, image.imageDigest),
          { fromStatus: 'SCANNING' },
        ),
      };
    }
    if (scanStatus !== 'COMPLETE' && scanStatus !== 'ACTIVE') {
      return {
        version: await failVersion(
          store,
          scanning,
          'tool_image_scan_failed',
          scanDescription ?? scanStatus ?? 'unknown scan state',
        ),
      };
    }
    return {
      version: await store.updateVersion(
        scanning.toolId,
        scanning.versionId,
        scanResultPatch(scanning, gateScan, image.imageDigest),
        { fromStatus: 'SCANNING' },
      ),
    };
  } catch (error) {
    if (RETRYABLE_ECR_ERRORS.has(error?.name)) return { version, pending: true };
    if (error?.name === 'ConditionalCheckFailedException') {
      return {
        version: (await store.getVersion(version.toolId, version.versionId)) ?? version,
        ignored: true,
      };
    }
    return {
      version: await failVersion(store, version, 'tool_image_inspection_failed', error.message),
    };
  }
};

const handleBuildEvent = async ({ store, event, ecrClient, s3Client }) => {
  const buildId = event.detail?.['build-id'];
  if (!buildId) return { ignored: true };
  const lookup = await store.getLookup('BUILD', buildId);
  if (!lookup) return { ignored: true };
  const version = await store.getVersion(lookup.toolId, lookup.versionId);
  if (!version) return { ignored: true };
  const status = event.detail?.['build-status'];
  if (status === 'SUCCEEDED') {
    return inspectToolImage({ store, version, ecrClient, s3Client });
  }
  if (['FAILED', 'FAULT', 'STOPPED', 'TIMED_OUT'].includes(status)) {
    if (!['QUEUED', 'BUILDING'].includes(version.status)) return { version, ignored: true };
    const source = await readContextJson(version, 'source-result.json', s3Client);
    return {
      version: await failVersion(
        store,
        version,
        'tool_build_failed',
        status,
        source ? { source } : {},
      ),
    };
  }
  return { version, ignored: true };
};

const handleScanEvent = async ({ store, event, ecrClient, s3Client }) => {
  const imageDigest = event.detail?.['image-digest'];
  if (!imageDigest) return { ignored: true };
  const lookup = await store.getLookup('IMAGE', imageDigest);
  if (!lookup) return { ignored: true };
  const version = await store.getVersion(lookup.toolId, lookup.versionId);
  if (!version) return { ignored: true };
  return inspectToolImage({ store, version, ecrClient, s3Client });
};

const poll = async ({ store, ecrClient, s3Client }) => {
  const versions = [
    ...(await store.listVersionsByStatus('BUILDING')),
    ...(await store.listVersionsByStatus('SCANNING')),
  ];
  const results = [];
  for (const version of versions) {
    results.push(await inspectToolImage({ store, version, ecrClient, s3Client }));
  }
  return { results };
};

export const createToolsStatusHandler = ({
  store = defaultStore,
  ecrClient = ecr,
  s3Client = s3,
} = {}) =>
  createBuildLifecycleHandler({
    label: 'Managed tool',
    poll: () => poll({ store, ecrClient, s3Client }),
    handleBuildEvent: (event) => handleBuildEvent({ store, event, ecrClient, s3Client }),
    handleScanEvent: (event) => handleScanEvent({ store, event, ecrClient, s3Client }),
  });

export const handler = createToolsStatusHandler();
