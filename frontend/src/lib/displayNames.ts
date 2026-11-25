// Human display names for slugs and ids the backend emits (stages, sensors,
// scopes, phases, models, providers, CLIs). Raw values stay available to
// callers for "Technical details"; these are the primary labels.

import { AGENT_CLI_METADATA } from './agentCli';

const ACRONYMS = new Set(
  `adr ai api aws bdd cd cdk ci cli css cve ddd dns ec2 ecs eks faq html http https iam id
  jwt json kpi llm mcp ml mvp nfr owasp poc pr qa rag raid rds rest s3 sbom sdk sla slo
  sql sso tdd tls ui url ux vpc wcag yaml`.split(/\s+/),
);

// Acronyms whose written form is not the plain uppercase token.
const ACRONYM_FORMS: Record<string, string> = {
  aidlc: 'AI-DLC',
  cicd: 'CI/CD',
  cloudformation: 'CloudFormation',
  dynamodb: 'DynamoDB',
  github: 'GitHub',
  gitlab: 'GitLab',
  graphql: 'GraphQL',
  grpc: 'gRPC',
  iac: 'IaC',
  oauth: 'OAuth',
};

// Two consecutive slug words that read as one acronym ("ai-dlc" → "AI-DLC").
const ACRONYM_PAIRS: Record<string, string> = {
  'ai dlc': 'AI-DLC',
  'ci cd': 'CI/CD',
  'ui ux': 'UI/UX',
};

const MINOR_WORDS = new Set('a an and for in of on or the to vs with'.split(' '));

const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

const acronymForm = (lower: string): string | null => {
  if (ACRONYM_FORMS[lower]) return ACRONYM_FORMS[lower];
  if (ACRONYMS.has(lower)) return lower.toUpperCase();
  // Plural acronyms: 'adrs' → 'ADRs', 'apis' → 'APIs'.
  const singular = lower.endsWith('s') ? lower.slice(0, -1) : null;
  if (singular && ACRONYMS.has(singular)) return `${singular.toUpperCase()}s`;
  return null;
};

/** 'reverse-engineering' → 'Reverse Engineering'; 'api_design' → 'API Design'. */
export function humanizeSlug(slug: string): string {
  const words = slug
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean);
  const out: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const lower = words[index].toLowerCase();
    const pair = index + 1 < words.length ? `${lower} ${words[index + 1].toLowerCase()}` : null;
    if (pair && ACRONYM_PAIRS[pair]) {
      out.push(ACRONYM_PAIRS[pair]);
      index += 1;
      continue;
    }
    const acronym = acronymForm(lower);
    if (acronym) out.push(acronym);
    else if (index > 0 && MINOR_WORDS.has(lower)) out.push(lower);
    else out.push(capitalize(words[index]));
  }
  return out.join(' ');
}

type NamedNode = { name?: string | null } | string | null | undefined;

/** Compiled node name when it is a real name, else the humanized slug. */
export function displayStageName(slug: string, compiled?: NamedNode): string {
  const name = (typeof compiled === 'string' ? compiled : compiled?.name)?.trim();
  if (name && name !== slug) return name;
  return humanizeSlug(slug);
}

/** 'inception' → 'Inception'; ordered paths like '02-construction' drop the prefix. */
export const displayPhase = (slug: string): string => humanizeSlug(slug.replace(/^\d+[-_.]/, ''));

const CLAUDE_FAMILIES = new Set(['opus', 'sonnet', 'haiku']);

