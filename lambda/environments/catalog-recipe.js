import { createHash } from 'node:crypto';
import {
  FORBIDDEN_COMMAND,
  PROTECTED_VARIABLE_NAME,
  SECRET_COMMAND,
  SECRET_NAME,
  SECRET_VALUE,
  protectedManifestLine,
  protectedRuntimeEpilogueLines,
  verificationEpilogue,
  verificationPrologue,
} from './build-guardrails.js';
import {
  generateToolVerifierScript,
  resolveToolDependencies,
  toolVersionSnapshot,
} from './tool-catalog.js';

export const CATALOG_RECIPE_SCHEMA_VERSION = 2;

const PACKAGE_PATTERN = /^[a-z0-9][a-z0-9+.-]*$/;
const VERSION_PATTERN = /^[0-9][0-9A-Za-z.+:~_-]*$/;
const VARIABLE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/i;

const issue = (path, message) => ({ path, message });
const quote = (value) => `'${String(value).replaceAll("'", "'\"'\"'")}'`;
const digestValue = (value) => String(value ?? '').replace(/^sha256:/, '');
const toolRoot = (tool) => `/opt/managed/tools/${tool.toolId}/${tool.version}`;

const mergePackages = (...collections) => {
  const packages = new Map();
  for (const collection of collections) {
    for (const pkg of collection ?? []) {
      const existing = packages.get(pkg.name);
      if (existing && existing.version !== pkg.version) {
        throw Object.assign(
          new Error(
            `Package ${pkg.name} requires conflicting versions ${existing.version} and ${pkg.version}`,
          ),
          { statusCode: 409, code: 'TOOL_PACKAGE_CONFLICT' },
        );
      }
      packages.set(pkg.name, pkg);
    }
  }
  return [...packages.values()].toSorted((left, right) => left.name.localeCompare(right.name));
};

const mergeVariables = (...collections) => {
  const variables = {};
  for (const collection of collections) {
    for (const [name, value] of Object.entries(collection ?? {})) {
      if (Object.hasOwn(variables, name) && variables[name] !== value) {
        throw Object.assign(new Error(`Variable ${name} has conflicting tool values`), {
          statusCode: 409,
          code: 'TOOL_VARIABLE_CONFLICT',
        });
      }
      variables[name] = value;
    }
  }
  return variables;
};

const validateCommonFields = (recipe) => {
  const issues = [];
  if (!Array.isArray(recipe.toolVersionIds ?? [])) {
    issues.push(issue('toolVersionIds', 'toolVersionIds must be an array'));
  } else {
    const seen = new Set();
    for (const [index, versionId] of recipe.toolVersionIds.entries()) {
      if (typeof versionId !== 'string' || !/^tv-[A-Za-z0-9-]+$/.test(versionId)) {
        issues.push(issue(`toolVersionIds.${index}`, 'tool version id is invalid'));
      } else if (seen.has(versionId)) {
        issues.push(issue(`toolVersionIds.${index}`, 'tool version id must be unique'));
      }
      seen.add(versionId);
    }
  }
  if (!Array.isArray(recipe.aptPackages ?? [])) {
    issues.push(issue('aptPackages', 'aptPackages must be an array'));
  } else {
    for (const [index, pkg] of recipe.aptPackages.entries()) {
      if (!PACKAGE_PATTERN.test(pkg?.name ?? '')) {
        issues.push(issue(`aptPackages.${index}.name`, 'package name is invalid'));
      }
      if (!VERSION_PATTERN.test(pkg?.version ?? '')) {
        issues.push(issue(`aptPackages.${index}.version`, 'package version must be exact'));
      }
    }
  }
  const variables = recipe.environmentVariables ?? {};
  if (!variables || typeof variables !== 'object' || Array.isArray(variables)) {
    issues.push(issue('environmentVariables', 'environmentVariables must be an object'));
  } else {
    for (const [name, value] of Object.entries(variables)) {
      if (!VARIABLE_PATTERN.test(name)) {
        issues.push(issue(`environmentVariables.${name}`, 'variable name is invalid'));
      }
      if (SECRET_NAME.test(name)) {
        issues.push(issue(`environmentVariables.${name}`, 'secret-like names are blocked'));
      }
      if (PROTECTED_VARIABLE_NAME.test(name)) {
        issues.push(issue(`environmentVariables.${name}`, 'runtime variables are protected'));
      }
      if (typeof value !== 'string' || value.length > 2048) {
        issues.push(issue(`environmentVariables.${name}`, 'value must be a short string'));
      } else if (SECRET_VALUE.test(value)) {
        issues.push(issue(`environmentVariables.${name}`, 'secret material is not allowed'));
      }
    }
  }
  if (!Array.isArray(recipe.buildCommands ?? [])) {
    issues.push(issue('buildCommands', 'buildCommands must be an array'));
  } else {
    if (recipe.buildCommands.length > 20) {
      issues.push(issue('buildCommands', 'at most 20 build commands are allowed'));
    }
    for (const [index, command] of recipe.buildCommands.entries()) {
      if (typeof command !== 'string' || !command.trim() || command.length > 1000) {
        issues.push(issue(`buildCommands.${index}`, 'build command must be a non-empty string'));
      } else if (/[\r\n]/.test(command)) {
        issues.push(issue(`buildCommands.${index}`, 'build commands must be single-line'));
      } else if (FORBIDDEN_COMMAND.test(command)) {
        issues.push(issue(`buildCommands.${index}`, 'build command changes protected behavior'));
      } else if (SECRET_COMMAND.test(command) || SECRET_VALUE.test(command)) {
        issues.push(issue(`buildCommands.${index}`, 'secret material is not allowed'));
      }
    }
  }
  return issues;
};

