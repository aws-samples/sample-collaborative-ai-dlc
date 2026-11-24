// The ECR console page of one image, where its complete scan findings are
// listed. Null when the image URI is not a private ECR repository URI.
export const ecrImageConsoleUrl = (imageUri?: string | null, imageDigest?: string | null) => {
  const match = imageUri?.match(
    /^(?<account>\d{12})\.dkr\.ecr\.(?<region>[a-z0-9-]+)\.amazonaws\.com\/(?<repository>[^:@]+)/,
  );
  if (!match?.groups || !imageDigest) return null;
  const { account, region, repository } = match.groups;
  return `https://${region}.console.aws.amazon.com/ecr/repositories/private/${account}/${repository}/_/image/${encodeURIComponent(imageDigest)}/details?region=${region}`;
};

// What the evidence says about the scan results it lists. An incomplete scan
// stopped at the platform's read bound, so its counts are partial.
export const scanFindingsNote = (
  scanFindings?: { incomplete?: boolean; findingsTruncated?: boolean; findings?: unknown[] } | null,
) => {
  if (scanFindings?.incomplete) {
    return 'The scan has more findings than the platform reads, so these counts are partial and the unread findings may include Critical or High vulnerabilities. Review the complete findings in ECR before accepting them.';
  }
  if (scanFindings?.findingsTruncated && scanFindings.findings?.length) {
    return `Showing the ${scanFindings.findings.length} most severe findings. The complete list is in ECR.`;
  }
  return null;
};
