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

const SEVERITY_ORDER = new Map([
  ['CRITICAL', 0],
  ['HIGH', 1],
  ['MEDIUM', 2],
  ['LOW', 3],
  ['INFORMATIONAL', 4],
  ['UNTRIAGED', 5],
  ['UNDEFINED', 6],
]);

// Numbers compare as numbers (CVE-2026-6238 before CVE-2026-58055, version
// 2.9 before 2.10), and the order does not depend on the runtime's locale.
const findingCollator = new Intl.Collator('en', { numeric: true });

// Most severe first. One vulnerability often affects several packages
// (openssl and libssl, say): the package breaks the tie, so the order never
// depends on ECR's.
export const compareScanFindings = (left, right) =>
  (SEVERITY_ORDER.get(left.severity) ?? 99) - (SEVERITY_ORDER.get(right.severity) ?? 99) ||
  findingCollator.compare(left.id, right.id) ||
  findingCollator.compare(String(left.packageName ?? ''), String(right.packageName ?? '')) ||
  findingCollator.compare(String(left.packageVersion ?? ''), String(right.packageVersion ?? ''));

// Finding links come from vulnerability feeds and the UI renders them as
// links: keep only https URLs.
const httpsUrl = (value) => {
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
};

const basicFinding = (finding) => ({
  id: finding.name ?? 'Unknown finding',
  severity: finding.severity ?? 'UNDEFINED',
  packageName: findingAttribute(finding, 'package_name'),
  packageVersion: findingAttribute(finding, 'package_version'),
  uri: httpsUrl(finding.uri),
});

// One entry per affected package and version, as basic scanning reports
// them (Inspector also lists the same package once per file path).
const enhancedFindings = (finding) => {
  const details = finding.packageVulnerabilityDetails ?? {};
  const packages = details.vulnerablePackages?.length ? details.vulnerablePackages : [{}];
  const uri = httpsUrl(details.sourceUrl) ?? httpsUrl(details.referenceUrls?.[0]);
  const entries = new Map();
  for (const affected of packages) {
    const entry = {
      id: details.vulnerabilityId ?? finding.title ?? 'Unknown finding',
      severity: finding.severity ?? 'UNDEFINED',
      packageName: affected.name ?? null,
      packageVersion: affected.version ?? null,
      uri,
    };
    entries.set(`${entry.packageName}\u0000${entry.packageVersion}`, entry);
  }
  return [...entries.values()];
};

// ECR returns basic scanning findings in `findings` and enhanced scanning
// (Amazon Inspector) findings in `enhancedFindings`, each in its own shape.
export const summarizeScanFindings = (scan) =>
  [
    ...(scan.imageScanFindings?.findings ?? []).map(basicFinding),
    ...(scan.imageScanFindings?.enhancedFindings ?? []).flatMap(enhancedFindings),
  ].toSorted(compareScanFindings);

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
  budgetMs = SEEDING_SCAN_BUDGET_MS,
}) => {
  const repositoryName = repositoryNameFromImageUri(imageUri);
  if (!repositoryName || !imageDigest) return null;
  // One deadline for every page and retry: when it expires, the ECR call in
  // flight is cancelled and the pages already read are kept as incomplete.
  const abortSignal = AbortSignal.timeout(budgetMs);
  const read = (nextToken) =>
    ecrClient.send(
      new DescribeImageScanFindingsCommand({
        repositoryName,
        imageId: { imageDigest },
        ...(nextToken ? { nextToken } : {}),
      }),
      { abortSignal },
    );
  const scan = await read();
  const status = scan.imageScanStatus?.status;
  if (status !== 'COMPLETE' && status !== 'ACTIVE') return null;
  const result =
    status === 'ACTIVE'
      ? await readEnhancedScanPages({
          firstPage: scan,
          read,
          maxPages: MAX_SEEDING_SCAN_PAGES,
          keepPartialOnError: true,
        })
      : {
          severityCounts: scan.imageScanFindings?.findingSeverityCounts ?? {},
          findings: summarizeScanFindings(scan),
          findingsTruncated: Boolean(scan.nextToken),
        };
  return { status, ...result, evaluatedAt: now(), imageDigest };
};

