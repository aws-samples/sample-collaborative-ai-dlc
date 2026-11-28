// Human display names for slugs and ids the backend emits (providers). Raw
// values stay available to callers for "Technical details"; these are the
// primary labels.

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
function humanizeSlug(slug: string): string {
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
