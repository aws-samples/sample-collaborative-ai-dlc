import { ApiError } from '@/services/api';

// A fork of the default workflow can name every block, so the message lists a
// few and counts the rest.
const MAX_LISTED_BLOCKS = 5;

const BLOCK_TYPE_LABELS: Record<string, string> = {
  STAGE: 'stage',
  AGENT: 'agent',
  SENSOR: 'sensor',
  RULE: 'rule',
  KNOWLEDGE: 'knowledge',
};

// `incompatibleBlocks` entries are `<TYPE>:<blockId>`.
const blockLabel = (entry: string) => {
  const separator = entry.indexOf(':');
  if (separator < 0) return entry;
  const type = entry.slice(0, separator);
  const id = entry.slice(separator + 1);
  return `${BLOCK_TYPE_LABELS[type] ?? type.toLowerCase()} ${id}`;
};

const editedBlocksMessage = (blocks: unknown) => {
  const labels = (Array.isArray(blocks) ? blocks : [])
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    .map(blockLabel);
  const listed = labels.slice(0, MAX_LISTED_BLOCKS).join(', ');
  const more = labels.length - MAX_LISTED_BLOCKS;
  const list = labels.length ? `: ${listed}${more > 0 ? ` and ${more} more` : ''}` : '';
  return (
    `This workspace can't be downloaded because the workflow uses edited methodology blocks${list}. ` +
    'To download it, start a new intent on a workflow without edited blocks, or ship the changes as a custom fork release of AI-DLC.'
  );
};

/**
 * The message shown when "Download workspace" fails: the server's reason, what
 * it applies to and, when there is one, what the person can do instead.
 * Refusals without a known `code` keep the server's message.
 */
export const nativeExportErrorMessage = (error: unknown) => {
  const message = error instanceof Error ? error.message : 'Failed to export workflow';
  if (!(error instanceof ApiError)) return message;
  const body = error.body ?? {};
  switch (body.code) {
    case 'export_edited_blocks':
      return editedBlocksMessage(body.incompatibleBlocks);
    case 'export_checkpoint_unavailable':
      return `${message}. Try again after the current stage completes.`;
    case 'export_snapshot_incompatible':
      return typeof body.detail === 'string' && body.detail
        ? `${message}. Details: ${body.detail.replace(/^native-export:\s*/, '')}`
        : message;
    default:
      return message;
  }
};