export const normalizeCatalogRecipeInput = (input = {}) => {
  const recipe = {
    schemaVersion: CATALOG_RECIPE_SCHEMA_VERSION,
    base: null,
    toolVersionIds: [...new Set((input.toolVersionIds ?? []).map((value) => String(value).trim()))],
    aptPackages: (input.aptPackages ?? []).map((pkg) => ({
      name: String(pkg.name ?? '').trim(),
      version: String(pkg.version ?? '').trim(),
    })),
    environmentVariables: Object.fromEntries(
      Object.entries(input.environmentVariables ?? {}).map(([name, value]) => [
        name.trim(),
        String(value),
      ]),
    ),
    buildCommands: (input.buildCommands ?? []).map((command) => String(command).trim()),
  };
  const issues = validateCommonFields(recipe);
  if (issues.length) {
    throw Object.assign(new Error('Invalid environment recipe'), { statusCode: 400, issues });
  }
  return recipe;
};

const assertComposition = ({ inheritedTools, selectedTools, recipe }) => {
  const tools = new Map(inheritedTools.map((tool) => [tool.toolId, tool]));
  for (const tool of selectedTools) tools.set(tool.toolId, tool);
  const executableOwners = new Map();
  for (const tool of tools.values()) {
    for (const executable of tool.executables) {
      const owner = executableOwners.get(executable.name);
      if (owner && owner !== tool.toolId) {
        throw Object.assign(
          new Error(
            `Executable ${executable.name} is provided by both ${owner} and ${tool.toolId}`,
          ),
          { statusCode: 409, code: 'TOOL_EXECUTABLE_CONFLICT' },
        );
      }
      executableOwners.set(executable.name, tool.toolId);
    }
  }
  const toolPackages = [...tools.values()].map((tool) => tool.aptPackages);
  const toolVariables = [...tools.values()].map((tool) => tool.environmentVariables);
  mergePackages(...toolPackages, recipe.aptPackages);
  mergeVariables(...toolVariables, recipe.environmentVariables);
  return [...tools.values()].toSorted((left, right) => left.toolId.localeCompare(right.toolId));
};

