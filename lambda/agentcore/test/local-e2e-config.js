export const LOCAL_E2E_CLIS = ['claude', 'kiro', 'opencode', 'codex'];

export const normalizeLocalE2eClis = (value = 'claude,kiro,opencode,codex') => {
  const selected = [];
  for (const raw of String(value).split(',')) {
    const cli = raw.trim();
    if (!cli) continue;
    if (!LOCAL_E2E_CLIS.includes(cli)) throw new Error(`unsupported E2E CLI "${cli}"`);
    if (!selected.includes(cli)) selected.push(cli);
  }
  if (!selected.length) throw new Error('no E2E CLIs selected');
  return selected;
};

export const localE2eModelFor = ({
  cli,
  bedrockModel = 'us.anthropic.claude-sonnet-4-6',
  kiroModel = 'auto',
  codexModel = 'openai.gpt-5.5',
}) => {
  if (cli === 'kiro') return kiroModel;
  if (cli === 'codex') return codexModel;
  if (cli === 'opencode' && !bedrockModel.startsWith('amazon-bedrock/')) {
    return `amazon-bedrock/${bedrockModel}`;
  }
  return bedrockModel;
};
