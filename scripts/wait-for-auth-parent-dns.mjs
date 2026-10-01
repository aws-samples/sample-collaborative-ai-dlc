#!/usr/bin/env node
import { resolve4 } from 'node:dns/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export const waitForAuthParentDns = async (
  domain,
  { lookup = resolve4, delay = sleep, attempts = 60, intervalMs = 5000 } = {},
) => {
  if (
    typeof domain !== 'string' ||
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)
  ) {
    throw new Error('AUTH_DOMAIN must be a bare lowercase hostname.');
  }
  const parent = domain.slice(domain.indexOf('.') + 1);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if ((await lookup(parent)).length > 0) return parent;
    } catch (error) {
      if (!['ENOTFOUND', 'ENODATA', 'ESERVFAIL', 'ETIMEOUT', 'EAI_AGAIN'].includes(error.code)) {
        throw error;
      }
    }
    if (attempt + 1 < attempts) await delay(intervalMs);
  }
  throw new Error(
    `Cognito requires a public DNS A record for ${parent} before creating ${domain}. Create the parent record and retry the deployment.`,
  );
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const parent = await waitForAuthParentDns(process.env.AUTH_DOMAIN);
    console.log(`Cognito parent DNS is ready: ${parent}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
