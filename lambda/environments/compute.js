// Compute selection for managed environments.
//
// A managed environment defaults to the serverless microVM compute type
// (arm64-only). Setting `compute: { type: 'instances' }` hosts the published
// revision's runtime on the AgentCore Instances compute type instead: EC2
// managed instances provisioned in this account from a capacity provider.
// Instances supports x86_64 in addition to arm64, so this is also the only
// path to x86 environments.
//
// The capacity provider is created lazily (one per architecture and
// configuration fingerprint, with a deterministic name) the first time a
// revision of a matching environment reaches runtime creation. Capacity
// providers are immutable after creation (only the description can be
// edited), which is why the platform treats them as create-once resources
// rather than terraform-managed state: configuration changes surface as a
// new fingerprint — and therefore a new provider — while runtimes created
// earlier keep the provider they were built with. Superseded providers are
// left in place (they may still back existing runtimes).

import { createHash } from 'node:crypto';
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

// arn:<partition>:bedrock-agentcore:<region>:<account>:capacity-provider/<id>
export const capacityProviderIdFromArn = (arn) => {
  const id = String(arn ?? '')
    .split('/')
    .pop();
  return id || null;
};

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

// Normalizes and validates the `compute` field of an environment. Returns
// null for the default (microVMs, arm64) so existing records stay untouched.
export const normalizeCompute = (input) => {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('compute must be an object'), { statusCode: 400 });
  }
  const type = input.type ?? 'microvms';
  if (!COMPUTE_TYPES.includes(type)) {
    throw Object.assign(new Error(`compute.type must be one of: ${COMPUTE_TYPES.join(', ')}`), {
      statusCode: 400,
    });
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
    throw Object.assign(new Error('No x86_64 core image is published on this deployment'), {
      statusCode: 409,
      code: 'AMD64_CORE_IMAGE_MISSING',
    });
  }
  return { type, architecture };
};

export const environmentArchitecture = (environment) =>
  environment?.compute?.architecture === 'x86_64' ? 'x86_64' : 'arm64';

// An arm64 build cannot start FROM an amd64 base image. x86_64 targets are
// covered by applyComputeBase (which swaps in the amd64 core); every other
// target must reject an x86_64 base revision.
export const assertBaseArchitecture = ({ compute, baseRevision, baseEnvironmentId }) => {
  if (compute?.architecture === 'x86_64') return;
  if (baseRevision?.recipe?.architecture === 'x86_64') {
    throw Object.assign(
      new Error(
        `Base environment ${baseEnvironmentId} is x86_64 and cannot be used by an arm64 environment`,
      ),
      { statusCode: 409, code: 'BASE_ARCHITECTURE_MISMATCH' },
    );
  }
};

// Rewrites the resolved recipe base to the amd64 core image for x86_64
// environments. The catalog resolver derives the base from the parent
// environment's published (arm64) revision; an x86_64 image cannot be built
// FROM an arm64 base, so the base ref is swapped for the amd64 build of the
// same core. The amd64 variant is resolved from the SELECTED base revision
// (stored alongside it), never from the deployment's environment variables —
// during a platform upgrade the staged core is newer than the published one
// and the two must not be mixed. Restricted to bases whose published image
// IS the core image — derived (tool-carrying) bases are arm64-only until the
// tool catalog gains per-architecture binaries.
export const applyComputeBase = ({ recipe, compute, baseRevision = null }) => {
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
  const amd64 = baseRevision?.amd64Image;
  if (!amd64?.imageUri || !amd64?.imageDigest) {
    throw Object.assign(
      new Error('The published core revision has no x86_64 variant; publish the staged core first'),
      { statusCode: 409, code: 'AMD64_CORE_IMAGE_MISSING' },
    );
  }
  return {
    ...recipe,
    architecture: 'x86_64',
    base: { ...recipe.base, imageUri: amd64.imageUri, imageDigest: amd64.imageDigest },
  };
};

// The capacity provider create input, minus name/description — and the
// fingerprint source. Capacity providers are immutable after creation, so
// any change to this configuration (instance allowlist, VPC, storage,
// lifecycle, operator role) must produce a NEW provider: the fingerprint in
// the name gives changed configurations a fresh identity while runtimes
// created from the previous configuration keep their provider. It also
// unblocks recovery when a provider failed on a bad configuration — the
// corrected configuration hashes to a different name.
const capacityProviderSpec = (architecture) => ({
  permissionsConfiguration: {
    capacityProviderOperatorRoleArn: process.env.MANAGED_INSTANCES_OPERATOR_ROLE_ARN,
  },
  computeConfiguration: {
    ec2Configuration: {
      launchTemplateSource: {
        launchParameters: {
          operatingSystem: OPERATING_SYSTEMS[architecture] ?? OPERATING_SYSTEMS.x86_64,
          instanceRequirements: {
            allowedInstanceTypes: parseJsonEnv('MANAGED_INSTANCES_ALLOWED_TYPES', ['m6i.large']),
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
});

export const capacityProviderName = (architecture, spec = capacityProviderSpec(architecture)) => {
  const prefix = process.env.MANAGED_INSTANCES_CP_NAME_PREFIX || 'aidlc_managed';
  const fingerprint = createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 8);
  const base = `${prefix}_${architecture === 'x86_64' ? 'x86' : 'arm64'}`.slice(0, 39);
  return `${base}_${fingerprint}`;
};

// Finds or creates the per-architecture capacity provider. Returns
// { pending: true } while the provider is still CREATING so the status
// poller re-enters on the next tick; throws when creation failed.
export const ensureCapacityProvider = async ({ controlClient, architecture }) => {
  const spec = capacityProviderSpec(architecture);
  const name = capacityProviderName(architecture, spec);
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
      ...spec,
    }),
  );
  return { pending: true };
};
