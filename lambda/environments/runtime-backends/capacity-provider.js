// AgentCore capacity providers — the EC2 fleet definition that backs the
// Instances compute type. One provider per (architecture, configuration
// fingerprint), created lazily with a deterministic name the first time a
// revision of a matching environment reaches runtime creation.
//
// Capacity providers are immutable after creation (only the description can
// be edited), which is why the platform treats them as create-once resources
// rather than terraform-managed state: configuration changes surface as a new
// fingerprint — and therefore a new provider — while runtimes created earlier
// keep the provider they were built with. Superseded providers are left in
// place (they may still back existing runtimes).

import { createHash } from 'node:crypto';
import {
  CreateCapacityProviderCommand,
  ListCapacityProvidersCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { allowedInstanceTypes } from '../compute-model.js';

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
            allowedInstanceTypes: allowedInstanceTypes(architecture),
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
