// Compute model for managed environments: WHAT a compute selection is, which
// (type, architecture) combinations this deployment supports, and the
// architecture rules a recipe must satisfy. Pure data + validation — no AWS
// calls; the lifecycle of each compute type lives in runtime-backends/.
//
// Architecture and compute type are independent axes. Today the supported
// matrix is { microvms × arm64, instances × x86_64, instances × arm64 }; when
// the service adds x86 microVMs that becomes a new cell in `capabilities()`,
// not a new lifecycle branch.

export const COMPUTE_TYPES = ['microvms', 'instances'];
export const ARCHITECTURES = ['arm64', 'x86_64'];

export const DEFAULT_COMPUTE = Object.freeze({ type: 'microvms', architecture: 'arm64' });

const parseJsonEnv = (name, fallback) => {
  try {
    const value = process.env[name];
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

const httpError = (message, statusCode, code) =>
  Object.assign(new Error(message), { statusCode, ...(code ? { code } : {}) });

// --- deployment capabilities -------------------------------------------------

export const instancesComputeConfigured = () =>
  Boolean(
    process.env.MANAGED_INSTANCES_OPERATOR_ROLE_ARN &&
    parseJsonEnv('MANAGED_INSTANCES_SUBNETS', []).length > 0 &&
    parseJsonEnv('MANAGED_INSTANCES_SECURITY_GROUPS', []).length > 0,
  );

export const amd64CoreImageConfigured = () =>
  Boolean(process.env.CORE_IMAGE_URI_AMD64 && process.env.CORE_IMAGE_DIGEST_AMD64);

// EC2 instance types the deployment's capacity providers may launch, per
// architecture — an instance family is built for exactly one of them (m6i is
// x86_64, m7g is arm64/Graviton), so a single list cannot serve both cells.
// Terraform is the only source (local.instances_compute_environment, given to
// both the control and the status lambda); there is deliberately no default
// here, so an unset or empty list means the architecture is not offered.
const INSTANCE_TYPE_ENV = {
  x86_64: 'MANAGED_INSTANCES_ALLOWED_TYPES',
  arm64: 'MANAGED_INSTANCES_ALLOWED_TYPES_ARM64',
};

export const allowedInstanceTypes = (architecture) => {
  const name = INSTANCE_TYPE_ENV[architecture];
  if (!name) return [];
  const types = parseJsonEnv(name, []);
  return Array.isArray(types) ? types.filter((type) => typeof type === 'string' && type) : [];
};

// Why an Instances cell is unavailable, or null. The same checks apply to
// every architecture; x86_64 additionally needs the amd64 core image.
const instancesUnavailableReason = (architecture) => {
  if (!instancesComputeConfigured()) return 'INSTANCES_COMPUTE_NOT_CONFIGURED';
  if (allowedInstanceTypes(architecture).length === 0) return 'NO_INSTANCE_TYPES';
  if (architecture === 'x86_64' && !amd64CoreImageConfigured()) return 'AMD64_CORE_IMAGE_MISSING';
  return null;
};

// Every (type, architecture) cell with whether THIS deployment can build and
// run it, and why not when it cannot. Exposed on GET /environments/capabilities
// so the UI renders exactly the selectable combinations instead of hardcoding
// them; normalizeCompute validates creation against the same cells.
export const capabilities = () => {
  const microvms = (architecture, reason = null) => ({
    type: 'microvms',
    architecture,
    available: reason === null,
    ...(reason ? { reason } : {}),
  });
  const instances = (architecture) => {
    const reason = instancesUnavailableReason(architecture);
    return {
      type: 'instances',
      architecture,
      available: reason === null,
      ...(reason ? { reason } : { allowedInstanceTypes: allowedInstanceTypes(architecture) }),
    };
  };
  return {
    // Kept for callers that only need the two flags.
    instancesCompute: instancesComputeConfigured(),
    amd64CoreImage: amd64CoreImageConfigured(),
    default: { ...DEFAULT_COMPUTE },
    combinations: [
      microvms('arm64'),
      microvms('x86_64', 'MICROVMS_ARCHITECTURE_UNSUPPORTED'),
      instances('arm64'),
      instances('x86_64'),
    ],
  };
};

// --- normalization / validation ----------------------------------------------

// Normalizes and validates the `compute` field of an environment. Returns null
// for the default (microVMs, arm64) so existing records stay untouched.
export const normalizeCompute = (input) => {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw httpError('compute must be an object', 400);
  }
  const type = input.type ?? DEFAULT_COMPUTE.type;
  if (!COMPUTE_TYPES.includes(type)) {
    throw httpError(`compute.type must be one of: ${COMPUTE_TYPES.join(', ')}`, 400);
  }
  const architecture = input.architecture ?? (type === 'instances' ? 'x86_64' : 'arm64');
  if (!ARCHITECTURES.includes(architecture)) {
    throw httpError(`compute.architecture must be one of: ${ARCHITECTURES.join(', ')}`, 400);
  }
  if (type === DEFAULT_COMPUTE.type && architecture === DEFAULT_COMPUTE.architecture) {
    return null; // default — persist nothing
  }
  const cell = capabilities().combinations.find(
    (item) => item.type === type && item.architecture === architecture,
  );
  if (!cell.available) {
    switch (cell.reason) {
      case 'MICROVMS_ARCHITECTURE_UNSUPPORTED':
        throw httpError(
          'The microVMs compute type only supports the arm64 architecture',
          400,
          'COMPUTE_ARCHITECTURE_UNSUPPORTED',
        );
      case 'INSTANCES_COMPUTE_NOT_CONFIGURED':
        throw httpError(
          'The Instances compute type is not configured on this deployment (set enable_instances_compute)',
          409,
          'INSTANCES_COMPUTE_NOT_CONFIGURED',
        );
      case 'NO_INSTANCE_TYPES':
        throw httpError(
          `No ${architecture} instance types are allowed on this deployment`,
          409,
          'NO_INSTANCE_TYPES',
        );
      case 'AMD64_CORE_IMAGE_MISSING':
        throw httpError(
          'No x86_64 core image is published on this deployment',
          409,
          'AMD64_CORE_IMAGE_MISSING',
        );
      default:
        throw httpError('Unsupported compute selection', 409, 'COMPUTE_UNSUPPORTED');
    }
  }
  return { type, architecture };
};

// The effective compute of an environment record (absent field = default).
export const computeOf = (environment) => ({
  type: environment?.compute?.type ?? DEFAULT_COMPUTE.type,
  architecture: environment?.compute?.architecture ?? DEFAULT_COMPUTE.architecture,
});

export const environmentArchitecture = (environment) => computeOf(environment).architecture;

// --- recipe architecture rules -----------------------------------------------

// An arm64 build cannot start FROM an amd64 base image. x86_64 targets are
// covered by applyComputeBase (which swaps in the amd64 core); every other
// target must reject an x86_64 base revision.
export const assertBaseArchitecture = ({ compute, baseRevision, baseEnvironmentId }) => {
  if (compute?.architecture === 'x86_64') return;
  if (baseRevision?.recipe?.architecture === 'x86_64') {
    throw httpError(
      `Base environment ${baseEnvironmentId} is x86_64 and cannot be used by an arm64 environment`,
      409,
      'BASE_ARCHITECTURE_MISMATCH',
    );
  }
};

// Resolves the recipe base for x86_64 environments and checks that every tool
// in the recipe is an x86_64 build.
//
// - Standard/core base: the catalog resolver derives the base from the
//   published core revision (arm64), so the base ref is swapped for the amd64
//   build of the same core. The amd64 variant is resolved from the SELECTED
//   base revision (stored alongside it), never from the deployment's
//   environment variables — during a platform upgrade the staged core is newer
//   than the published one and the two must not be mixed.
// - Derived base: only an x86_64 parent is valid. Its published image already
//   is an amd64 build (it carries the parent's x86_64 tools), so it is kept.
export const applyComputeBase = ({ recipe, compute, baseRevision = null }) => {
  if (compute?.architecture !== 'x86_64') return recipe;
  const tools = [...(recipe.tools ?? []), ...(recipe.resolvedTools ?? [])];
  const foreign = tools.find((tool) => tool.architecture !== 'x86_64');
  if (foreign) {
    throw httpError(
      `Tool ${foreign.toolId} ${foreign.version} is an arm64 build; x86_64 environments need its x86_64 variant`,
      409,
      'TOOL_ARCHITECTURE_MISMATCH',
    );
  }
  if (recipe.base?.environmentId !== 'core' && recipe.base?.environmentId !== 'standard') {
    if (baseRevision?.recipe?.architecture !== 'x86_64') {
      throw httpError(
        `Base environment ${recipe.base?.environmentId} is arm64 and cannot be used by an x86_64 environment`,
        409,
        'BASE_ARCHITECTURE_MISMATCH',
      );
    }
    return { ...recipe, architecture: 'x86_64' };
  }
  const amd64 = baseRevision?.amd64Image;
  if (!amd64?.imageUri || !amd64?.imageDigest) {
    throw httpError(
      'The published core revision has no x86_64 variant; publish the staged core first',
      409,
      'AMD64_CORE_IMAGE_MISSING',
    );
  }
  return {
    ...recipe,
    architecture: 'x86_64',
    base: { ...recipe.base, imageUri: amd64.imageUri, imageDigest: amd64.imageDigest },
  };
};

// The one place that turns "a base revision + a resolved recipe" into the
// recipe pair an environment of this compute stores. Every create path
// (create, revise, rebuild-on-latest-base) goes through here, so the
// architecture rules are applied once and identically to both the recipe and
// its flattened form.
export const prepareRecipesForCompute = ({
  compute,
  baseRevision,
  baseEnvironmentId,
  recipe,
  flattenedRecipe,
}) => {
  assertBaseArchitecture({ compute, baseRevision, baseEnvironmentId });
  if (!compute) return { recipe, flattenedRecipe };
  return {
    recipe: applyComputeBase({ recipe, compute, baseRevision }),
    flattenedRecipe: applyComputeBase({ recipe: flattenedRecipe, compute, baseRevision }),
  };
};

export default {
  COMPUTE_TYPES,
  ARCHITECTURES,
  DEFAULT_COMPUTE,
  capabilities,
  instancesComputeConfigured,
  amd64CoreImageConfigured,
  allowedInstanceTypes,
  normalizeCompute,
  computeOf,
  environmentArchitecture,
  assertBaseArchitecture,
  applyComputeBase,
  prepareRecipesForCompute,
};
