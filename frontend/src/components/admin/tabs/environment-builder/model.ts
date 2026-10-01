import type {
  CatalogEnvironmentRecipe,
  EnvironmentRecipeInput,
  EnvironmentRevision,
  EnvironmentToolSnapshot,
  ManagedEnvironment,
} from '@/services/environments';

export const RUNTIME_IMAGE_LIMIT_BYTES = 2048 * 1024 * 1024;

export interface KeyValueEntry {
  name: string;
  value: string;
}

export interface EnvironmentForm {
  environmentId: string;
  name: string;
  description: string;
  baseEnvironmentId: string;
  toolVersionIds: string[];
  aptPackages: KeyValueEntry[];
  environmentVariables: KeyValueEntry[];
  buildCommands: string[];
}

export const emptyEnvironmentForm = (): EnvironmentForm => ({
  environmentId: '',
  name: '',
  description: '',
  baseEnvironmentId: 'standard',
  toolVersionIds: [],
  aptPackages: [],
  environmentVariables: [],
  buildCommands: [],
});

export const isCatalogRecipe = (
  recipe: EnvironmentRevision['recipe'] | undefined,
): recipe is CatalogEnvironmentRecipe => recipe?.schemaVersion === 2;

export const resolvedTools = (revision: EnvironmentRevision | null): EnvironmentToolSnapshot[] => {
  const recipe = revision?.flattenedRecipe;
  if (!isCatalogRecipe(recipe)) return [];
  return recipe.resolvedTools ?? recipe.tools;
};

export const directToolVersionIds = (revision: EnvironmentRevision | null) =>
  isCatalogRecipe(revision?.recipe) ? revision.recipe.toolVersionIds : [];

export const protectedRuntimeVersions = (revision: EnvironmentRevision | null) => {
  const recipe = revision?.flattenedRecipe;
  if (!recipe || recipe.schemaVersion !== 1) return { node: null, python: null };
  return {
    node: recipe.tools.node?.version ?? null,
    python: recipe.tools.python?.version ?? null,
  };
};

export const formFromRevision = (
  environment: ManagedEnvironment,
  revision: EnvironmentRevision | null,
): EnvironmentForm => {
  const recipe = revision?.recipe;
  return {
    environmentId: environment.environmentId,
    name: environment.name,
    description: environment.description ?? '',
    baseEnvironmentId:
      environment.environmentId === 'standard'
        ? ''
        : (recipe?.base?.environmentId ?? environment.baseEnvironmentId ?? 'standard'),
    toolVersionIds: directToolVersionIds(revision),
    aptPackages: (recipe?.aptPackages ?? []).map((pkg) => ({
      name: pkg.name,
      value: pkg.version,
    })),
    environmentVariables: Object.entries(recipe?.environmentVariables ?? {}).map(
      ([name, value]) => ({ name, value }),
    ),
    buildCommands: [...(recipe?.buildCommands ?? [])],
  };
};

export const recipeFromForm = (form: EnvironmentForm): EnvironmentRecipeInput => ({
  schemaVersion: 2,
  toolVersionIds: form.toolVersionIds,
  aptPackages: form.aptPackages
    .filter((entry) => entry.name.trim() || entry.value.trim())
    .map((entry) => ({ name: entry.name.trim(), version: entry.value.trim() })),
  environmentVariables: Object.fromEntries(
    form.environmentVariables
      .filter((entry) => entry.name.trim() || entry.value)
      .map((entry) => [entry.name.trim(), entry.value]),
  ),
  buildCommands: form.buildCommands.map((command) => command.trim()).filter(Boolean),
});

const PACKAGE_PATTERN = /^[a-z0-9][a-z0-9+.-]*$/;
const VERSION_PATTERN = /^[0-9][0-9A-Za-z.+:~_-]*$/;
const VARIABLE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const ENVIRONMENT_ID_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;

export const validateEnvironmentForm = (
  form: EnvironmentForm,
  projectedSize: number | null,
): string[] => {
  const issues: string[] = [];
  if (!form.name.trim()) issues.push('Give the environment a name.');
  const requestedId = form.environmentId.trim() || form.name.trim();
  const normalizedId = requestedId ? environmentIdPreview(requestedId) : '';
  if (form.environmentId.trim() && !/[a-z0-9]/i.test(form.environmentId)) {
    issues.push('The environment ID must contain at least one letter or digit.');
  } else if (requestedId && !ENVIRONMENT_ID_PATTERN.test(normalizedId)) {
    issues.push('The environment ID must start with a letter and contain 2–63 characters.');
  }
  if (normalizedId === 'rebuild') {
    issues.push('The environment ID "rebuild" is reserved by the platform.');
  }
  if (!form.baseEnvironmentId) issues.push('Choose a published base environment.');
  if (projectedSize !== null && projectedSize > RUNTIME_IMAGE_LIMIT_BYTES) {
    issues.push('The projected image is larger than the 2048 MiB runtime limit.');
  }

  for (const [index, entry] of form.aptPackages.entries()) {
    if (!entry.name.trim() && !entry.value.trim()) continue;
    if (!PACKAGE_PATTERN.test(entry.name.trim())) {
      issues.push(`Package ${index + 1} needs a valid Debian package name.`);
    }
    if (!VERSION_PATTERN.test(entry.value.trim())) {
      issues.push(`Package ${index + 1} needs an exact version.`);
    }
  }

  const variableNames = new Set<string>();
  for (const [index, entry] of form.environmentVariables.entries()) {
    if (!entry.name.trim() && !entry.value) continue;
    const name = entry.name.trim();
    if (!VARIABLE_PATTERN.test(name)) {
      issues.push(`Variable ${index + 1} needs an uppercase name such as JAVA_HOME.`);
    } else if (variableNames.has(name)) {
      issues.push(`Variable ${name} is listed more than once.`);
    }
    variableNames.add(name);
  }

  if (form.buildCommands.filter((command) => command.trim()).length > 20) {
    issues.push('At most 20 build commands are allowed.');
  }
  if (form.buildCommands.some((command) => /[\r\n]/.test(command))) {
    issues.push('Build commands must contain one command per row.');
  }

  return issues;
};

export const environmentIdPreview = (value: string) => {
  const collapsed = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  const withoutLeadingSeparator = collapsed.startsWith('-') ? collapsed.slice(1) : collapsed;
  const withoutBoundarySeparators = withoutLeadingSeparator.endsWith('-')
    ? withoutLeadingSeparator.slice(0, -1)
    : withoutLeadingSeparator;
  return withoutBoundarySeparators.slice(0, 63) || 'generated-after-you-enter-a-name';
};

export const formFingerprint = (form: EnvironmentForm) => JSON.stringify(form);