export const resolveCatalogEnvironmentRecipe = async ({
  input,
  baseEnvironmentId,
  baseRevision,
  toolStore,
}) => {
  if (
    baseEnvironmentId !== 'standard' &&
    baseRevision.flattenedRecipe?.schemaVersion !== CATALOG_RECIPE_SCHEMA_VERSION
  ) {
    throw Object.assign(
      new Error('Fixed-tool base environments must be recreated with catalog tools'),
      {
        statusCode: 409,
        code: 'FIXED_TOOL_BASE_REQUIRES_RECREATION',
      },
    );
  }
  const normalized = normalizeCatalogRecipeInput(input);
  const inheritedTools = baseRevision.flattenedRecipe?.resolvedTools ?? [];
  const tools = await toolStore.listTools();
  const versions = await toolStore.listAllVersions({ publishedOnly: true });
  const selectedVersions = resolveToolDependencies({
    selectedVersionIds: normalized.toolVersionIds,
    tools,
    versions,
    providedToolIds: inheritedTools.map((tool) => tool.toolId),
  });
  const toolById = new Map(tools.map((tool) => [tool.toolId, tool]));
  const selectedTools = selectedVersions.map((version) =>
    toolVersionSnapshot(version, toolById.get(version.toolId)),
  );
  const resolvedTools = assertComposition({ inheritedTools, selectedTools, recipe: normalized });
  const recipe = {
    ...normalized,
    base: {
      environmentId: baseEnvironmentId,
      revisionId: baseRevision.revisionId,
      imageUri: baseRevision.imageUri,
      imageDigest: baseRevision.imageDigest,
      imageSizeBytes: baseRevision.imageSizeBytes ?? null,
    },
    toolVersionIds: selectedTools.map((tool) => tool.versionId),
    tools: selectedTools,
  };
  const directPackages = mergePackages(
    ...selectedTools.map((tool) => tool.aptPackages),
    normalized.aptPackages,
  );
  const directVariables = mergeVariables(
    ...selectedTools.map((tool) => tool.environmentVariables),
    normalized.environmentVariables,
  );
  const flattenedRecipe = {
    ...recipe,
    resolvedTools,
    aptPackages: mergePackages(baseRevision.flattenedRecipe?.aptPackages, directPackages),
    environmentVariables: mergeVariables(
      baseRevision.flattenedRecipe?.environmentVariables,
      directVariables,
    ),
  };
  return { recipe, flattenedRecipe };
};

export const rebuildCatalogEnvironmentRecipe = ({
  sourceRecipe,
  baseEnvironmentId,
  baseRevision,
}) => {
  if (sourceRecipe.schemaVersion !== CATALOG_RECIPE_SCHEMA_VERSION) {
    throw Object.assign(new Error('Fixed-tool recipes must be recreated with catalog tools'), {
      statusCode: 409,
      code: 'FIXED_TOOL_RECIPE_REQUIRES_RECREATION',
    });
  }
  if (
    baseEnvironmentId !== 'standard' &&
    baseRevision.flattenedRecipe?.schemaVersion !== CATALOG_RECIPE_SCHEMA_VERSION
  ) {
    throw Object.assign(
      new Error('Fixed-tool base environments must be recreated with catalog tools'),
      {
        statusCode: 409,
        code: 'FIXED_TOOL_BASE_REQUIRES_RECREATION',
      },
    );
  }
  const recipe = {
    ...sourceRecipe,
    base: {
      environmentId: baseEnvironmentId,
      revisionId: baseRevision.revisionId,
      imageUri: baseRevision.imageUri,
      imageDigest: baseRevision.imageDigest,
      imageSizeBytes: baseRevision.imageSizeBytes ?? null,
    },
  };
  const inheritedTools = baseRevision.flattenedRecipe?.resolvedTools ?? [];
  const resolvedTools = assertComposition({
    inheritedTools,
    selectedTools: recipe.tools,
    recipe,
  });
  const directPackages = mergePackages(
    ...recipe.tools.map((tool) => tool.aptPackages),
    sourceRecipe.aptPackages,
  );
  const directVariables = mergeVariables(
    ...recipe.tools.map((tool) => tool.environmentVariables),
    sourceRecipe.environmentVariables,
  );
  return {
    recipe,
    flattenedRecipe: {
      ...recipe,
      resolvedTools,
      aptPackages: mergePackages(baseRevision.flattenedRecipe?.aptPackages, directPackages),
      environmentVariables: mergeVariables(
        baseRevision.flattenedRecipe?.environmentVariables,
        directVariables,
      ),
    },
  };
};

