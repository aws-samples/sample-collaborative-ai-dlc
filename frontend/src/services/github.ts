// Re-exports from the unified git provider service for backward compatibility.
// New code should import directly from './gitProvider'.
export type { GitRepo as GitHubRepo } from './gitProvider';
export type { GitProviderStatus as GitHubStatus } from './gitProvider';
export type { GitFile as GitHubFile } from './gitProvider';
export type { GitFileContent as GitHubFileContent } from './gitProvider';
export type { GitComment as PRComment } from './gitProvider';
export { githubService } from './gitProvider';
