// Installed upstream protocol proof, separate from the native controller
// journey. Only provider responses are scripted: the CLI tools, hooks, engine
// transitions, review files and approval receipts are real.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { randomInt, randomUUID, createHash } from 'node:crypto';
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
import { initiator, respondent } from './native-qualification-member.mjs';
import { workspaceQualificationDriver } from './native-workspace-qualification-driver.mjs';
import { gameModule, gamePage, gameTest } from './native-qualification-game.mjs';
import {
  buildNativePendingInput,
  nativeAnswerText,
} from '../lambda/shared/native-pending-input.js';

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

const issuedRequestId = (directive) => {
  if (directive.kind !== 'print') {
    const error = new Error('Expected the pinned engine to issue a request');
    error.code = 'fixture_unexpected_intake';
    error.directive = {
      kind: directive.kind,
      askType: directive.ask_type,
      noActiveIntent: directive.message?.startsWith('No workflow state found (no active intent)'),
    };
    throw error;
  }
  const id = directive.message.match(/--request ([a-f0-9]{8})\b/)?.[1];
  assert.ok(id, 'The pinned engine issued a request ID');
  return id;
};
const publicationQuery = ({ publicationId, sequence }) => ({
  publicationId,
  publicationSequence: String(sequence),
});

// Only the installed CLI may run a tool or author a workspace file. Drive the
// next step from its actual result, including the request ID and steering receipt.
function* runDirective(command) {
  const output = yield { command };
  // Some CLIs frame the engine's JSON with tool timing or bash metadata.
  return JSON.parse(output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1));
}
function* loadStage(command) {
  const steering = yield* runDirective(command);
  assert.equal(steering.kind, 'load-steering');
  assert.match(steering.next, /^aidlc engine orchestrate continue [A-Za-z0-9_-]{1,64}$/);
  return yield* runDirective(steering.next);
}
async function readBoth(driver, route, parameters) {
  const [original, reopened] = await Promise.all(
    [initiator, respondent].map(({ token }) => driver.get(route, parameters, { token })),
  );
  assert.deepEqual(reopened, original);
  return original;
}