// The seeding read runs before the first request of a cold start is served,
// so it reads fewer pages than the scan gate. A larger result, or one whose
// later page fails, is stored as incomplete, which the UI shows as partial
// counts; the scan gate instead retries a failed read on its next poll.
const MAX_SEEDING_SCAN_PAGES = 5;
// API Gateway ends a request after 29 seconds. The whole seeding read,
// retries included, gets this share of it, so that the rest of the cold start
// and the request itself still fit. Only an SDK retry backoff already started
// (under a second, or a Retry-After hint of up to 5 s) runs past it.
const SEEDING_SCAN_BUDGET_MS = 10_000;

export const isUnsupportedScan = (status, description) =>
  status === 'UNSUPPORTED_IMAGE' || /UnsupportedImageError/i.test(description ?? '');

// Enhanced scanning (Amazon Inspector) reports ACTIVE as soon as an image is
// under continuous scanning, and the findings of a finished scan reach ECR
// some time after Inspector completes it: a read in that window returns no
// findings, or only some. The scan gate judges an enhanced scan only once
// this long has passed since the scan completed. The delay is not
// documented; five minutes leaves a wide margin over the seconds observed.
export const ENHANCED_SCAN_SETTLE_MS = 5 * 60 * 1000;
const MAX_ENHANCED_SCAN_PAGES = 50;
// The gate stores at most this many findings for review, the most severe of
// every page it read, so a Critical finding on a later page is never left
// out for Low ones on the first.
export const MAX_GATE_SCAN_FINDINGS = 100;

// Reads an enhanced scan result from its first page on, up to maxPages.
// With enhanced scanning the severity counts cover only the findings of the
// returned page, and pages are not ordered by severity: add them up and keep
// the most severe findings of every page. ECR can return a token on the last
// page and an empty page after it, so a token alone does not mean that
// findings were left out. `incomplete` means the page bound cut the result,
// or, with keepPartialOnError, a later page could not be read.
const readEnhancedScanPages = async ({ firstPage, read, maxPages, keepPartialOnError = false }) => {
  const severityCounts = {};
  let findings = [];
  let page = firstPage;
  for (let pages = 1; ; pages += 1) {
    for (const [severity, count] of Object.entries(
      page.imageScanFindings?.findingSeverityCounts ?? {},
    )) {
      severityCounts[severity] = (severityCounts[severity] ?? 0) + Number(count ?? 0);
    }
    findings = [...findings, ...summarizeScanFindings(page)]
      .toSorted(compareScanFindings)
      .slice(0, MAX_GATE_SCAN_FINDINGS + 1);
    if (!page.nextToken || pages >= maxPages) break;
    try {
      page = await read(page.nextToken);
    } catch (error) {
      if (!keepPartialOnError) throw error;
      // The last page read still holds its token, so the result is incomplete.
      logger.warn('Scan findings page unavailable; keeping the pages already read', { error });
      break;
    }
  }
  const incomplete = Boolean(page.nextToken);
  return {
    severityCounts,
    findings: findings.slice(0, MAX_GATE_SCAN_FINDINGS),
    findingsTruncated: incomplete || findings.length > MAX_GATE_SCAN_FINDINGS,
    incomplete,
  };
};

// Reads an image's scan for the scan gate. `pending` means the result cannot
// be judged yet and the image stays SCANNING until a later poll. `incomplete`
// means an enhanced result was cut at the page bound: its counts are partial
// and the unread findings may include Critical or High ones, so the gate
// sends it to review. `findingsTruncated` means the stored list does not
// hold every finding.
export const readGateScan = async ({ ecrClient, repositoryName, imageDigest, now = Date.now }) => {
  const read = (nextToken) =>
    ecrClient.send(
      new DescribeImageScanFindingsCommand({
        repositoryName,
        imageId: { imageDigest },
        ...(nextToken ? { nextToken } : {}),
      }),
    );
  const scan = await read();
  const status = scan.imageScanStatus?.status;
  if (status === 'IN_PROGRESS' || status === 'PENDING') return { scan, pending: true };
  if (status !== 'ACTIVE') {
    return {
      scan,
      severityCounts: scan.imageScanFindings?.findingSeverityCounts ?? {},
      findings: summarizeScanFindings(scan),
      findingsTruncated: Boolean(scan.nextToken),
    };
  }
  const completedAt = new Date(
    scan.imageScanFindings?.imageScanCompletedAt ?? Number.NaN,
  ).getTime();
  if (Number.isNaN(completedAt) || now() - completedAt < ENHANCED_SCAN_SETTLE_MS) {
    return { scan, pending: true };
  }
  return {
    scan,
    ...(await readEnhancedScanPages({ firstPage: scan, read, maxPages: MAX_ENHANCED_SCAN_PAGES })),
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
