import { PutObjectCommand } from '@aws-sdk/client-s3';

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
        left.id.localeCompare(right.id),
    );
};

export const isUnsupportedScan = (status, description) =>
  status === 'UNSUPPORTED_IMAGE' || /UnsupportedImageError/i.test(description ?? '');

export const createBuildLifecycleHandler =
  ({ label, poll, handleBuildEvent, handleScanEvent }) =>
  async (event) => {
    try {
      if (event?.action === 'poll') return await poll();
      if (event?.source === 'aws.codebuild') return await handleBuildEvent(event);
      if (event?.source === 'aws.ecr') return await handleScanEvent(event);
      return { ignored: true };
    } catch (error) {
      console.error(`${label} status handling failed:`, error?.message ?? error);
      throw error;
    }
  };
