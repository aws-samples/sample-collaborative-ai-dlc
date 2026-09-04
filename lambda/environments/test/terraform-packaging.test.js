import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const terraformPath = new URL(
  '../../../terraform/modules/compute/managed-environments/main.tf',
  import.meta.url,
);

describe('managed environment Lambda packaging', () => {
  it('isolates build outputs and archives for every Lambda', async () => {
    const terraform = await readFile(terraformPath, 'utf8');
    const expectedPackages = [
      'environment-control',
      'environment-status',
      'tool-control',
      'tool-status',
    ];

    const artifactDirectories = [
      ...terraform.matchAll(/artifacts_dir\s*=\s*"builds\/managed-environments\/([^"]+)"/g),
    ].map((match) => match[1]);
    const buildOutputs = [
      ...terraform.matchAll(
        /--outdir=\.\.\/\.\.\/terraform\/builds\/managed-environments\/([^/]+)\/source/g,
      ),
    ].map((match) => match[1]);
    const archiveSources = [
      ...terraform.matchAll(/:zip terraform\/builds\/managed-environments\/([^/]+)\/source/g),
    ].map((match) => match[1]);

    expect(artifactDirectories).toEqual(expectedPackages);
    expect(buildOutputs).toEqual(expectedPackages);
    expect(archiveSources).toEqual(expectedPackages);
    expect(new Set(artifactDirectories).size).toBe(expectedPackages.length);
    expect(new Set(buildOutputs).size).toBe(expectedPackages.length);
  });

  it('allows tool recommendations to condition-check published versions', async () => {
    const terraform = await readFile(terraformPath, 'utf8');
    const toolControlPolicy = terraform.match(
      /resource "aws_iam_role_policy" "tool_control" \{([\s\S]*?)^\}/m,
    )?.[1];

    expect(toolControlPolicy).toContain('"dynamodb:ConditionCheckItem"');
  });
});
