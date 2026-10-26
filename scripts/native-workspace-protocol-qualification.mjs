// Installed upstream protocol proof, separate from the native controller
// journey. Only provider responses are scripted: the CLI tools, hooks, engine
// transitions, review files and approval receipts are real.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNativeCommand } from '../lambda/agentcore/native/command-runner.js';
import { nativeExecutionInvocation } from '../lambda/agentcore/native/executor.js';
import { createNativeTurnOutput } from '../lambda/agentcore/native/turn-output.js';
import {
  prepareQualificationPackage,
  prepareQualificationOpenCodeCache,
} from './native-qualification-package.mjs';
import {
  qualificationProvider,
  localProviderInvocation,
  qualificationPlanOfferCommand,
} from './native-qualification-provider.mjs';
import { dependencyInstall } from './native-qualification-dependencies.mjs';
import { workspaceQualificationDriver } from './native-workspace-qualification-driver.mjs';
import { buildNativePendingInput } from '../lambda/shared/native-pending-input.js';

const requirements =
  '# Counter requirements\n\n## Behavior\nFR-1: Increment an integer counter by one.\n\n' +
  '## Acceptance\nA Node regression test proves increment(1) returns 2.\n';
const questions =
  '# Counter questions\n\n## Request\nFix the integer counter increment.\n\n' +
  '## Answers\nUse the Node test runner.\n';
const reviewContent =
  '## Review\n**Reviewer:** aidlc-product-lead-agent\n**Iteration:** 1\n**Verdict:** READY\n\n' +
  '### Findings\n**Prior findings**\n| ID | Now | Severity | Note |\n|---|---|---|---|\n\n' +
  '**New findings**\n| Severity | Location | Finding | Required action |\n|---|---|---|---|\n\n' +
  '### Evidence\nThe fixture specifies integer increment and a Node regression test.\n';
let toolId = 0;
const tool = (name, input) => ({ type: 'tool_use', id: `workspace${++toolId}`, name, input });
const bash = (command) => tool('Bash', { command });
const write = (path, content) => tool('Write', { file_path: path, content });