// Follow the two bearer identities across immutable revisions and the public
// activity feed, including after the respondent loses project membership.
async function qualifyCompetingHistory({
  driver,
  first,
  held,
  history,
  guidedHistory,
  gateEvidence,

  retained,
}) {
  const race = driver.competition();
  assert.equal(history.answer.id, race.commandId);
  assert.equal(history.answer.actorId, race.winner);
  assert.equal(history.answer.context.contentSha256, first.contentSha256);
  const query = publicationQuery(first);
  const original = await readBoth(driver, 'publication', query);
  assert.equal(original.id, first.publicationId);
  assert.equal(original.interactionId, first.id);
  assert.equal(original.sequence, first.sequence);
  assert.deepEqual(await readBoth(driver, 'interaction', query), history);
  assert.deepEqual(
    await readBoth(driver, 'publication', { ...publicationQuery(held), evidence: '1' }),
    gateEvidence,
  );
  const { events, nextEventAfter } = await readBoth(driver, 'outputs', { afterEvent: '0' });
  assert.equal(nextEventAfter, null);
  assert.equal(events.find((event) => event.type === 'native.accepted').actor, initiator.actorId);
  const acceptedTurns = events.filter((event) => event.type === 'native.answer.accepted');
  assert.deepEqual(
    acceptedTurns.map((event) => [event.replyToPublicationId, event.actor, event.turnSequence]),
    [
      [first.publicationId, respondent.actorId, history.answer.sequence],
      ...guidedHistory,
      [held.publicationId, initiator.actorId, retained.answer.sequence],
    ],
  );
  const [accepted] = acceptedTurns;
  const published = events.find(
    (event) =>
      event.type === 'native.published' &&
      event.publicationId === history.answer.resultingPublication.publicationId,
  );
  assert.equal(published.turnSequence, accepted.turnSequence);
  assert.equal(published.attemptId, accepted.attemptId);
  assert.equal(accepted.attemptId, gateEvidence.context.attemptId);
  assert.ok(published.revision > accepted.revision);
  driver.revoke(respondent.actorId);
  const denied = await driver.get('interaction', query, { token: respondent.token, status: 403 });
  assert.equal(denied.code, 'NATIVE_PREPARATION_FORBIDDEN');
  assert.deepEqual(await driver.get('interaction', query, { token: initiator.token }), history);
  assert.deepEqual(
    await driver.get('publication', { ...publicationQuery(held), evidence: '1' }),
    gateEvidence,
  );
  return {
    initiator: initiator.actorId,
    ...race,
    acceptedRevision: accepted.revision,
    resultingRevision: published.revision,
    acceptedSequence: accepted.turnSequence,
    originalSequence: first.sequence,
    acceptedTurns: acceptedTurns.length,
    acceptedForQuestion: acceptedTurns.filter(
      (event) => event.replyToPublicationId === first.publicationId,
    ).length,
    revokedReader: respondent.actorId,
    revokedReadCode: denied.code,
  };
}
async function qualifyLocalMember({
  harness,
  driver,
  provider,
  project,
  terminalResult,
  fileEdit,
  fileFault,
}) {
  const gameRequirements =
    '# Catch game requirements\n\nMove the target in depth when the player scores.\n';
  const gameQuestions = await fs.readFile(
    new URL('./test/fixtures/native-game-requirements-questions.md', import.meta.url),
    'utf8',
  );
  const pendingFile = join(project, '.native-control/pending-question.json');
  const unfinished = {
    filePath: join(project, 'nested/unfinished-review.txt'),
    content: 'Review in progress.\n',
  };
  const proof = (question) =>
    driver.get('publication', { ...publicationQuery(question), evidence: '1' });
  let turns = 0;
  async function turn(prompt, script, options = {}) {
    provider.begin({
      turn: ++turns,
      script,
      mode: options.interrupt ? 'interrupt' : 'normal',
      ...(options.selection && !options.fileAnswers ? { expectedAnswer: prompt } : {}),
      ...(turns === 1 ? { inputReads: driver.inputReads } : {}),
    });
    try {
      return await driver.turn(prompt, options);
    } finally {
      provider.result();
    }
  }
  const nextCommand = 'aidlc engine orchestrate next';
  const alternate = ['codex', 'opencode'].includes(harness);
  const proposed = alternate ? 'mvp' : 'express';
  let offer, stage, next, rejection;
  function* presentOffer() {
    // The installed conductor can forward the literal Start request as shell
    // words. Also exercise publication from the engine when it writes no form.
    const initial = yield* runDirective('aidlc next "Create a 3D version of the game"');
    if (!terminalResult) {
      const request = issuedRequestId(initial);
      const stale = request === '00000000' ? 'ffffffff' : '00000000';
      const refused = yield* runDirective(`${nextCommand} --scope express --request ${stale}`);
      assert.equal(refused.kind, 'error');
      assert.match(refused.message, /question is no longer available/);
      rejection = refused.message;
    }
    offer = yield* runDirective(
      `${nextCommand} --propose ${proposed} --request ${issuedRequestId(initial)}`,
    );
    yield { command: 'aidlc --version' };
    return rejection ? `${rejection}\n\n${offer.question}` : offer.question;
  }
  const firstSession = await turn('Start', presentOffer());
  assert.ok(firstSession);
  let first = await driver.interaction();
  if (rejection) assert.ok(first.messages.some(({ text }) => text.includes(rejection)));
  assert.equal(offer.ask_type, 'scope-confirm');
  assert.equal(offer.proposed_scope, proposed);
  assert.deepEqual(
    first.pendingInput,
    buildNativePendingInput({ spec: { version: 3, ask: offer } }),
  );
  assert.equal((await driver.get('publication')).id, first.publicationId);
  assert.equal((await proof(first)).engineApplication, 'not_recorded');
  const activeIntent = join(project, 'aidlc/spaces/default/intents/active-intent');
  const noSelectedIntent = async () => assert.rejects(fs.access(activeIntent), { code: 'ENOENT' });
  await noSelectedIntent();
  assert.equal(first.pendingInput.questions[0].options.length, 3);
  const selection = { answers: [{ selectedOptions: [0] }] };
  let planSelection = selection;
  let planLabel = offer.choices[0].label;
  const expressCommand = offer.scope_commands.find((entry) => entry.scope === 'express').command;
  if (alternate) {
    const recommendation = first;
    const other = { selectedOptions: [], freeText: 'Let’s use Express for this one' };
    const answer = harness === 'codex' ? other : { selectedOptions: [1] };
    const before = provider.result().totalRequests;
    function* prematureSelection() {
      yield* runDirective(expressCommand);
      yield {
        command: `aidlc engine intent create --scope express --request ${expressCommand.split(' ').at(-1)} --label premature`,
      };
      throw new Error('The provider created a workflow before explicit consent');
    }
    await turn(answer.freeText ?? offer.choices[1].label, prematureSelection(), {
      selection: { answers: [answer] },
      displayOnly: true,
    });
    assert.equal(provider.result().totalRequests, before);
    first = await driver.interaction();
    assert.notEqual(first.publicationId, recommendation.publicationId);
    assert.equal((await proof(first)).engineApplication, 'not_recorded');
    const plans = first.pendingInput.questions[0].options.map((option) => option.label);
    assert.deepEqual(
      plans,
      offer.scope_commands.map((entry) => entry.scope),
    );
    await noSelectedIntent();
    assert.equal(plans.length, 11);
    const original = await driver.get('interaction', publicationQuery(recommendation));
    assert.equal(original.answer.text, answer.freeText ?? offer.choices[1].label);
    planLabel = 'express';
    planSelection = { answers: [{ selectedOptions: [plans.indexOf(planLabel)] }] };
  }
  const compete = harness === 'claude' || terminalResult;
  const gateQuestion = 'Review the requirements. How would you like to proceed?';
  const gateSpec = {
    version: 2,
    questions: [
      { prompt: gateQuestion, options: [{ label: 'Approve' }, { label: 'Request Changes' }] },
    ],
  };
  const gateFile = { filePath: pendingFile, content: JSON.stringify(gateSpec) };
  function* selectPlan() {
    const creation = yield* runDirective(expressCommand);
    const id = expressCommand.match(/--request ([a-f0-9]{8})/)[1];
    assert.match(JSON.stringify(creation), /intent create/);
    yield {
      command: `aidlc engine intent create --scope express --request ${id} --label qualification-game`,
    };
    stage = yield* loadStage(nextCommand);
    assert.equal(stage.stage, 'requirements-analysis');
    const savedRequest = yield* runDirective('aidlc engine workspace project-description');
    assert.equal(savedRequest.description, driver.originalPrompt);
    if (terminalResult) return yield* presentExpressStage(stage, project, pendingFile);
    assert.equal(stage.gate, true);
    assert.equal(stage.produces.length, 2);
    for (const path of stage.produces)
      assert.match(
        path,
        /^aidlc\/spaces\/default\/intents\/[a-z0-9-]+\/inception\/requirements-analysis\/[a-z-]+\.md$/,
      );
    yield { filePath: join(project, stage.produces[1]), content: gameQuestions };
    assert.equal(stage.answer_mode.ask, true);
    const logged = yield* runDirective(
      `aidlc engine log decision --stage requirements-analysis --question-kind answer-mode --decision "How would you like to answer the questions?" --options "Guide me,I'll edit the file,Chat"`,
    );
    assert.equal(logged.emitted, 'DECISION_RECORDED');
    return 'How would you like to answer the questions?';
  }
  let filledQuestions, resumeMessage;
  const unexpectedGuideCall = {
    next() {
      throw Error('A provider was called for existing file questions');
    },
  };
  function* consumeAnswers(recovered = false) {
    // The observer reads before yielding ANY tool. The provider has no answer
    // vector and no action in this script can write the questionnaire.
    filledQuestions = readFileSync(join(project, stage.produces[1]), 'utf8');
    const slots = filledQuestions
      .split(/^## Q\d+[.)]/m)
      .slice(1)
      .map((section) => section.split(/^\[Answer\]: /m)[1]?.trimEnd());
    assert.equal(slots.length, 8);
    assert.ok(slots.every(Boolean), 'production applied every slot before model invocation');
    assert.equal(stage.ceremony.summary_confirmation, 'off');
    let kept = yield* runDirective(recovered ? `${nextCommand} --resume` : nextCommand);
    if (kept.kind === 'load-steering') kept = yield* runDirective(kept.next);
    if (recovered)
      console.log(
        JSON.stringify({
          probe: 'restored-method-state',
          kind: kept.kind,
          stage: kept.stage ?? null,
          ask: kept.ask_type ?? null,
          keys: Object.keys(kept),
          error: kept.kind === 'error' ? kept.message : null,
        }),
      );
    if (recovered && kept.kind === 'print') {
      resumeMessage = kept.message;
      assert.ok(resumeMessage?.trim());
      return resumeMessage;
    }
    assert.equal(kept.questions_answered?.path, stage.produces[1]);
    assert.equal(kept.answer_mode.mode, fileEdit ? 'file' : 'guide');
    if (!fileEdit) {
      const ledger = yield* runDirective('aidlc engine log answers --stage requirements-analysis');
      const recorded = ledger.answered.filter(
        (q) => q.question === 'Q1, Q2, Q3, Q4, Q5, Q6, Q7, Q8',
      );
      assert.equal(recorded.length, 1, 'Exactly one guided answer receipt');
      // The audit stores one physical line. The file oracle below retains the
      // submitted line breaks and compares the complete artifact bytes.
      assert.equal(
        recorded[0].answer,
        slots
          .map((v, i) => `Q${i + 1}: ${v}`)
          .join('; ')
          .replace(/\r\n?|\n|\u2028|\u2029/g, '\\n'),
      );
      assert.equal(ledger.open.length, 0);
    }
    yield { filePath: join(project, stage.produces[0]), content: gameRequirements };
    const opened = yield* runDirective(
      `aidlc engine orchestrate report --stage ${stage.stage} --result awaiting-approval`,
    );
    assert.match(opened.message, /Recorded awaiting-approval/);
    // The stage annex presents the held lifecycle gate. It is never logged as an interview question.
    yield gateFile;
    return gateQuestion;
  }
  assert.equal(
    await turn(planLabel, selectPlan(), {
      selection: planSelection,
      compete,
    }),
    firstSession,
  );
  const afterPlan = await driver.interaction();
  const guidedHistory = [];
  if (!terminalResult) {
    assert.deepEqual(
      afterPlan.pendingInput.questions[0].options.map((o) => o.label),
      ['Guide me', "I'll edit the file", 'Chat'],
    );
    const calls = provider.result().totalRequests;
    const pickedMode = fileEdit ? 1 : 0;
    await turn(afterPlan.pendingInput.questions[0].options[pickedMode].label, unexpectedGuideCall, {
      selection: { answers: [{ selectedOptions: [pickedMode] }] },
      displayOnly: true,
    });
    assert.equal(provider.result().totalRequests, calls);
    const batch = await driver.interaction();
    guidedHistory.push(
      [afterPlan.publicationId, initiator.actorId, batch.sequence],
      [batch.publicationId, initiator.actorId, batch.sequence + 1],
    );
    assert.equal(batch.pendingInput.questions.length, 8);
    assert.deepEqual(
      batch.pendingInput.questions.map((q) => q.options.length),
      [6, 5, 6, 6, 6, 5, 6, 5],
    );
    const formAnswers = new Map();
    let expected = gameQuestions;
    const sum = (bytes) => createHash('sha256').update(bytes).digest('hex');
    let current = batch;
    do {
      const partial = fileEdit && current.id === batch.id;
      const reply = {
        answers: current.pendingInput.questions.map((q, i) =>
          partial && i % 2
            ? { selectedOptions: [] }
            : i === 2
              ? {
                  selectedOptions: [],
                  freeText: `Use **touch** for ${randomUUID()}.\nKeep keyboard support.`,
                }
              : { selectedOptions: [randomInt(q.options.length - 1)] },
        ),
      };
      if (fileFault === 'changed') {
        const path = join(project, stage.produces[1]),
          changed = gameQuestions.replace('Source game', 'Source game (updated)');
        await fs.writeFile(path, changed);
        const count = provider.result().totalRequests;
        await turn(nativeAnswerText(current.pendingInput, reply), unexpectedGuideCall, {
          selection: reply,
          displayOnly: true,
          fileAnswers: true,
        });
        const conflict = await driver.interaction();
        assert.equal(conflict.pendingInput, null);
        assert.match(conflict.messages[0].text, /published questions changed/i);
        assert.equal(await fs.readFile(path, 'utf8'), changed);
        assert.equal(provider.result().totalRequests, count);
        assert.deepEqual(await driver.acceptedSelection(current.id), reply);
        console.log(
          JSON.stringify({
            probe: 'changed-file',
            accepted: true,
            applied: false,
            providerCalls: 0,
            currentSha256: sum(changed),
            published: conflict.publicationId,
          }),
        );
        return;
      }
      await turn(
        nativeAnswerText(current.pendingInput, reply),
        fileEdit ? unexpectedGuideCall : consumeAnswers(),
        {
          selection: reply,
          fileAnswers: true,
          displayOnly: fileEdit,
          interruptAfterFile: fileFault?.startsWith('restart') ? fileFault : false,
        },
      );
      const accepted = await driver.get('interaction', publicationQuery(current));
      const submitted = await driver.acceptedSelection(current.id);
      assert.equal(accepted.answer.text, nativeAnswerText(current.pendingInput, submitted));
      for (const [i, a] of submitted.answers.entries())
        if (a.freeText || a.selectedOptions.length)
          formAnswers.set(current.pendingInput.questions[i].header, a);
      // Independent byte oracle from the original artifact and accepted reply.
      expected = gameQuestions
        .split(/(?=^## Q\d+[.)])/m)
        .map((section, i) => {
          const a = formAnswers.get(batch.pendingInput.questions[i - 1]?.header);
          if (!a) return section;
          const letters = [...section.matchAll(/^- ([A-Z])\. /gm)].map((m) => m[1]);
          const chosen = a.selectedOptions.map((ix) => letters[ix]).join(', ');
          const value = a.freeText ? `${chosen || 'X'}: ${a.freeText}` : chosen;
          return section.replace(/^\[Answer\]:$/m, () => `[Answer]: ${value}`);
        })
        .join('');
      assert.equal(await fs.readFile(join(project, stage.produces[1]), 'utf8'), expected);
      if (fileEdit) {
        assert.equal(provider.result().totalRequests, calls);
        current = await driver.interaction();
        if (partial) {
          assert.equal(formAnswers.size, 4);
          assert.equal(current.pendingInput.questions.length, 4);
        }
      }
    } while (fileEdit && formAnswers.size < 8);
    if (fileEdit) {
      assert.equal(current.pendingInput.questions[0].options.length, 0);
      assert.match(current.pendingInput.questions[0].prompt, /done or ready/);
      await turn('ready', consumeAnswers(), {
        selection: { answers: [{ selectedOptions: [], freeText: 'ready' }] },
        fileAnswers: true,
      });
    }
    if (fileFault?.startsWith('restart')) {
      const stat = await fs.stat(join(project, stage.produces[1]));
      await turn('Confirmed workspace resume', consumeAnswers(true));
      const restored = await driver.interaction();
      if (fileFault === 'restart') {
        assert.ok(resumeMessage, 'Pinned method re-presented the unsettled guided decision');
        assert.equal(restored.pendingInput?.kind, 'choice');
        assert.deepEqual(
          restored.pendingInput.questions[0].options.map((o) => o.label),
          ['Use my saved answers', 'Discuss my answers'],
        );
        const reopened = await driver.get('interaction', publicationQuery(restored));
        assert.equal(reopened.interaction.contentSha256, restored.contentSha256);
        assert.deepEqual(reopened.interaction.pendingInput, restored.pendingInput);
        console.log(
          JSON.stringify({
            probe: 'restored-method-print',
            message: resumeMessage,
            recoveryChoice: restored.pendingInput.questions[0].prompt,
          }),
        );
        await turn('Use my saved answers', consumeAnswers(), {
          selection: { answers: [{ selectedOptions: [0] }] },
        });
      } else assert.equal(resumeMessage, undefined);
      const after = await fs.stat(join(project, stage.produces[1]));
      assert.equal(stat.ino, after.ino);
      assert.equal(stat.mtimeMs, after.mtimeMs);
      console.log(
        JSON.stringify({
          probe: 'file-restart',
          writerReplaced: true,
          appliedSha256: sum(expected),
          savedFileUnchanged: true,
        }),
      );
    }
    assert.equal(filledQuestions, expected);
    assert.equal(await fs.readFile(join(project, stage.produces[1]), 'utf8'), expected);
    console.log(
      JSON.stringify({
        probe: 'file-backed-answers',
        mode: fileEdit ? 'file' : 'guide',
        before: sum(gameQuestions),
        after: sum(expected),
        answers: 8,
        questionsPath: stage.produces[1],
        guideProviderCalls: 0,
        source: 'accepted member selection',
        cliConsumed: true,
      }),
    );
  }
  const held = await driver.interaction();
  assert.equal(held.pendingInput.kind, 'approval');
  assert.equal(held.pendingInput.stage, stage.stage);
  if (fileFault?.startsWith('restart')) {
    assert.equal((await proof(held)).engineApplication, 'not_recorded');
    console.log(
      JSON.stringify({
        probe: 'recovered-next-gate',
        kind: held.pendingInput.kind,
        stage: held.pendingInput.stage,
        sequence: held.sequence,
      }),
    );
    return;
  }
  if (fileEdit) {
    console.log(
      JSON.stringify({
        probe: 'file-edit-ready-gate',
        sequence: held.sequence,
        gate: held.pendingInput.stage,
        artifactSha256: createHash('sha256').update(filledQuestions).digest('hex'),
      }),
    );
    await driver.get('interaction');
    return;
  }
  const history = await driver.get('interaction', publicationQuery(first));
  assert.deepEqual(history.interaction.pendingInput, first.pendingInput);
  assert.equal(history.answer.context.publicationId, first.publicationId);
  assert.equal(history.answer.resultingPublication.publicationId, afterPlan.publicationId);
  assert.equal(history.answer.resultingPublication.publicationSequence, afterPlan.sequence);
  assert.equal(history.answer.context.membershipRecorded, true);
  assert.equal(history.answer.text, planLabel);
  const before = await proof(held);
  assert.equal(before.engineApplication, 'not_recorded');
  assert.equal(history.answer.applicationStatus, 'not_recorded');
  const gate = { id: stage.stage, state: 'awaiting-approval' };

  if (terminalResult) {
    await qualifyExpressResult({
      harness,
      driver,
      turn,
      project,
      held,
      pendingFile,
      before,

      first,
      history,
    });
    return;
  }

  // Keep the genuine CLI turn open after its unfinished write, before any
  // workflow command can consume the delivered approval.
  function* interruptedWork() {
    yield unfinished;
    if (harness === 'claude')
      yield {
        command: `node -e 'require("fs").writeFileSync(".native-control/interrupt-ready","ready");setInterval(()=>{},1000)'`,
      };
    else yield { filePath: join(project, '.native-control/interrupt-ready'), content: 'ready' };
  }
  await turn('Approve', interruptedWork(), { selection, interrupt: true });
  function* resumeGate() {
    next = yield* loadStage(`${nextCommand} --resume`);
    yield gateFile;
    return gateQuestion;
  }
  const replacement = await turn('/aidlc --resume', resumeGate());
  assert.ok(replacement);
  assert.notEqual(replacement, firstSession);
  assert.equal(next.stage, gate.id);
  assert.equal(next.gate_only, true);
  assert.equal(next.gate, true);
  assert.deepEqual(next.produces, stage.produces);
  assert.equal(await fs.readFile(join(project, next.produces[0]), 'utf8'), gameRequirements);
  assert.equal(await fs.readFile(join(project, next.produces[1]), 'utf8'), filledQuestions);
  assert.equal(await fs.readFile(unfinished.filePath, 'utf8'), unfinished.content);
  assert.equal(provider.result().inputReadWitnesses, driver.inputReads.length);
  const recovered = await driver.interaction();
  assert.deepEqual(recovered.pendingInput, held.pendingInput);
  assert.notEqual(recovered.id, held.id);
  assert.equal(recovered.response, null);
  const after = await proof(recovered);
  assert.equal(after.context.configurationSha256, before.context.configurationSha256);
  assert.deepEqual(after.engineApplication, before.engineApplication);
  assert.deepEqual(after.gates, before.gates);
  assert.equal(after.workflowCompletion, 'not_verified');
  assert.deepEqual(await driver.get('interaction', publicationQuery(first)), history);
  const retained = await driver.get('interaction', publicationQuery(held));
  assert.equal(retained.answer.interactionId, held.id);
  assert.equal(retained.answer.text, 'Approve');
  assert.equal(retained.answer.context.publicationId, held.publicationId);
  assert.equal(retained.answer.resumeRetention.delivery, 'delivered');
  const gateEvidence = await proof(held);
  assert.equal(gateEvidence.memberDecision.commandId, retained.answer.id);
  assert.equal(gateEvidence.memberDecision.label, 'Approve');
  assert.equal(gateEvidence.memberDecision.membershipRecorded, true);
  assert.equal(retained.answer.resultingPublication, null);
  const competition = compete
    ? await qualifyCompetingHistory({
        driver,
        first,
        held,
        history,
        guidedHistory,
        gateEvidence,

        retained,
      })
    : null;
  const native = await driver.finish({ expectedSessions: 2 });
  console.log(
    JSON.stringify({
      probe: 'local-member-workspace-resume',
      harness,
      status: 'PASS',
      packageId: after.context.packageId,
      attemptId: after.context.attemptId,
      configurationSha256: after.context.configurationSha256,
      originalPublication: first.publicationId,
      originalInteraction: first.id,
      acceptedOption: history.answer.id,
      selectedOption: history.answer.text,
      proposedPlan: proposed,
      contentSha256: first.contentSha256,
      projectDescription: driver.originalPrompt,
      offeredChoices: offer.choices.length,
      namedAlternatives: alternate ? offer.scope_commands.length : null,
      activeIntentBeforeSelection: false,
      rejectedRequestReason: rejection,
      interruptedPublication: held.publicationId,
      retainedAnswer: retained.answer.id,
      recoveredPublication: recovered.publicationId,
      application: after.engineApplication,
      retainedDelivery: retained.answer.resumeRetention.delivery,
      predecessorSession: firstSession,
      replacementSession: replacement,
      freshSession: replacement !== firstSession,
      unfinishedFile: 'nested/unfinished-review.txt',
      stageFiles: next.produces,
      gate: gate.id,
      gateState: gate.state,
      gateOnly: next.gate_only,
      workflowCompletion: after.workflowCompletion,
      ...(competition ? { competition } : {}),
      ...native,
    }),
  );
}

function* presentExpressStage(directive, project, pendingFile) {
  console.log(
    JSON.stringify({
      probe: 'local-express-stage',
      stage: directive.stage,
      gateOnly: directive.gate_only ?? false,
      produces: directive.produces?.length,
    }),
  );
  assert.equal(directive.kind, 'run-stage');
  assert.equal(directive.gate, true);
  const paths = directive.produces ?? [];
  for (const path of paths) {
    assert.match(path, /^aidlc\/[a-zA-Z0-9_./-]+$/);
    assert.ok(!path.split('/').includes('..'));
  }
  if (directive.stage === 'code-generation') {
    // The installed coding hook binds source writes to this plan and its
    // current Testing Contract. Express proceeds without a separate plan vote.
    const output = yield { command: 'aidlc engine testing-posture render' };
    const contract = output.match(/^## Testing Contract\s+```json\n[\s\S]*?\n```$/m)?.[0];
    assert.ok(contract, 'The installed tool rendered a complete Testing Contract');
    const plan = paths.find((path) => path.endsWith('/code-generation-plan.md'));
    const instructions = paths.find((path) => path.endsWith('/unit-test-instructions.md'));
    assert.ok(plan && instructions);
    yield {
      filePath: join(project, plan),
      content: `# Counter plan\n\n## Summary\nRender the existing catch game in three dimensions and test depth changes.\n\n- [ ] Write the target movement regression.\n- [ ] Implement the 3D catch target and run the test.\n\n${contract}\n`,
    };
    yield {
      filePath: join(project, instructions),
      content:
        '# Unit test instructions\n\nRun `node --test game.test.mjs`. Each score changes the target position in depth.\n',
    };
    let build = yield* runDirective('aidlc engine orchestrate next');
    if (build.kind === 'load-steering') {
      assert.match(build.next, /^aidlc engine orchestrate continue [A-Za-z0-9_-]{1,64}$/);
      build = yield* runDirective(build.next);
    }
    assert.equal(build.kind, 'run-stage');
    assert.equal(build.stage, directive.stage);
    assert.equal(build.plan_approval?.status, 'approved');
    assert.equal(build.plan_approval.skipped, true);
    yield { filePath: join(project, 'game.test.mjs'), content: gameTest };
    yield { filePath: join(project, 'game.mjs'), content: gameModule };
    yield { filePath: join(project, 'game3d.html'), content: gamePage };
    const result = yield { command: 'chmod +x run && rm obsolete.bin && ./run' };
    assert.match(result, /pass 1/);
  }
  for (const path of paths) {
    if (
      directive.stage === 'code-generation' &&
      /\/(?:code-generation-plan|unit-test-instructions)\.md$/.test(path)
    )
      continue;
    const content = path.endsWith('.json')
      ? JSON.stringify({
          requirement: 'play the catch game in three dimensions',
          implementation: 'game3d.html',
          test: 'game.test.mjs',
        }) + '\n'
      : `# ${directive.stage}\n\nOpen game3d.html on a local HTTP server to play. Clicking the target changes the score and its position in depth. Run ./run to test movement.\n`;
    yield { filePath: join(project, path), content };
  }
  const report = yield* runDirective(
    `aidlc engine orchestrate report --stage ${directive.stage} --result awaiting-approval`,
  );
  assert.match(report.message, /Recorded awaiting-approval/);
  if (directive.stage === 'code-generation') {
    // Report settles implementation. Read the newly issued open gate before
    // the real tool presents its form, without re-entering the stage body.
    let gate = yield* runDirective('aidlc engine orchestrate next');
    if (gate.kind === 'load-steering') {
      assert.match(gate.next, /^aidlc engine orchestrate continue [A-Za-z0-9_-]{1,64}$/);
      gate = yield* runDirective(gate.next);
    }
    assert.equal(gate.kind, 'run-stage');
    assert.equal(gate.stage, directive.stage);
    assert.equal(gate.gate, true);
    assert.equal(gate.gate_only, true);
  }
  const prompt = `Review ${directive.stage}. How would you like to proceed?`;
  yield {
    filePath: pendingFile,
    content: JSON.stringify({
      version: 2,
      questions: [{ prompt, options: [{ label: 'Approve' }, { label: 'Request Changes' }] }],
    }),
  };
  return prompt;
}

async function qualifyExpressResult({
  harness,
  driver,
  turn,
  project,
  held,
  pendingFile,
  before,

  first,
  history,
}) {
  const race = driver.competition();
  assert.equal(race.commandId, history.answer.id);
  assert.equal(history.answer.actorId, respondent.actorId);
  assert.deepEqual(await readBoth(driver, 'interaction', publicationQuery(first)), history);
  let waiting = held,
    terminal = false;
  const decisions = [
    {
      publicationId: first.publicationId,
      interactionId: first.id,
      commandId: race.commandId,
      actorId: race.winner,
      resultingPublicationId: held.publicationId,
      contentSha256: first.contentSha256,
    },
  ];
  const next = 'aidlc engine orchestrate next';
  for (let gate = 0; !terminal && gate < 16; gate++) {
    const current = waiting,
      query = publicationQuery(current);
    const opened = await readBoth(driver, 'interaction', query);
    const { response, ...question } = current;
    assert.equal(response, null);
    assert.deepEqual(opened.interaction, question);
    assert.equal(opened.answer, null);
    assert.equal(
      current.pendingInput?.kind,
      'approval',
      `Expected a bound stage approval at publication ${current.publicationId}`,
    );
    const actor = gate % 2 ? respondent : initiator;
    console.log(
      JSON.stringify({
        probe: 'local-express-gate',
        stage: current.pendingInput.stage,
        publicationId: current.publicationId,
        sequence: current.sequence,
        actor: actor.actorId,
      }),
    );
    const options = current.pendingInput.questions[0].options;
    const index = options.findIndex((option) => option.label === 'Approve');
    assert.ok(index >= 0);
    function* advance() {
      yield* runDirective(
        `aidlc engine orchestrate report --stage ${current.pendingInput.stage} --result approved --user-input Approve`,
      );
      let directive = yield* runDirective(next);
      for (let step = 0; step < 5; step++) {
        if (directive.kind === 'done' && !directive.workflow_continues) {
          terminal = true;
          return 'The Express workflow has completed.';
        }
        if (directive.kind === 'run-stage') break;
        if (directive.kind === 'load-steering') {
          assert.match(directive.next, /^aidlc engine orchestrate continue [A-Za-z0-9_-]{1,64}$/);
          directive = yield* runDirective(directive.next);
        } else {
          assert.ok(
            ['print', 'done'].includes(directive.kind) ||
              (!directive.kind && Object.hasOwn(directive, 'next_stage')),
            JSON.stringify(directive),
          );
          directive = yield* runDirective(next);
        }
      }
      return yield* presentExpressStage(directive, project, pendingFile);
    }
    await turn('Approve', advance(), {
      token: actor.token,
      selection: { answers: [{ selectedOptions: [index] }] },
    });
    waiting = await driver.interaction();
    const accepted = await readBoth(driver, 'interaction', query);
    assert.equal(accepted.answer.actorId, actor.actorId);
    assert.equal(accepted.answer.text, 'Approve');
    assert.equal(accepted.answer.context.membershipRecorded, true);
    assert.equal(accepted.answer.resultingPublication.publicationSequence, waiting.sequence);
    assert.equal(accepted.answer.context.contentSha256, current.contentSha256);
    assert.equal(accepted.answer.resultingPublication.publicationId, waiting.publicationId);
    assert.equal(accepted.answer.applicationStatus, 'not_recorded');
    decisions.push({
      publicationId: current.publicationId,
      interactionId: current.id,
      commandId: accepted.answer.id,
      actorId: actor.actorId,
      stage: current.pendingInput.stage,
      resultingPublicationId: waiting.publicationId,
      contentSha256: current.contentSha256,
    });
  }
  assert.ok(terminal);
  assert.equal(waiting.pendingInput, null);
  const verified = await readBoth(driver, 'publication', {
    ...publicationQuery(waiting),
    evidence: '1',
  });
  const revision = await readBoth(driver, 'publication', publicationQuery(waiting));
  assert.equal(revision.id, verified.publicationId);
  assert.equal(revision.sequence, verified.publicationSequence);
  assert.equal(verified.methodReport, 'complete');
  assert.equal(verified.workflowCompletion, 'not_verified');
  const historical = await readBoth(driver, 'publication', {
    ...publicationQuery(held),
    evidence: '1',
  });
  assert.equal(historical.workflowCompletion, 'not_verified');
  assert.deepEqual(historical.gates, before.gates);
  assert.deepEqual(historical.engineApplication, before.engineApplication);
  const graph = await readBoth(driver, 'graph');
  assert.equal(graph.publicationId, revision.id);
  const file = revision.files.find((entry) => entry.path === 'game3d.html');
  assert.ok(file);
  const artifact = graph.nodes.find((node) => node.id === file.id);
  assert.equal(artifact.sha256, file.sha256);
  assert.equal(artifact.publicationId, revision.id);
  const source = await driver.get(
    'files/{fileId}',
    { ...publicationQuery(waiting), sha256: file.sha256 },
    { fileId: file.id },
  );
  assert.equal(source.publicationId, revision.id);
  assert.equal(source.sha256, file.sha256);
  assert.equal(source.content, gamePage);
  const exported = await driver.exportResult(revision);
  console.log(
    JSON.stringify({
      probe: 'local-member-terminal-git-result',
      harness,
      status: 'PASS',
      packageId: verified.context.packageId,
      attemptId: verified.context.attemptId,
      configurationSha256: verified.context.configurationSha256,
      publicationId: verified.publicationId,
      publicationSequence: verified.publicationSequence,
      filesSha256: verified.filesSha256,
      graphPublication: graph.publicationId,
      downloadedFile: { id: file.id, path: source.path, sha256: source.sha256 },
      producer: verified.producer,
      projectDescription: driver.originalPrompt,
      workflowCompletion: verified.workflowCompletion,
      requiredChecks: verified.requiredChecks,
      finalReview: verified.finalReview,
      humanApproval: verified.humanApproval,
      terminalOutcome: verified.terminalOutcome,
      methodReport: verified.methodReport,
      priorWaitingPublication: historical.publicationId,
      priorCompletion: historical.workflowCompletion,
      competition: race,
      decisions,
      exported,
    }),
  );
}

export async function qualifyClaudeWorkspaceProtocol({
  composed = false,
  memberJourney = false,
} = {}) {
  if (memberJourney) {
    assert.ok(composed);
    return qualifyWorkspaceTransport('claude', { memberJourney });
  }
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
    if (composed)
      driver = await workspaceQualificationDriver({
        root,
        project,
        pkg,
        provider,
      });
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
      provider.begin({
        turn: sessions.size + 1,
        ...(driver && !sessions.size ? { inputReads: driver.inputReads } : {}),
      });
      if (driver) {
        session = await driver.turn(prompt, options);
        if (session) sessions.add(session);
        provider.result();
        return session;
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
    if (driver) assert.equal(provider.result().inputReadWitnesses, driver.inputReads.length);
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
        inputReadWitnesses: provider.result().inputReadWitnesses,
        ...(native ? { native } : {}),
      }),
    );
  } finally {
    await driver?.close();
    await provider.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

// The protected member row is shared. The upstream rows retain their own
// project-type reconciliation, dependency and file-preservation checks.
export async function qualifyWorkspaceTransport(
  harness,
  { memberJourney = false, terminalResult = false, fileEdit = false, fileFault = null } = {},
) {
  assert.ok(['codex', 'opencode'].includes(harness) || (memberJourney && harness === 'claude'));
  const root = await fs.mkdtemp('/tmp/native-workspace-transport-');
  const project = join(root, 'project');
  const provider = await qualificationProvider(harness, {
    requestLimit: terminalResult ? 128 : 64,
    verifyWrites: terminalResult,
  });
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
      model: { claude: 'claude-sonnet-4-6', codex: 'gpt-5.5', opencode: 'fixture/test' }[harness],
      memberJourney,
      terminalResult,
    });
    if (memberJourney) {
      await qualifyLocalMember({
        harness,
        driver,
        provider,
        project,
        terminalResult,
        fileEdit,
        fileFault,
      });
      return;
    }
    let turn = 0;
    const step = async (prompt, command, name, writePath) => {
      provider.begin({
        turn: ++turn,
        ...(turn === 1 ? { inputReads: driver.inputReads } : {}),
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
    assert.equal(provider.result().inputReadWitnesses, driver.inputReads.length);
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
        inputReadWitnesses: provider.result().inputReadWitnesses,
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