// Strip Bedrock packaging around a model name: ARN path, CLI provider prefix
// ('amazon-bedrock/'), cross-region profile ('us.', 'global.'), vendor
// ('anthropic.'), revision ('-v1:0', ':0') and release date ('-20250514').
function bareModelName(id: string): string {
  return id
    .trim()
    .replace(/^.*\//, '')
    .replace(/^(?:us|eu|apac|global|jp|au|ca|us-gov)\./, '')
    .replace(/^(?:anthropic|openai)\./, '')
    .replace(/(?:-v\d+)?(?::\d+)?$/, '')
    .replace(/-\d{8}$/, '');
}

function versionFrom(tokens: string[]): string | null {
  const numeric = tokens.filter((token) => /^\d+(?:\.\d+)?$/.test(token));
  return numeric.length === tokens.length && numeric.length > 0 ? numeric.join('.') : null;
}

function claudeName(rest: string[]): string | null {
  const familyIndex = rest.findIndex((token) => CLAUDE_FAMILIES.has(token));
  if (familyIndex < 0) return null;
  const family = capitalize(rest[familyIndex]);
  if (familyIndex === 0) {
    const version = versionFrom(rest.slice(1));
    return version ? `Claude ${family} ${version}` : null;
  }
  const version = versionFrom(rest.slice(0, familyIndex));
  return version && familyIndex === rest.length - 1 ? `Claude ${version} ${family}` : null;
}

function gptName(rest: string[]): string | null {
  const [version, ...qualifiers] = rest;
  if (!version) return null;
  if (version === 'oss') {
    const size = qualifiers.filter((q) => !/^\d+$/.test(q)).map((q) => q.toUpperCase());
    return ['GPT-OSS', ...size].join(' ');
  }
  if (!/^\d/.test(version)) return null;
  return [`GPT-${version}`, ...qualifiers.map(capitalize)].join(' ');
}

/**
 * Readable model name for Bedrock / Anthropic / OpenAI ids:
 * 'global.anthropic.claude-opus-4-6-v1:0' → 'Claude Opus 4.6',
 * 'gpt-5.4' → 'GPT-5.4'. Unknown ids are returned unchanged.
 */
export function displayModel(id: string): string {
  const contextMatch = /\[(\d+)([km])\]$/i.exec(id.trim());
  const bare = bareModelName(contextMatch ? id.trim().slice(0, contextMatch.index) : id);
  const [vendor, ...rest] = bare.toLowerCase().split('-');
  const name = vendor === 'claude' ? claudeName(rest) : vendor === 'gpt' ? gptName(rest) : null;
  if (!name) return id;
  return contextMatch
    ? `${name} (${contextMatch[1]}${contextMatch[2].toUpperCase()} context)`
    : name;
}

/** Several model ids (array or comma-separated) → 'Claude Opus 4.6 · Claude Sonnet 4.6'. */
export function displayModels(ids: string | readonly string[]): string {
  const list = typeof ids === 'string' ? ids.split(',') : ids;
  const names = list
    .map((id) => id.trim())
    .filter(Boolean)
    .map(displayModel);
  return [...new Set(names)].join(' · ');
}

// Matches services/gitProvider.ts terminology and lib/trackerProviders.tsx.
const PROVIDER_NAMES: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  codecommit: 'AWS CodeCommit',
  'jira-cloud': 'Jira Cloud',
  jira: 'Jira',
  'github-issues': 'GitHub Issues',
  'gitlab-issues': 'GitLab Issues',
  'bitbucket-issues': 'Bitbucket',
  bedrock: 'Amazon Bedrock',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  kiro: 'Kiro',
  aws: 'AWS',
};

export function displayProvider(slug: string): string {
  return PROVIDER_NAMES[slug.trim().toLowerCase()] ?? humanizeSlug(slug);
}

export function displayCli(cli: string): string {
  const metadata = AGENT_CLI_METADATA[cli as keyof typeof AGENT_CLI_METADATA];
  return metadata?.label ?? humanizeSlug(cli);
}

const SUFFIX_SEPARATOR = /\s+[—–-]\s+|:\s+/g;

function splitSuffix(label: string): [head: string, suffix: string] | null {
  let last: RegExpExecArray | null = null;
  for (const match of label.matchAll(SUFFIX_SEPARATOR)) last = match as RegExpExecArray;
  if (!last) return null;
  const head = label.slice(0, last.index).trim();
  const suffix = label.slice(last.index + last[0].length).trim();
  return head && suffix ? [head, suffix] : null;
}

/**
 * The trailing " — X" / ": X" suffix shared by the most labels (at least two),
 * provided stripping it keeps those labels distinct; otherwise null.
 */
export function commonSuffix(labels: readonly string[]): string | null {
  const heads = new Map<string, string[]>();
  for (const label of labels) {
    const split = splitSuffix(label);
    if (!split) continue;
    heads.set(split[1], [...(heads.get(split[1]) ?? []), split[0]]);
  }
  let best: string | null = null;
  let bestCount = 1;
  for (const [suffix, suffixHeads] of heads) {
    if (suffixHeads.length > bestCount && new Set(suffixHeads).size === suffixHeads.length) {
      best = suffix;
      bestCount = suffixHeads.length;
    }
  }
  return best;
}

/**
 * Remove the shared trailing suffix (see commonSuffix) from the labels that
 * carry it: seven "X — Retail Store Sample App" titles become "X". Labels
 * without it, or a suffix carried by fewer than two labels, are left as-is.
 */
export function stripCommonSuffix(labels: readonly string[]): string[] {
  const suffix = commonSuffix(labels);
  if (!suffix) return [...labels];
  return labels.map((label) => {
    const split = splitSuffix(label);
    return split && split[1] === suffix ? split[0] : label;
  });
}
