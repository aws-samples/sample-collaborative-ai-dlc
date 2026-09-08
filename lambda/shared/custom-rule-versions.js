import { HeadObjectCommand } from '@aws-sdk/client-s3';

// Pin mutable custom-rule keys to exact S3 object versions so later replacement
// of the same key cannot change a checkpoint or an export already being built.
const pinCustomRuleVersions = async ({ s3, bucket, rules = [] }) => {
  if (rules.length === 0) return [];
  if (!bucket) throw new Error('artifacts bucket is not configured');

  return Promise.all(
    rules.map(async (rule) => {
      const s3Key = String(rule?.s3Key ?? '');
      if (!s3Key) throw new Error('custom rule has no S3 key');
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: s3Key }));
      if (!head.VersionId) {
        throw new Error(`custom rule ${s3Key} has no immutable S3 version`);
      }
      return {
        ...rule,
        filename: rule.filename ?? s3Key.split('/').at(-1),
        s3Key,
        versionId: head.VersionId,
      };
    }),
  );
};

export { pinCustomRuleVersions };
export default pinCustomRuleVersions;