const directPackages = (recipe) =>
  mergePackages(...recipe.tools.map((tool) => tool.aptPackages), recipe.aptPackages);

const directVariables = (recipe) =>
  mergeVariables(
    ...recipe.tools.map((tool) =>
      Object.fromEntries(
        Object.entries(tool.environmentVariables).map(([name, value]) => [
          name,
          String(value).replaceAll('${TOOL_ROOT}', toolRoot(tool)),
        ]),
      ),
    ),
    recipe.environmentVariables,
  );

export const generateCatalogEnvironmentDockerfile = (recipe) => {
  if (recipe.schemaVersion !== CATALOG_RECIPE_SCHEMA_VERSION || !recipe.base) {
    throw new Error('A resolved catalog recipe with a pinned base is required');
  }
  const lines = recipe.tools.map(
    (tool, index) =>
      `FROM ${tool.imageUri}@sha256:${digestValue(tool.imageDigest)} AS managed_tool_${index}`,
  );
  lines.push(
    `FROM ${recipe.base.imageUri}@sha256:${digestValue(recipe.base.imageDigest)}`,
    'USER root',
    'COPY manifest.json checksums.json sbom.spdx.json verification.sh /opt/managed/',
    'RUN chmod 0555 /opt/managed/verification.sh',
    protectedManifestLine(),
  );
  const packages = directPackages(recipe);
  if (packages.length) {
    lines.push(
      `RUN apt-get update && apt-get install -y --no-install-recommends ${packages
        .map((pkg) => `${pkg.name}=${pkg.version}`)
        .join(' ')} && rm -rf /var/lib/apt/lists/*`,
    );
  }
  recipe.tools.forEach((tool, index) => {
    const root = toolRoot(tool);
    lines.push(`COPY --from=managed_tool_${index} /opt/tool/ ${root}/`);
    for (const executable of tool.executables) {
      lines.push(
        `RUN ln -sf ${quote(`${root}/${executable.path}`)} ${quote(
          `/usr/local/bin/${executable.name}`,
        )}`,
      );
    }
  });
  if (recipe.tools.some((tool) => (tool.verification.files ?? []).length > 0)) {
    lines.push(
      'COPY verification-fixtures/ /opt/managed/verification-fixtures/',
      'RUN chmod -R a-w /opt/managed/verification-fixtures',
    );
  }
  for (const [name, value] of Object.entries(directVariables(recipe)).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    lines.push(`ENV ${name}=${JSON.stringify(value)}`);
  }
  // Administrator-authored commands run as root. The denylist and in-image checksum are
  // guardrails; verification.sh independently diffs protected trees against the pinned base.
  // Both guardrails live in build-guardrails.js so this engine cannot drift from the other.
  for (const command of recipe.buildCommands) lines.push(`RUN ${command}`);
  lines.push(...protectedRuntimeEpilogueLines());
  return `${lines.join('\n')}\n`;
};

const encodedVerifier = (tool) =>
  Buffer.from(
    generateToolVerifierScript(
      { verification: tool.verification },
      { fixturesPath: `/opt/managed/verification-fixtures/${tool.toolId}` },
    ),
    'utf8',
  ).toString('base64');

export const generateCatalogEnvironmentVerificationScript = (recipe) => {
  const toolChecks = recipe.resolvedTools
    .map((tool) => `run_tool_check ${quote(tool.toolId)} ${quote(encodedVerifier(tool))}`)
    .join('\n');
  return `${verificationPrologue()}
docker network disconnect bridge "$container"
docker exec "$container" node --version >/dev/null
docker exec "$container" python3 --version >/dev/null
docker exec "$container" node -e 'console.log(1 + 1)' | grep -qx 2
docker exec "$container" python3 -c 'print(1 + 1)' | grep -qx 2

run_tool_check() {
  name="$1"
  encoded="$2"
  printf '%s' "$encoded" | base64 -d | docker exec -i "$container" bash -s || {
    printf '%s verification failed\\n' "$name" >&2
    return 1
  }
}

${toolChecks}
${verificationEpilogue()}`;
};