export async function qualifyClaudeWorkspaceProtocol({ composed = false } = {}) {
  const root = await fs.mkdtemp('/tmp/native-workspace-protocol-');
  const project = join(root, 'project');
  let home = join(root, 'home-1');
  let session;
  let steps = [];
  let childSteps = [];
  let primaryIndex = 0;
  let childIndex = 0;
  let childFinished;
  let finishChild;
  const sessions = new Set();
  let driver;
  let typedPlanOptions = 0;
  const provider = await qualificationProvider('claude', {
    requestLimit: composed ? 64 : 32,
    async claudeReply(request) {
      const parent = request.tools?.some((entry) => entry.name === 'Agent');
      const index = parent ? primaryIndex++ : childIndex++;
      const step = (parent ? steps : childSteps)[index];
      if (typeof step === 'function') return [await step(request)];
      if (step) return [step];
      if (!parent) finishChild?.();
      return [
        {
          type: 'text',
          text: parent
            ? 'Fixture work awaits your explicit approval.'
            : '**Reviewer:** aidlc-product-lead-agent\nReview complete.',
        },
      ];
    },
  });
  try {
    if (!composed) await fs.mkdir(project);
    await fs.mkdir(home);
    const pkg = await prepareQualificationPackage(root, '/assets');
    const env = {
      PATH: `${pkg.tools}:${root}/bin:/opt/bun/bin:/usr/local/bin:/usr/bin:/bin`,
      AIDLC_INSTALL_ROOT: join(root, 'data'),
      AIDLC_BIN_DIR: join(root, 'bin'),
      AIDLC_PROJECT_DIR: project,
      AIDLC_OFFLINE: '1',
    };
    const setup = [
      [pkg.binaryPath, ['use', pkg.version, '--from', pkg.directory, '--offline', '--json']],
      [
        join(root, 'bin/aidlc'),
        [
          'config',
          '--pin',
          pkg.version,
          '--project-dir',
          project,
          '--from',
          pkg.directory,
          '--offline',
          '--json',
        ],
      ],
      [
        join(root, 'bin/aidlc'),
        [
          'config',
          '--harness',
          'claude',
          '--project-dir',
          project,
          '--from',
          join(root, 'data/versions', pkg.version, 'runtime/claude'),
          '--mcp',
          'none',
          '--yes',
          '--json',
        ],
      ],
    ];
    for (const [command, args] of composed ? [] : setup) {
      const result = await runNativeCommand({
        command,
        args,
        cwd: project,
        env: { ...env, HOME: home },
        timeoutMs: 120000,
      });
      assert.equal(result.exitCode, 0, 'Attested offline package setup');
      assert.equal(result.cleanupComplete, true);
    }
    if (composed) driver = await workspaceQualificationDriver({ root, project, pkg, provider });
    else await fs.mkdir(join(project, '.native-control'));
    const read = async (name) =>
      JSON.parse(await fs.readFile(join(project, '.native-control', `${name}.json`), 'utf8'));
    const capture = (name, command) => bash(`${command} > .native-control/${name}.json`);
    const turn = async (prompt, commands, children = [], options = {}) => {
      steps = commands;
      childSteps = children;
      primaryIndex = childIndex = 0;
      childFinished = new Promise((resolve) => {
        finishChild = resolve;
      });
      provider.begin({ turn: sessions.size + 1 });
      if (driver) {
        session = await driver.turn(prompt, options);
        if (session) sessions.add(session);
        provider.result();
        return;
      }
      const output = createNativeTurnOutput({ harness: 'claude', nativeSessionId: session });
      const result = await runNativeCommand(
        localProviderInvocation(
          'claude',
          {
            ...nativeExecutionInvocation({
              harness: 'claude',
              model: 'claude-sonnet-4-6',
              project,
              prompt,
              nativeSessionId: session,
            }),
            cwd: project,
            env: { ...env, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude') },
            timeoutMs: 120000,
            onStdoutChunk: (chunk) => output.write(chunk),
          },
          provider.url,
        ),
      );
      assert.equal(result.exitCode, 0, 'Installed Claude turn completed');
      assert.equal(result.cleanupComplete, true, 'All old descendants stopped');
      const completed = output.finish();
      session = completed.nativeSessionId;
      assert.ok(session);
      sessions.add(session);
      provider.result();
    };
    const freshHome = async () => {
      if (driver) return driver.loseSession();
      await fs.rm(home, { recursive: true });
      await assert.rejects(fs.stat(home), { code: 'ENOENT' });
      home = join(root, `home-${sessions.size + 1}`);
      await fs.mkdir(home);
      session = null;
    };
    const drainSteering = async (name, prompt) => {
      const directive = await read(name);
      assert.equal(directive.kind, 'load-steering');
      assert.match(directive.receipt, /^[A-Za-z0-9_-]{1,64}$/);
      await turn(prompt, [
        capture('stage', `aidlc engine orchestrate continue ${directive.receipt}`),
      ]);
      return read('stage');
    };

    if (pkg.version === '2.11.1') {
      // Exercise the actual new intake protocol rather than forcing --scope
      // past the question. The real engine creates its request and choices;
      // the scripted conductor only copies that display data into transport.
      await turn('/aidlc Fix the qualification counter', [
        capture(
          'offer',
          qualificationPlanOfferCommand(pkg.version, 'bugfix', 'Fix the qualification counter'),
        ),
        async () => {
          const ask = await read('offer');
          assert.equal(ask.kind, 'ask');
          assert.equal(ask.ask_type, 'scope-confirm');
          return write(
            join(project, '.native-control/pending-question.json'),
            JSON.stringify({ version: 3, ask }),
          );
        },
      ]);
      const ask = await read('offer');
      const pending = buildNativePendingInput({ spec: { version: 3, ask } });
      assert.ok(pending, 'The real engine question is usable in the native form');
      assert.deepEqual(
        pending.questions[0].options.map((option) => option.label),
        ask.choices.map((choice) => choice.label),
      );
      typedPlanOptions = pending.questions[0].options.length;
      assert.equal(typedPlanOptions, 3);
      assert.equal(
        ask.choices[1].command,
        undefined,
        'Alternative-plan choice needs another input',
      );
      if (driver) assert.deepEqual((await driver.interaction()).pendingInput, pending);
      await turn(ask.choices[0].label, [capture('create', ask.confirm_command)], [], {
        selection: { answers: [{ selectedOptions: [0] }] },
      });
    } else {
      await turn('/aidlc --scope bugfix Fix the qualification counter', [
        capture(
          'create',
          'aidlc engine orchestrate next --scope bugfix "Fix the qualification counter"',
        ),
      ]);
    }
    // This pinned release emits the supported creation command in its print
    // directive. Only this synthetic fixture extracts its bounded request ID;
    // no production adapter parses prose or constructs a workflow state.
    const request = (await read('create')).message.match(/--request ([a-f0-9]{8}) /)?.[1];
    assert.ok(request, 'Engine saved the actual request');
    await turn('Create this bugfix workflow for the counter fixture.', [
      bash(
        `aidlc engine intent create --scope bugfix --request ${request} --label qualification-counter`,
      ),
      capture('next', 'aidlc engine orchestrate next'),
    ]);
    const initial = await drainSteering('next', 'Continue the fixture stage.');
    assert.equal(initial.stage, 'requirements-analysis');
    assert.equal(initial.gate, true);
    assert.equal(initial.ceremony.plan_approval, 'on');
    assert.equal(initial.review_class, 'advisory');
    assert.equal(initial.produces.length, 2);
    for (const path of initial.produces)
      assert.match(
        path,
        /^aidlc\/spaces\/default\/intents\/[a-z0-9-]+\/inception\/requirements-analysis\/[a-z-]+\.md$/,
      );
    const [artifact, answerFile] = initial.produces;
    await turn('The fixture requires integer increment and a Node regression test.', [
      ...(composed
        ? [
            bash(
              dependencyInstall +
                ' && ln node_modules/fixture-ordinary/cli.js node_modules/fixture-ordinary/alias.js',
            ),
          ]
        : []),
      write(join(project, artifact), requirements),
      write(join(project, answerFile), questions),
      capture(
        'review',
        'aidlc engine log review --stage requirements-analysis --reviewer aidlc-product-lead-agent --iteration 1',
      ),
    ]);
    const review = await read('review');
    assert.equal(review.emitted, 'REVIEW_REQUESTED');
    assert.ok(
      review.reviewFile.startsWith(artifact.split('/inception/')[0] + '/.aidlc-engine/reviews/'),
    );
    await turn(
      'Review the fixture requirements and present their approval gate.',
      [
        tool('Agent', {
          subagent_type: 'aidlc-product-lead-agent',
          description: 'Review counter fixture',
          prompt: `Read ${artifact}. Write only ${review.reviewFile}. This is a deterministic offline qualification fixture.`,
        }),
        async () => {
          await childFinished;
          return capture(
            'verdict',
            'aidlc engine log review --stage requirements-analysis --reviewer aidlc-product-lead-agent --iteration 1 --verdict READY',
          );
        },
        capture(
          'gate',
          'aidlc engine orchestrate report --stage requirements-analysis --result awaiting-approval',
        ),
      ],
      [
        tool('Read', { file_path: join(project, artifact) }),
        write(join(project, review.reviewFile), reviewContent),
      ],
    );
    assert.equal((await read('verdict')).emitted, 'REVIEW_COMPLETED');
    assert.match((await read('gate')).message, /Recorded awaiting-approval/);

    await freshHome();
    await turn('/aidlc --resume', [capture('resume', 'aidlc engine orchestrate next --resume')]);
    const resumed = await drainSteering('resume', 'Show the existing gate without approving it.');
    assert.equal(resumed.stage, initial.stage);
    assert.equal(resumed.gate_only, true);
    assert.equal(resumed.gate, true);
    assert.deepEqual(resumed.produces, initial.produces);
    assert.equal(await fs.readFile(join(project, artifact), 'utf8'), requirements);
    assert.equal(await fs.readFile(join(project, answerFile), 'utf8'), questions);
    assert.equal(sessions.size, 2, 'New CLI identity, same workflow and gate');
    let native;
    if (driver) {
      const [a, b] = await Promise.all(
        ['cli.js', 'alias.js'].map((name) =>
          fs.stat(join(project, 'node_modules/fixture-ordinary', name)),
        ),
      );
      assert.equal(a.ino, b.ino);
      assert.equal(a.nlink, 2);
      // A real installed tool writes incomplete work, then remains alive until
      // native cancellation kills it. No synthetic workflow-state edits.
      await turn(
        'Inspect the counter tooling before I approve the requirements.',
        [
          bash(
            `node -e 'require("fs").writeFileSync("unfinished-counter.cjs","module.exports = n => n + 1;\\n");require("fs").writeFileSync(".native-control/interrupt-ready","ready");setInterval(()=>{},1000)'`,
          ),
        ],
        [],
        { interrupt: true },
      );
      await turn('/aidlc --resume', [
        capture('interrupted-resume', 'aidlc engine orchestrate next --resume'),
        bash('npm run build --offline && npm test --offline'),
      ]);
      const resumedWork = await read('interrupted-resume');
      // Fresh CLI reads the pinned workflow's next incomplete stage itself.
      if (resumedWork.kind === 'load-steering') {
        const work = await drainSteering(
          'interrupted-resume',
          'Resume the incomplete implementation.',
        );
        assert.equal(work.stage, initial.stage);
        assert.equal(work.gate_only, true);
      } else {
        assert.equal(resumedWork.stage, initial.stage);
        assert.equal(resumedWork.gate_only, true);
      }
      assert.equal(
        await fs.readFile(join(project, 'unfinished-counter.cjs'), 'utf8'),
        'module.exports = n => n + 1;\n',
      );
      assert.equal(await fs.readFile(join(project, artifact), 'utf8'), requirements);
      assert.equal(await fs.readFile(join(project, 'dist/ordinary.txt'), 'utf8'), 'ordinary build');
      assert.equal(
        (await fs.stat(join(project, 'node_modules/fixture-ordinary/alias.js'))).ino,
        a.ino,
      );
    }
    await turn('Approve', [
      capture(
        'approved',
        'aidlc engine orchestrate report --stage requirements-analysis --result approved --user-input Approve',
      ),
    ]);
    assert.equal((await read('approved')).kind, 'done');
    assert.equal((await read('approved')).workflow_continues, true);
    assert.match((await read('approved')).reason, /Committed approve/);
    if (driver) native = await driver.finish();
    console.log(
      JSON.stringify({
        probe: composed ? 'native-upstream-workspace-resume' : 'upstream-workspace-resume',
        harness: 'claude',
        status: 'PASS',
        packageVersion: pkg.version,
        typedPlanOptions,
        sessions: sessions.size,
        oldHomeAbsent: true,
        realReviewCompleted: true,
        resumedStage: resumed.stage,
        resumedGateOnly: true,
        explicitApprovalAdvanced: true,
        privateSnapshots: 0,
        storage: 'local-disposable-directory',
        requests: provider.result().totalRequests,
        ...(native ? { native } : {}),
      }),
    );
  } finally {
    await driver?.close();
    await provider.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

// The other qualified installed CLIs use the same controller driver, but this
// smaller matrix proves binding/stage recovery only. Claude above additionally
// proves real review completion, two losses and the required approval receipt.
export async function qualifyWorkspaceTransport(harness) {
  assert.ok(['codex', 'opencode'].includes(harness));
  const root = await fs.mkdtemp('/tmp/native-workspace-transport-');
  const project = join(root, 'project');
  const provider = await qualificationProvider(harness, { requestLimit: 64 });
  let driver;
  try {
    const pkg = await prepareQualificationPackage(root, '/assets');
    const dependencyEnv =
      harness === 'opencode'
        ? await prepareQualificationOpenCodeCache(root, '/opencode-cache')
        : {};
    driver = await workspaceQualificationDriver({
      root,
      project,
      pkg,
      provider,
      harness,
      dependencyEnv,
      model: harness === 'codex' ? 'fixture-test' : 'fixture/test',
    });
    let turn = 0;
    const step = async (prompt, command, name, writePath) => {
      provider.begin({
        turn: ++turn,
        command:
          name && harness !== 'opencode' ? `${command} > .native-control/${name}.json` : command,
        openCodeWorkflow:
          harness === 'opencode'
            ? name
              ? { directivePath: join(project, '.native-control', `${name}.json`) }
              : writePath
                ? { writePath: join(project, writePath) }
                : undefined
            : undefined,
      });
      await driver.turn(prompt);
      provider.result();
    };
    const read = async (name) =>
      JSON.parse(await fs.readFile(join(project, '.native-control', `${name}.json`)));
    await step(
      'Fix the counter as a bugfix.',
      'aidlc engine orchestrate next --scope bugfix "Fix the counter"',
      'create',
    );
    const request = (await read('create')).message.match(/--request ([a-f0-9]{8}) /)?.[1];
    assert.ok(request);
    await step(
      'Create that bugfix workflow.',
      `aidlc engine intent create --scope bugfix --request ${request} --label workspace-counter`,
    );
    await step('Show its current stage.', 'aidlc engine orchestrate next', 'initial');
    const initial = await read('initial');
    assert.equal(initial.kind, 'load-steering');
    assert.match(initial.receipt, /^[A-Za-z0-9_-]{1,64}$/);
    await step('Load that stage.', `aidlc engine orchestrate continue ${initial.receipt}`, 'stage');
    const stage = await read('stage');
    assert.equal(stage.stage, 'requirements-analysis');
    assert.equal(stage.gate, true);
    let inode;
    if (harness === 'codex') {
      await step(
        'Inspect tooling before approving requirements.',
        dependencyInstall +
          ' && ln node_modules/fixture-ordinary/cli.js node_modules/fixture-ordinary/alias.js',
      );
      inode = (await fs.stat(join(project, 'node_modules/fixture-ordinary/cli.js'))).ino;
    } else {
      // The pinned OpenCode orchestrator permits direct framework commands,
      // not arbitrary shell work. Exercise its real write tool, preserving
      // that permission boundary; dependency builds are the Claude/Codex tier.
      await step(
        'Retain an unfinished note before requirements approval.',
        undefined,
        undefined,
        'nested/fixture.txt',
      );
    }
    await driver.loseSession();
    await step('Resume the existing workflow.', 'aidlc engine orchestrate next --resume', 'resume');
    let resumed = await read('resume');
    let reconciliationQuestion = false;
    if (harness === 'codex') {
      // The real engine detects code added since the initial empty-project
      // classification. An explicit fixture-human answer, never a wrapper
      // fallback or inferred approval, decides its reconciliation question.
      assert.equal(resumed.kind, 'ask');
      assert.equal(resumed.ask_type, 'project-type');
      assert.equal(resumed.response_route, 'command');
      assert.match(
        resumed.new_project_command,
        /^aidlc engine workspace reclassify --project-type greenfield --intent [a-z0-9-]+ --space default$/,
      );
      await step(
        'This fixture code was generated here; keep this a new project.',
        resumed.new_project_command,
      );
      await step(
        'Resume the incomplete requirements.',
        'aidlc engine orchestrate next --resume',
        'resume',
      );
      resumed = await read('resume');
      reconciliationQuestion = true;
    }
    assert.equal(resumed.kind, 'load-steering');
    assert.match(resumed.receipt, /^[A-Za-z0-9_-]{1,64}$/);
    await step(
      'Show the existing incomplete requirements.',
      `aidlc engine orchestrate continue ${resumed.receipt}`,
      'resumed-stage',
    );
    const next = await read('resumed-stage');
    assert.equal(next.stage, stage.stage);
    assert.deepEqual(next.produces, stage.produces);
    assert.equal(next.gate, true);
    if (harness === 'codex') {
      await step(
        'Rebuild the surviving dependencies without approving requirements.',
        'npm run build --offline && npm test --offline',
      );
      assert.equal(
        (await fs.stat(join(project, 'node_modules/fixture-ordinary/alias.js'))).ino,
        inode,
      );
      assert.equal(await fs.readFile(join(project, 'dist/ordinary.txt'), 'utf8'), 'ordinary build');
    } else
      assert.equal(
        await fs.readFile(join(project, 'nested/fixture.txt'), 'utf8'),
        'fixture cwd witness',
      );
    console.log(
      JSON.stringify({
        probe: 'native-upstream-workspace-resume',
        harness,
        status: 'PASS',
        packageVersion: pkg.version,
        resumedStage: next.stage,
        gatePreserved: true,
        reconciliationQuestion,
        dependencyBuild: harness === 'codex',
        ...(await driver.finish({ expectedSessions: 2 })),
        storage: 'local-disposable-directory',
        requests: provider.result().totalRequests,
      }),
    );
  } finally {
    await driver?.close();
    await provider.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  if (process.argv.includes('--codex')) await qualifyWorkspaceTransport('codex');
  else if (process.argv.includes('--opencode')) await qualifyWorkspaceTransport('opencode');
  else await qualifyClaudeWorkspaceProtocol({ composed: process.argv.includes('--composed') });
