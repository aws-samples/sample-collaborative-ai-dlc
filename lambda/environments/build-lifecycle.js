import { DescribeImageScanFindingsCommand, ECRClient } from '@aws-sdk/client-ecr';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ persistentKeys: { component: 'environments' } });

export const RETRYABLE_ECR_ERRORS = new Set([
  'ImageNotFoundException',
  'ScanNotFoundException',
  'ServerException',
  'ThrottlingException',
  'TooManyRequestsException',
]);

export const uploadBuildContext = async ({
  files,
  prefix,
  s3Client,
  bucket = process.env.BUILD_CONTEXT_BUCKET,
}) => {
  await Promise.all(
    Object.entries(files).map(([name, body]) =>
      s3Client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: `${prefix}/${name}`,
          Body: body,
          ContentType: name.endsWith('.json') ? 'application/json' : 'text/plain',
          ServerSideEncryption: 'AES256',
        }),
      ),
    ),
  );
};

export const streamToString = async (body) => {
  if (!body) return '';
  if (typeof body.transformToString === 'function') return body.transformToString();
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
};

const findingAttribute = (finding, key) =>
  finding.attributes?.find((attribute) => attribute.key === key)?.value ?? null;

export const summarizeScanFindings = (scan) => {
  const severityOrder = new Map([
    ['CRITICAL', 0],
    ['HIGH', 1],
    ['MEDIUM', 2],
    ['LOW', 3],
    ['INFORMATIONAL', 4],
    ['UNDEFINED', 5],
  ]);
  // One vulnerability often affects several packages (openssl and libssl,
  // say): the package breaks the tie, so the order never depends on ECR's.
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
        (severityOrder.get(left.severity) ?? 99) - (severityOrder.get(right.severity) ?? 99) ||
        left.id.localeCompare(right.id) ||
        String(left.packageName ?? '').localeCompare(String(right.packageName ?? '')) ||
        String(left.packageVersion ?? '').localeCompare(String(right.packageVersion ?? '')),
    );
};

const repositoryNameFromImageUri = (imageUri) => {
  const path = String(imageUri ?? '')
    .split('/')
    .slice(1)
    .join('/');
  return path.split('@')[0].split(':')[0] || null;
};

// The client for readImageScanFindings during seeding, which every request of
// a cold start waits for: an ECR answer that does not start within
// requestTimeout must fail (twice at most) instead of holding the request
// until the API times out. The SDK only logs an exceeded requestTimeout
// unless throwOnRequestTimeout is set. The timer stops once the response
// starts; the body is one small JSON document. Tests pass a shorter
// requestTimeout and a local endpoint.
export const createScanReadClient = ({ requestTimeout = 5000, ...config } = {}) =>
  new ECRClient({
    ...config,
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 2000, requestTimeout, throwOnRequestTimeout: true },
  });

// Reads the finished ECR scan of an image in the shape revisions store, or
// null while the scan is pending or cannot run. The Standard revision reuses
// the core image instead of building one, so this is how it gets a scan.
export const readImageScanFindings = async ({
  ecrClient,
  imageUri,
  imageDigest,
  now = () => new Date().toISOString(),
}) => {
  const repositoryName = repositoryNameFromImageUri(imageUri);
  if (!repositoryName || !imageDigest) return null;
  const scan = await ecrClient.send(
    new DescribeImageScanFindingsCommand({ repositoryName, imageId: { imageDigest } }),
  );
  const status = scan.imageScanStatus?.status;
  if (status !== 'COMPLETE' && status !== 'ACTIVE') return null;
  return {
    status,
    severityCounts: scan.imageScanFindings?.findingSeverityCounts ?? {},
    findings: summarizeScanFindings(scan),
    findingsTruncated: Boolean(scan.nextToken),
    evaluatedAt: now(),
    imageDigest,
  };
};

export const isUnsupportedScan = (status, description) =>
  status === 'UNSUPPORTED_IMAGE' || /UnsupportedImageError/i.test(description ?? '');

// Enhanced scanning (Amazon Inspector) reports ACTIVE as soon as an image is
// under continuous scanning, and the findings of a finished scan reach ECR
// some time after Inspector completes it: a read in that window returns no
// findings, or only some. The scan gate judges an enhanced scan only once
// this long has passed since the scan completed. The delay is not
// documented; five minutes leaves a wide margin over the seconds observed.
export const ENHANCED_SCAN_SETTLE_MS = 5 * 60 * 1000;

// Reads an image's scan for the scan gate. `pending` means the result cannot
// be judged yet and the image stays SCANNING until a later poll.
export const readGateScan = async ({ ecrClient, repositoryName, imageDigest, now = Date.now }) => {
  const scan = await ecrClient.send(
    new DescribeImageScanFindingsCommand({ repositoryName, imageId: { imageDigest } }),
  );
  const status = scan.imageScanStatus?.status;
  if (status === 'IN_PROGRESS' || status === 'PENDING') return { scan, pending: true };
  if (status === 'ACTIVE') {
    const completedAt = new Date(
      scan.imageScanFindings?.imageScanCompletedAt ?? Number.NaN,
    ).getTime();
    if (Number.isNaN(completedAt) || now() - completedAt < ENHANCED_SCAN_SETTLE_MS) {
      return { scan, pending: true };
    }
  }
  return {
    scan,
    severityCounts: scan.imageScanFindings?.findingSeverityCounts ?? {},
    findingsTruncated: Boolean(scan.nextToken),
  };
};

export const createBuildLifecycleHandler =
  ({ label, poll, handleBuildEvent, handleScanEvent }) =>
  async (event) => {
    try {
      if (event?.action === 'poll') return await poll();
      if (event?.source === 'aws.codebuild') return await handleBuildEvent(event);
      if (event?.source === 'aws.ecr') return await handleScanEvent(event);
      return { ignored: true };
    } catch (error) {
      logger.error('status handling failed', error, { label });
      throw error;
    }
  };
