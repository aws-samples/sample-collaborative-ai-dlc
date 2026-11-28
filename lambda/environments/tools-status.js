import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DescribeImagesCommand, ECRClient } from '@aws-sdk/client-ecr';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Logger } from '@aws-lambda-powertools/logger';
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
const logger = new Logger({ persistentKeys: { component: 'managed-tools' } });

// How often an unscannable tool image is checked again. ECR can scan it
// later, for example once enhanced scanning (Amazon Inspector) is turned on.
export const UNAVAILABLE_SCAN_RECHECK_MS = 15 * 60 * 1000;
// One check per poll, bounded: an enhanced scan can take up to 50 pages, and
// the poll runs every minute in a Lambda with a 300 s timeout.
export const UNAVAILABLE_SCAN_RECHECK_BUDGET_MS = 60 * 1000;
const MAX_SCAN_DESCRIPTION_LENGTH = 500;

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
    description: description ? String(description).slice(0, MAX_SCAN_DESCRIPTION_LENGTH) : null,
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

// A version left in review because ECR could not scan its image: read the
// scan again and apply the build gate to it. Only an administrator's decision
// (continue without a scan, rebuild) or this check moves the version on. The
// write is conditional on the review status and on the image, so a decision
// or a rebuild in the meantime wins.
const recheckUnavailableScan = async ({ store, version, ecrClient, now, budgetMs }) => {
  const outcome = (result, detail = {}) => {
    logger.info('Managed tool scan rechecked', {
      toolId: version.toolId,
      versionId: version.versionId,
      result,
      ...detail,
    });
    return result;
  };
  try {
    const gateScan = await readGateScan({
      ecrClient,
      repositoryName: process.env.TOOL_ECR_REPOSITORY_NAME,
      imageDigest: version.imageDigest,
      now,
      abortSignal: AbortSignal.timeout(budgetMs),
    }).catch((error) => {
      if (error?.name === 'ImageNotFoundException') return null;
      throw error;
    });
    if (gateScan === null) {
      // The image was deleted: no later scan can clear the review, and the
      // version cannot be published without it. Fail it so the next poll
      // stops checking and the version offers a rebuild.
      await store.updateVersion(
        version.toolId,
        version.versionId,
        {
          status: 'FAILED',
          failure: {
            reason: 'tool_image_not_found',
            detail: 'The tool image is no longer in the repository. Rebuild the version.',
            failedAt: new Date(now()).toISOString(),
          },
        },
        { fromStatus: 'SECURITY_REVIEW', imageDigest: version.imageDigest },
      );
      logger.warn('Managed tool image is missing; version failed', {
        toolId: version.toolId,
        versionId: version.versionId,
        imageDigest: version.imageDigest,
      });
      return 'missing';
    }
    if (gateScan.pending) return outcome('pending');
    const scanStatus = gateScan.scan.imageScanStatus?.status;
    const scanDescription = gateScan.scan.imageScanStatus?.description ?? null;
    let patch;
    if (scanStatus === 'COMPLETE' || scanStatus === 'ACTIVE') {
      patch = scanResultPatch(version, gateScan, version.imageDigest);
    } else if (scanStatus === 'SCAN_ELIGIBILITY_EXPIRED') {
      patch = scanUnavailablePatch(version, scanStatus, scanDescription, version.imageDigest);
    } else {
      // Still unsupported, or a state the next check may clear: nothing to write.
      return outcome('unchanged', { scanStatus });
    }
    await store.updateVersion(version.toolId, version.versionId, patch, {
      fromStatus: 'SECURITY_REVIEW',
      imageDigest: version.imageDigest,
    });
    return outcome(patch.status === 'READY' ? 'ready' : 'review', { scanStatus });
  } catch (error) {
    // A decision or a rebuild in the meantime: the conditional write, or the
    // store's transition check (409), refuses the old result.
    if (error?.name === 'ConditionalCheckFailedException' || error?.statusCode === 409) {
      return outcome('superseded');
    }
    // The version keeps waiting for review; the next interval tries again.
    logger.warn('Managed tool scan recheck failed', {
      toolId: version.toolId,
      versionId: version.versionId,
      error,
    });
    return 'failed';
  }
};

// The unscannable version checked longest ago, if one is due. Claiming it
// first means a failed or slow check also waits for the next interval.
// A rebuild writes a new evaluatedAt but keeps the last recheck time.
const lastScanCheck = (version) =>
  Math.max(
    Date.parse(version.scanRecheckedAt ?? '') || 0,
    Date.parse(version.scanFindings?.evaluatedAt ?? '') || 0,
  );

const recheckNextUnavailableScan = async ({ store, ecrClient, now, budgetMs }) => {
  const due = (await store.listVersionsByStatus('SECURITY_REVIEW'))
    .filter(
      (version) =>
        version.scanFindings?.status === 'UNSUPPORTED' &&
        version.imageDigest &&
        now() - lastScanCheck(version) >= UNAVAILABLE_SCAN_RECHECK_MS,
    )
    .toSorted((left, right) => lastScanCheck(left) - lastScanCheck(right));
  for (const version of due) {
    const claimed = await store.claimScanRecheck(version.toolId, version.versionId, {
      previous: version.scanRecheckedAt ?? null,
      at: new Date(now()).toISOString(),
    });
    if (claimed) {
      return [await recheckUnavailableScan({ store, version, ecrClient, now, budgetMs })];
    }
  }
  return [];
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

const poll = async ({ store, ecrClient, s3Client, now, recheckBudgetMs }) => {
  const versions = [
    ...(await store.listVersionsByStatus('BUILDING')),
    ...(await store.listVersionsByStatus('SCANNING')),
  ];
  const results = [];
  for (const version of versions) {
    results.push(await inspectToolImage({ store, version, ecrClient, s3Client }));
  }
  return {
    results,
    rechecked: await recheckNextUnavailableScan({
      store,
      ecrClient,
      now,
      budgetMs: recheckBudgetMs,
    }),
  };
};

export const createToolsStatusHandler = ({
  store = defaultStore,
  ecrClient = ecr,
  s3Client = s3,
  now = Date.now,
  recheckBudgetMs = UNAVAILABLE_SCAN_RECHECK_BUDGET_MS,
} = {}) =>
  createBuildLifecycleHandler({
    label: 'Managed tool',
    poll: () => poll({ store, ecrClient, s3Client, now, recheckBudgetMs }),
    handleBuildEvent: (event) => handleBuildEvent({ store, event, ecrClient, s3Client }),
    handleScanEvent: (event) => handleScanEvent({ store, event, ecrClient, s3Client }),
  });

export const handler = createToolsStatusHandler();