export const projectedEnvironmentImageSize = (recipe) => {
  const baseBytes = Number(recipe.base?.imageSizeBytes ?? 0);
  const toolBytes = recipe.tools.reduce(
    (total, tool) => total + Number(tool.imageSizeBytes ?? 0),
    0,
  );
  return baseBytes > 0 && recipe.tools.every((tool) => Number(tool.imageSizeBytes ?? 0) > 0)
    ? baseBytes + toolBytes
    : null;
};

export const generateCatalogEnvironmentBuildContext = ({
  environment,
  revision,
  recipe,
  flattenedRecipe,
  generatedAt = new Date().toISOString(),
}) => {
  const dockerfile = generateCatalogEnvironmentDockerfile(recipe);
  const manifest = {
    schemaVersion: CATALOG_RECIPE_SCHEMA_VERSION,
    environmentId: environment.environmentId,
    revisionId: revision.revisionId,
    generatedAt,
    runtimeCompatibilityVersion: revision.runtimeCompatibilityVersion,
    base: recipe.base,
    recipe,
    resolvedTools: flattenedRecipe.resolvedTools,
    projectedImageSizeBytes: projectedEnvironmentImageSize(recipe),
  };
  const packages = [
    ...flattenedRecipe.resolvedTools.map((tool) => ({
      SPDXID: `SPDXRef-Tool-${tool.toolId}`,
      name: tool.name,
      versionInfo: tool.version,
      downloadLocation: `${tool.imageUri}@${tool.imageDigest}`,
      filesAnalyzed: false,
    })),
    ...flattenedRecipe.aptPackages.map((pkg) => ({
      SPDXID: `SPDXRef-Apt-${pkg.name.replaceAll(/[^A-Za-z0-9.-]/g, '-')}`,
      name: pkg.name,
      versionInfo: pkg.version,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
    })),
  ];
  const sbom = {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `${environment.environmentId}-${revision.revisionId}`,
    documentNamespace: `https://managed-environments.local/${environment.environmentId}/${revision.revisionId}`,
    creationInfo: {
      created: generatedAt,
      creators: ['Tool: sample-collaborative-ai-dlc'],
    },
    packages,
  };
  const files = {
    Dockerfile: dockerfile,
    'manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'sbom.spdx.json': `${JSON.stringify(sbom, null, 2)}\n`,
    'verification.sh': generateCatalogEnvironmentVerificationScript(flattenedRecipe),
  };
  for (const tool of recipe.tools) {
    for (const fixture of tool.verification.files ?? []) {
      files[`verification-fixtures/${tool.toolId}/${fixture.path}`] = fixture.content;
    }
  }
  const checksums = Object.fromEntries(
    Object.entries(files).map(([name, body]) => [
      name,
      createHash('sha256').update(body).digest('hex'),
    ]),
  );
  files['checksums.json'] = `${JSON.stringify(checksums, null, 2)}\n`;
  const contextChecksums = {
    ...checksums,
    'checksums.json': createHash('sha256').update(files['checksums.json']).digest('hex'),
  };
  files['checksums.sha256'] = `${Object.entries(contextChecksums)
    .map(([name, checksum]) => `${checksum}  ${name}`)
    .join('\n')}\n`;
  return { files, manifest, dockerfile, checksums: contextChecksums };
};

export const isResolvedCatalogRecipe = (recipe) => {
  if (recipe?.schemaVersion !== CATALOG_RECIPE_SCHEMA_VERSION) return false;
  if (!recipe.base?.imageUri || !DIGEST_PATTERN.test(recipe.base?.imageDigest ?? '')) return false;
  if (!Array.isArray(recipe.tools) || !Array.isArray(recipe.toolVersionIds)) return false;
  return true;
};
