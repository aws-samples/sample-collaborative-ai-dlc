import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  DescribeImagesCommand,
  DescribeImageScanFindingsCommand,
  ECRClient,
} from '@aws-sdk/client-ecr';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createToolStore } from './tool-store.js';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ecr = new ECRClient({});
const s3 = new S3Client({});
const defaultStore = createToolStore({ ddb });

const RETRYABLE_ECR_ERRORS = new Set([
  'ImageNotFoundException',
  'ScanNotFoundException',
  'ServerException',
  'ThrottlingException',
  'TooManyRequestsException',
]);

const streamToString = async (body) => {
  if (!body) return '';
  if (typeof body.transformToString === 'function') return body.transformToString();
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
};

const findingAttribute = (finding, key) =>
  finding.attributes?.find((attribute) => attribute.key === key)?.value ?? null;

const summarizeFindings = (scan) => {
  const order = new Map([
    ['CRITICAL', 0],
    ['HIGH', 1],
    ['MEDIUM', 2],
    ['LOW', 3],
    ['INFORMATIONAL', 4],
    ['UNDEFINED', 5],
  ]);
  return (scan.imageScanFindings?.findings ?? [])
    .map((finding) => ({
      id: finding.name ?? 'Unknown finding',
      severity: finding.severity ?? 'UNDEFINED',
      packageName: findingAttribute(finding, 'package_name'),
      packageVersion: findingAttribute(finding, 'package_version'),
      uri: finding.uri ?? null,
    }))
    .toSorted(
      (left, right) =>
        (order.get(left.severity) ?? 99) - (order.get(right.severity) ?? 99) ||
        left.id.localeCompare(right.id),
    );
};

const isUnsupportedScan = (status, description) =>
  status === 'UNSUPPORTED_IMAGE' || /UnsupportedImageError/i.test(description ?? '');

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
    const scan = await ecrClient.send(
      new DescribeImageScanFindingsCommand({
        repositoryName: process.env.TOOL_ECR_REPOSITORY_NAME,
        imageId: { imageDigest: image.imageDigest },
      }),
    );
    const scanStatus = scan.imageScanStatus?.status;
    const scanDescription = scan.imageScanStatus?.description ?? null;
    if (scanStatus === 'IN_PROGRESS' || scanStatus === 'PENDING') {
      return { version: scanning, pending: true };
    }
    if (isUnsupportedScan(scanStatus, scanDescription)) {
      const evaluatedAt = new Date().toISOString();
      return {
        version: await store.updateVersion(
          scanning.toolId,
          scanning.versionId,
          {
            status: 'SECURITY_REVIEW',
            scanFindings: {
              status: 'UNSUPPORTED',
              description: scanDescription,
              severityCounts: {},
              findings: [],
              findingsTruncated: false,
              evaluatedAt,
              imageDigest: image.imageDigest,
            },
            verification: {
              ...scanning.verification,
              securityScan: 'UNSUPPORTED',
            },
            failure: null,
          },
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
    const severityCounts = scan.imageScanFindings?.findingSeverityCounts ?? {};
    const critical = Number(severityCounts.CRITICAL ?? 0);
    const high = Number(severityCounts.HIGH ?? 0);
    const scanFindings = {
      status: scanStatus,
      severityCounts,
      findings: summarizeFindings(scan),
      findingsTruncated: Boolean(scan.nextToken),
      evaluatedAt: new Date().toISOString(),
      imageDigest: image.imageDigest,
    };
    if (critical > 0 || high > 0) {
      return {
        version: await store.updateVersion(
          scanning.toolId,
          scanning.versionId,
          { status: 'SECURITY_REVIEW', scanFindings, failure: null },
          { fromStatus: 'SCANNING' },
        ),
      };
    }
    const completedAt = new Date().toISOString();
    return {
      version: await store.updateVersion(
        scanning.toolId,
        scanning.versionId,
        {
          status: 'READY',
          scanFindings,
          verification: {
            ...scanning.verification,
            securityScan: 'PASSED',
            completedAt,
          },
          failure: null,
        },
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

export const createToolsStatusHandler =
  ({ store = defaultStore, ecrClient = ecr, s3Client = s3 } = {}) =>
  async (event) => {
    try {
      if (event?.action === 'poll') return poll({ store, ecrClient, s3Client });
      if (event?.source === 'aws.codebuild') {
        return handleBuildEvent({ store, event, ecrClient, s3Client });
      }
      if (event?.source === 'aws.ecr') {
        return handleScanEvent({ store, event, ecrClient, s3Client });
      }
      return { ignored: true };
    } catch (error) {
      console.error('Managed tool status handling failed:', error);
      throw error;
    }
  };

export const handler = createToolsStatusHandler();
