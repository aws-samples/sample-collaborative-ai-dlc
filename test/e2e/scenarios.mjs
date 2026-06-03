// test/e2e/scenarios.mjs
const DEFAULT_PHASES = ['inception', 'construction'];

function csv(value) {
  return String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function parsePhases(value) {
  const phases = csv(value).map((phase) => phase.toLowerCase());
  return phases.length ? phases : [...DEFAULT_PHASES];
}

function parseQuestionStrategy(value) {
  const raw = String(value || 'default-answer').trim();
  return raw || 'default-answer';
}

export function resolveScenarioConfig(cfg) {
  const phases = parsePhases(cfg.phaseSelection);
  const scenarioKey = cfg.scenarioName || 'multi-changed';
  const changedRepos = cfg.expectedChangedRepos.length ? cfg.expectedChangedRepos : null;

  const primary = cfg.repos[0] || 'the primary repository';
  const secondaries = cfg.repos.slice(1);
  const secondaryList = secondaries.length ? secondaries.join(' and ') : null;
  const allRepos = cfg.repos.length ? cfg.repos.join(' and ') : primary;

  // Shared guidance that keeps runs realistic, bounded, and low-question.
  const qn = Number.isFinite(cfg.clarifyingQuestions) ? cfg.clarifyingQuestions : 2;
  const QUESTIONS =
    qn <= 0
      ? 'Do NOT ask clarifying questions: proceed directly and choose sensible defaults for any unspecified detail.'
      : `Ask at most ${qn} concise clarifying question${qn > 1 ? 's' : ''} before creating artifacts, then proceed and choose sensible defaults for anything else. Do not exceed ${qn} question${qn > 1 ? 's' : ''}.`;
  const TINY_CHANGE =
    'The edit only needs to be a valid, committable change to a single existing source file per repository (for example a short clarifying code comment or a small named constant). It does not need to be functionally meaningful.';
  const TIGHT_SCOPE =
    'Keep scope tiny: 1 requirement, 1 user story, and exactly one task per repository.';

  const expectations = {
    expectPrs: cfg.expectPrs,
    expectedChangedRepos: changedRepos,
    requireTaskCompletion: cfg.requireTaskCompletion,
    requireRunningTransition: cfg.requireRunningTransition,
  };

  const scenarios = {
    'single-repo': {
      name: 'single-repo',
      description:
        cfg.description ||
        `Make a minimal, low-risk change in the primary repository ${primary} only. ${TINY_CHANGE} Do not touch any other repository. ${TIGHT_SCOPE} ${QUESTIONS}`,
      repos: cfg.repos,
      phases,
      expectations: {
        ...expectations,
        expectPrs: true,
        expectedChangedRepos: changedRepos || [cfg.repos[0]].filter(Boolean),
      },
    },
    'multi-changed': {
      name: 'multi-changed',
      description:
        cfg.description ||
        `Make a minimal, coordinated change across these repositories: ${allRepos}. In EACH listed repository (primary ${primary}${secondaryList ? ` and secondary ${secondaryList}` : ''}), make one small change. ${TINY_CHANGE} ${TIGHT_SCOPE} Open one pull request per repository you changed, and do not create PRs for repositories you did not change. ${QUESTIONS}`,
      repos: cfg.repos,
      phases,
      expectations: {
        ...expectations,
        expectPrs: true,
      },
    },
    'no-change': {
      name: 'no-change',
      description:
        cfg.description ||
        `Inspect the repositories (${allRepos}) and conclude that no code change is required. Do not create tasks or pull requests. ${QUESTIONS}`,
      repos: cfg.repos,
      phases,
      expectations: {
        ...expectations,
        expectPrs: false,
        expectedChangedRepos: changedRepos || [],
      },
    },
    'review-cycle': {
      name: 'review-cycle',
      description:
        cfg.description ||
        `Make a minimal, coordinated change across these repositories: ${allRepos}. In EACH listed repository (primary ${primary}${secondaryList ? ` and secondary ${secondaryList}` : ''}), make one small change. ${TINY_CHANGE} ${TIGHT_SCOPE} Open one pull request per repository you changed, then the team will review them. ${QUESTIONS}`,
      repos: cfg.repos,
      phases: phases.includes('review') ? phases : [...phases, 'review'],
      expectations: {
        ...expectations,
        expectPrs: true,
        requireReview: true,
      },
    },
  };

  const scenario = scenarios[scenarioKey];
  if (!scenario) {
    throw new Error(`Unsupported E2E_SCENARIO: ${scenarioKey}`);
  }

  return {
    ...scenario,
    questionStrategy: parseQuestionStrategy(cfg.questionStrategy),
  };
}
