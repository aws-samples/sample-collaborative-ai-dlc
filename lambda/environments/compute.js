// Compute selection for managed environments.
//
// A managed environment defaults to the serverless microVM compute type
// (arm64-only). Setting `compute: { type: 'instances' }` hosts the published
// revision's runtime on the AgentCore Instances compute type instead: EC2
// managed instances provisioned in this account from a capacity provider.
// Instances supports x86_64 in addition to arm64, so this is also the only
// path to x86 environments.
//
// The capacity provider is created lazily (one per architecture, with a
// deterministic name) the first time a revision of a matching environment
// reaches runtime creation. Capacity providers are immutable after creation
// (only the description can be edited), which is why the platform treats
// them as create-once resources rather than terraform-managed state.

import {
  CreateCapacityProviderCommand,
  ListCapacityProvidersCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';

export const COMPUTE_TYPES = ['microvms', 'instances'];
export const ARCHITECTURES = ['arm64', 'x86_64'];

const OPERATING_SYSTEMS = {
  arm64: 'LINUX_ARM64',
  x86_64: 'LINUX_X86_64',
};

export const WORKSPACE_VOLUME_NAME = 'workspace';

const parseJsonEnv = (name, fallback) => {
  try {
    const value = process.env[name];
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

export const instancesComputeConfigured = () =>
  Boolean(
    process.env.MANAGED_INSTANCES_OPERATOR_ROLE_ARN &&
      parseJsonEnv('MANAGED_INSTANCES_SUBNETS', []).length > 0 &&
      parseJsonEnv('MANAGED_INSTANCES_SECURITY_GROUPS', []).length > 0,
  );

export const amd64CoreImageConfigured = () =>
  Boolean(process.env.CORE_IMAGE_URI_AMD64 && process.env.CORE_IMAGE_DIGEST_AMD64);

export const amd64CoreImage = () => ({
  imageUri: process.env.CORE_IMAGE_URI_AMD64,
  imageDigest: process.env.CORE_IMAGE_DIGEST_AMD64,
});

// Normalizes and validates the `compute` field of an environment. Returns
// null for the default (microVMs, arm64) so existing records stay untouched.
export const normalizeCompute = (input) => {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('compute must be an object'), { statusCode: 400 });
  }
  const type = input.type ?? 'microvms';
  if (!COMPUTE_TYPES.includes(type)) {
    throw Object.assign(
      new Error(`compute.type must be one of: ${COMPUTE_TYPES.join(', ')}`),
      { statusCode: 400 },
    );
  }
  const architecture = input.architecture ?? (type === 'instances' ? 'x86_64' : 'arm64');
  if (!ARCHITECTURES.includes(architecture)) {
    throw Object.assign(
      new Error(`compute.architecture must be one of: ${ARCHITECTURES.join(', ')}`),
      { statusCode: 400 },
    );
  }
  if (type === 'microvms') {
    if (architecture !== 'arm64') {
      throw Object.assign(
        new Error('The microVMs compute type only supports the arm64 architecture'),
        { statusCode: 400, code: 'COMPUTE_ARCHITECTURE_UNSUPPORTED' },
      );
    }
    return null; // default — persist nothing
  }
  if (!instancesComputeConfigured()) {
    throw Object.assign(
      new Error(
        'The Instances compute type is not configured on this deployment (set enable_instances_compute)',
      ),
      { statusCode: 409, code: 'INSTANCES_COMPUTE_NOT_CONFIGURED' },
    );
  }
  if (architecture === 'x86_64' && !amd64CoreImageConfigured()) {
    throw Object.assign(
      new Error('No x86_64 core image is published on this deployment'),
      { statusCode: 409, code: 'AMD64_CORE_IMAGE_MISSING' },
    );
  }
  return { type, architecture };
};

export const environmentArchitecture = (environment) =>
  environment?.compute?.architecture === 'x86_64' ? 'x86_64' : 'arm64';

// Rewrites the resolved recipe base to the amd64 core image for x86_64
// environments. The catalog resolver derives the base from the parent
// environment's published (arm64) revision; an x86_64 image cannot be built
// FROM an arm64 base, so the base ref is swapped for the amd64 build of the
// same core. Restricted to bases whose published image IS the core image —
// derived (tool-carrying) bases are arm64-only until the tool catalog gains
// per-architecture binaries.
export const applyComputeBase = ({ recipe, compute }) => {
  if (compute?.architecture !== 'x86_64') return recipe;
  if ((recipe.toolVersionIds ?? []).length > 0 || (recipe.resolvedTools ?? []).length > 0) {
    throw Object.assign(
      new Error('Catalog tools are arm64-only; x86_64 environments cannot select tools yet'),
      { statusCode: 409, code: 'TOOLS_UNSUPPORTED_ON_X86_64' },
    );
  }
  if (recipe.base?.environmentId !== 'core' && recipe.base?.environmentId !== 'standard') {
    throw Object.assign(
      new Error('x86_64 environments must derive from the Standard environment'),
      { statusCode: 409, code: 'X86_64_BASE_MUST_BE_STANDARD' },
    );
  }
  const amd64 = amd64CoreImage();
  return {
    ...recipe,
    architecture: 'x86_64',
    base: { ...recipe.base, imageUri: amd64.imageUri, imageDigest: amd64.imageDigest },
  };
};

const capacityProviderName = (architecture) => {
  const prefix = process.env.MANAGED_INSTANCES_CP_NAME_PREFIX || 'aidlc_managed';
  return `${prefix}_${architecture === 'x86_64' ? 'x86' : 'arm64'}`.slice(0, 48);
};

// Finds or creates the per-architecture capacity provider. Returns
// { pending: true } while the provider is still CREATING so the status
// poller re-enters on the next tick; throws when creation failed.
export const ensureCapacityProvider = async ({ controlClient, architecture }) => {
  const name = capacityProviderName(architecture);
  let token;
  do {
    const page = await controlClient.send(
      new ListCapacityProvidersCommand({ maxResults: 20, nextToken: token }),
    );
    const match = (page.capacityProviders ?? []).find((item) => item.name === name);
    if (match) {
      if (match.status === 'READY') return { capacityProviderArn: match.capacityProviderArn };
      if (match.status === 'CREATING') return { pending: true };
      throw new Error(
        `Capacity provider ${name} is ${match.status}: ${match.statusReason ?? 'no reason reported'}`,
      );
    }
    token = page.nextToken;
  } while (token);

  await controlClient.send(
    new CreateCapacityProviderCommand({
      name,
      description: `Managed environments (${architecture}) — created by the platform`,
      permissionsConfiguration: {
        capacityProviderOperatorRoleArn: process.env.MANAGED_INSTANCES_OPERATOR_ROLE_ARN,
      },
      computeConfiguration: {
        ec2Configuration: {
          launchTemplateSource: {
            launchParameters: {
              operatingSystem: OPERATING_SYSTEMS[architecture] ?? OPERATING_SYSTEMS.x86_64,
              instanceRequirements: {
                allowedInstanceTypes: parseJsonEnv('MANAGED_INSTANCES_ALLOWED_TYPES', [
                  't3.large',
                ]),
              },
            },
          },
          vpcConfiguration: {
            subnets: parseJsonEnv('MANAGED_INSTANCES_SUBNETS', []),
            securityGroups: parseJsonEnv('MANAGED_INSTANCES_SECURITY_GROUPS', []),
          },
          lifecycleConfiguration: {
            maxLifetime: Number(process.env.MANAGED_INSTANCES_MAX_LIFETIME || 28800),
          },
          volumes: [
            {
              ebsConfiguration: {
                name: WORKSPACE_VOLUME_NAME,
                sizeGiB: Number(process.env.MANAGED_INSTANCES_WORKSPACE_GIB || 50),
                volumeType: 'gp3',
              },
            },
          ],
        },
      },
    }),
  );
  return { pending: true };
};
