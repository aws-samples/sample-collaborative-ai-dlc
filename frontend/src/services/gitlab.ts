// Re-exports from the unified git provider service for backward compatibility.
// New code should import directly from './gitProvider'.
export type { GitRepo as GitLabRepo } from './gitProvider';
export type { GitProviderStatus as GitLabStatus } from './gitProvider';
export type { GitFile as GitLabFile } from './gitProvider';
export type { GitFileContent as GitLabFileContent } from './gitProvider';
export type { GitComment as MRComment } from './gitProvider';
export { gitlabService } from './gitProvider';
