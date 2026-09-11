import { defineConfig } from 'vitest/config';
import { backendGlobalSetup, backendProjects } from './vitest.config.js';

const scope = process.env.STRYKER_SCOPE;
if (!scope) {
  throw new Error('STRYKER_SCOPE is required; run mutation tests through the npm scripts');
}

const selectedProjects =
  scope === 'untested'
    ? backendProjects
    : backendProjects.filter((project) => project.name === scope);

if (selectedProjects.length === 0) {
  throw new Error(`No Vitest project found for mutation scope "${scope}"`);
}

export default defineConfig({
  test: {
    projects: selectedProjects.map((project) => project.config),
    globalSetup: selectedProjects.some((project) => project.requiresInfrastructure)
      ? backendGlobalSetup
      : undefined,
  },
});
