// Decode the current turn's workflow/question evidence for display. This data
// never admits a writer, records a human answer, or grants workflow approval.
import { parseQuestionFile, ordinaryFileForm, currentQuestionFile } from './question-file.js';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  buildNativePendingInput,
  NATIVE_AIDLC_INTERACTION_CONTRACT,
  NATIVE_PENDING_INPUT_LIMITS,
  NATIVE_PENDING_SPEC_PATH,
  NATIVE_TYPED_ASK_TYPES,
} from '../../shared/native-pending-input.js';

const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
const segment = (value) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(value);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const sameNode = (a, b) => a.dev === b.dev && a.ino === b.ino;
const fileRef = (file) => ({ path: file.path, sha256: file.sha256 });

// Optional display transport, cleared for each turn and never public file data.
export { NATIVE_PENDING_SPEC_PATH };

const unavailable = (reason, bytes = 0) => ({
  spec: null,
  reason,
  bytes: Math.min(bytes, NATIVE_PENDING_INPUT_LIMITS.specBytes + 1),
});

// The stock terminal directive must agree with the selected record in the
// same quiescent snapshot. Generic `done` directives can also mean archived,
// read-only or single-stage work. This is a report, never a verified verdict.
export function nativeMethodReport(snapshot, observation, pendingInput) {
  if (pendingInput || observation?.terminal !== 'complete') return null;
  const files = new Map(snapshot.files.map((file) => [file.path, file.content]));
  const text = (path) => files.get(path)?.toString('utf8').trim();
  const space = text('aidlc/active-space');
  if (!space || !segment(space)) return null;
  const intents = `aidlc/spaces/${space}/intents`;
  const intent = text(`${intents}/active-intent`);
  if (!intent || !segment(intent)) return null;
  const state = text(`${intents}/${intent}/aidlc-state.md`);
  if (
    !state ||
    [...state.matchAll(/^- \*\*Status\*\*:\s*([^\r\n]+)$/gm)].map((m) => m[1].trim()).join() !==
      'Completed' ||
    /^- \[(?:\?|R|-|!)\]|^- \[ \] [^\r\n]+ — EXECUTE\b/m.test(state)
  )
    return null;
  return 'complete';
}

/** Stage held at an engine approval gate ([?]) in this snapshot, or null. */
export const nativeGateFromSnapshot = (snapshot) => {
  try {
    const files = new Map(snapshot.files.map((file) => [file.path, file]));
    const read = (path) => {
      const file = files.get(path);
      if (!file) throw new Error('missing');
      return new TextDecoder('utf-8', { fatal: true }).decode(file.content);
    };
    const space = read('aidlc/active-space').trim();
    if (!segment(space)) return null;
    const intent = read(`aidlc/spaces/${space}/intents/active-intent`).trim();
    if (!segment(intent)) return null;
    const state = read(`aidlc/spaces/${space}/intents/${intent}/aidlc-state.md`);
    const stages = [...state.matchAll(/^- \*\*Current Stage\*\*:\s*([a-z][a-z0-9-]*)[ \t]*$/gm)];
    if (stages.length !== 1) return null;
    const stage = stages[0][1];
    const held = state
      .split(/\r?\n/)
      .filter((line) => line.startsWith(`- [?] ${stage} `) || line === `- [?] ${stage}`);
    return held.length === 1 ? { stage } : null;
  } catch {
    return null;
  }
};

// The reserved spec directory must be a real directory inside the project; the
// file is read without following links, bounded, and removed after each read.
const pendingSpecDirectory = async (project) => {
  const dir = join(project, '.native-control');
  try {
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory()) {
      await fs.rm(dir, { force: true });
      await fs.mkdir(dir, { mode: 0o700 });
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await fs.mkdir(dir, { mode: 0o700 });
  }
  return dir;
};
export const clearNativePendingSpec = async (project) => {
  const dir = await pendingSpecDirectory(project);
  await fs.rm(join(dir, 'pending-question.json'), { force: true });
};
export const readNativePendingSpec = async (
  project,
  { forbiddenBytes = [], onDiagnostic = () => {} } = {},
) => {
  const dir = join(project, '.native-control');
  let directory;
  const diagnose = (details) => {
    try {
      onDiagnostic(details);
    } catch {
      /* Telemetry cannot alter the outcome. */
    }
  };
  const unsafe = () => {
    diagnose({ reason: 'unsafe_path' });
    fail('native_execution_question_spec_unsafe');
  };
  try {
    directory = await fs.lstat(dir);
  } catch (error) {
    return unavailable(error?.code === 'ENOENT' ? 'absent' : 'read_failed');
  }
  if (!directory.isDirectory()) unsafe();
  const file = join(dir, 'pending-question.json');
  try {
    const handle = await fs.open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      if (!sameNode(directory, await fs.lstat(dir))) unsafe();
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) unsafe();
      if (stat.size > NATIVE_PENDING_INPUT_LIMITS.specBytes)
        return unavailable('too_large', stat.size);
      // A late writer cannot make readFile allocate unbounded bytes or escape
      // the observed directory. Quiescent content is display data, not authority.
      const bytes = Buffer.alloc(NATIVE_PENDING_INPUT_LIMITS.specBytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const part = await handle.read(bytes, length, bytes.length - length, length);
        if (!part.bytesRead) break;
        length += part.bytesRead;
      }
      if (!sameNode(directory, await fs.lstat(dir))) unsafe();
      if (length > NATIVE_PENDING_INPUT_LIMITS.specBytes) return unavailable('too_large', length);
      const content = bytes.subarray(0, length);
      // Raw malformed data is never uploaded. Known credentials are rejected
      // even in ignored keys or across adjacent string fields of invalid specs.
      let spec;
      const raw = content.toString('utf8');
      try {
        spec = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content));
      } catch {
        spec = undefined;
      }
      const values = [];
      const visit = (value) => {
        if (typeof value === 'string') values.push(value);
        else if (value && typeof value === 'object')
          for (const entry of Object.values(value)) visit(entry);
      };
      // JSON nesting is bounded independently of schema validation. No getters
      // or externally supplied objects enter this reader.
      try {
        visit(spec);
      } catch {
        spec = undefined;
      }
      if (
        forbiddenBytes.some((value) => {
          const secret = Buffer.from(value).toString('utf8');
          return secret && (raw.includes(secret) || values.join('').includes(secret));
        })
      ) {
        diagnose({ reason: 'credential' });
        fail('native_execution_output_credential');
      }
      return {
        spec: spec ?? null,
        reason: spec === undefined ? 'invalid_json' : null,
        bytes: length,
        sha256: digest(content),
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (
      ['native_execution_question_spec_unsafe', 'native_execution_output_credential'].includes(
        error?.code,
      )
    )
      throw error;
    if (error?.code === 'ELOOP') unsafe();
    return unavailable(error?.code === 'ENOENT' ? 'absent' : 'read_failed');
  } finally {
    const after = await fs.lstat(dir).catch(() => null);
    if (after?.isDirectory() && sameNode(directory, after))
      await fs.rm(file, { force: true }).catch(() => {});
  }
};

/**
 * Recognize only the observed v2 native active-space/intent, stage cursor and
 * unanswered-question format. A successful CLI exit is never workflow success.
 * These references describe exact evidence, not an approval or signed state.
 */
export const classifyNativeFirstWait = ({ snapshot, harness, beforeFiles = [], issuedFile }) => {
  const unknown = { kind: 'stopped_needs_review', code: 'native_wait_format_unrecognized' };
  try {
    const files = new Map(snapshot.files.map((file) => [file.path, file]));
    const read = (path) => {
      const file = files.get(path);
      if (!file) throw new Error('missing');
      return new TextDecoder('utf-8', { fatal: true }).decode(file.content);
    };
    const space = read('aidlc/active-space').trim();
    if (!segment(space)) return unknown;
    const intent = read(`aidlc/spaces/${space}/intents/active-intent`).trim();
    if (!segment(intent)) return unknown;
    const nativeIntentPath = `aidlc/spaces/${space}/intents/${intent}`;
    const statePath = `${nativeIntentPath}/aidlc-state.md`;
    const directivePath = `${nativeIntentPath}/.aidlc-engine/active-directive.json`;
    const state = read(statePath);
    const stages = [...state.matchAll(/^- \*\*Current Stage\*\*:\s*([a-z][a-z0-9-]*)[ \t]*$/gm)];
    if (stages.length !== 1) return unknown;
    const stage = stages[0][1];
    const directive = JSON.parse(read(directivePath));
    if (
      directive.version !== 2 ||
      directive.kind !== 'run-stage' ||
      directive.stage !== stage ||
      directive.cursor_harness !== harness ||
      directive.active_attempt?.status !== 'settled' ||
      !state.includes(`- [-] ${stage} — EXECUTE`) ||
      !/^- \*\*Status\*\*: Running[ \t]*$/m.test(state)
    )
      return unknown;
    const questions = snapshot.files.filter(
      (file) =>
        file.role === 'question' &&
        (!issuedFile ||
          (file.path === issuedFile.path &&
            stage === issuedFile.stage &&
            (directive.unit ?? null) === issuedFile.unit)) &&
        file.path.startsWith(`${nativeIntentPath}/`) &&
        file.path.endsWith(`/${stage}/${stage}-questions.md`),
    );
    if (questions.length !== 1) return unknown;
    const question = questions[0];
    if (beforeFiles.some((file) => file.path === question.path && file.sha256 === question.sha256))
      return { ...unknown, code: 'native_wait_unchanged_question' };
    const parsed = parseQuestionFile(question.content);
    const blocks = read(question.path)
      .split(/^## Q\d+[.)][ \t]+/m)
      .slice(1);
    if (!blocks.length) return unknown;
    let pending = 0;
    for (const block of blocks) {
      const answers = [...block.matchAll(/^\[Answer\]:([^\r\n]*)\r?$/gm)];
      if (answers.length !== 1) return unknown;
      const answer = answers[0];
      // A blank marker followed by free text is an answer too. Do not surface
      // an answered question simply because its answer starts on another line.
      if (!answer[1].trim() && !block.slice(answer.index + answer[0].length).trim()) pending++;
    }
    if (parsed) pending = parsed.blocks.filter((b) => b.pending).length;
    if (!pending) return unknown;
    return {
      kind: 'waiting_for_input',
      code: 'native_question_pending',
      evidence: {
        nativeIntentPath,
        stage,
        pendingQuestions: pending,
        state: fileRef(files.get(statePath)),
        directive: fileRef(files.get(directivePath)),
        questions: questions.map(fileRef),
        authority: 'workflow-evidence-only',
      },
    };
  } catch {
    return unknown;
  }
};

function fileDecisionFromAudit({ snapshot, beforeFiles, evidence, issuedFile, method }) {
  const auditPrefix = `${evidence.nativeIntentPath}/audit/`;
  const additions = snapshot.files.filter(
    (file) =>
      file.path.startsWith(auditPrefix) &&
      /^[\w.-]+\.md$/.test(file.path.slice(auditPrefix.length)) &&
      !beforeFiles.some((old) => old.path === file.path && old.sha256 === file.sha256),
  );
  if (additions.length !== 1) return null;
  const audit = additions[0];
  const previous = beforeFiles.find((old) => old.path === audit.path);
  if (previous && digest(audit.content.subarray(0, previous.bytes)) !== previous.sha256)
    return null;
  const auditBlocks = audit.content
    .subarray(previous?.bytes ?? 0)
    .toString('utf8')
    .trim()
    .split(/\n---(?:\n|$)/);
  // Artifact-write hooks can run after the question. A later decision, answer
  // or state transition supersedes it. Do not pick a row from another shard.
  const last = auditBlocks
    .filter(
      (block) =>
        block.trim() &&
        !/^\*\*Event\*\*: (?:ARTIFACT_CREATED|ARTIFACT_UPDATED|SESSION_ENDED)$/m.test(block),
    )
    .at(-1);
  const field = (name) =>
    last
      ?.split('\n')
      .find((line) => line.startsWith(`**${name}**: `))
      ?.slice(name.length + 6);
  if (
    field('Event') !== 'DECISION_RECORDED' ||
    field('Stage') !== evidence.stage ||
    (field('Checkpoint') &&
      (method.decision?.checkpoint !== 'summary-confirmation' ||
        field('Checkpoint') !== 'Consolidated Summary Confirmation')) ||
    (field('Unit') ?? null) !== (issuedFile?.unit ?? null) ||
    ((method.decision?.unit ?? null) !== (field('Unit') ?? null) &&
      !method.recordedRequirementsDecision) ||
    field('Workflow')
  )
    return null;
  const decision = {
    stage: evidence.stage,
    prompt: field('Decision'),
    options: field('Options'),
    questionKind: field('Question Kind'),
  };
  if (
    !decision.prompt ||
    (method.decision &&
      ['prompt', 'options', 'questionKind'].some((k) => method.decision[k] !== decision[k]))
  )
    return null;
  return { decision, field };
}

function checkpointQuestion({ issuedFile, decision, snapshot, file, method, field, evidence }) {
  if (issuedFile && !decision.questionKind) {
    const parsed = parseQuestionFile(snapshot.files.find((f) => f.path === file.path).content);
    const labels = decision.options?.split(',').map((v) => v.trim());
    const open = parsed?.checkpoints.filter((c) => !c.value);
    const block = open?.length === 1 && open[0];
    if (block && !parsed.blocks.some((b) => b.pending)) {
      const summary =
        block.title === 'Consolidated Summary Confirmation' &&
        method.decision?.checkpoint === 'summary-confirmation' &&
        field('Questions File') === file.path &&
        method.decision.path === file.path &&
        labels?.join(',') === 'Looks correct,Request changes';
      const assumption =
        block.title === 'Assumption Confirmation' &&
        !field('Checkpoint') &&
        evidence.stage === 'intent-capture' &&
        labels?.join(',') === 'Accept assumptions,Convert to follow-up questions';
      const feedback =
        block.title === 'Requested Changes Feedback' &&
        !field('Checkpoint') &&
        decision.prompt === 'What should change?' &&
        !labels;
      if (summary || assumption || feedback) {
        const spec = {
          version: 2,
          questions: [
            {
              prompt: block.body.includes(decision.prompt)
                ? block.body
                : `${block.body}\n\n${decision.prompt}`,
              options: (labels ?? []).map((label) => ({ label })),
            },
          ],
        };
        if (buildNativePendingInput({ spec }))
          return {
            spec,
            bytes: Buffer.byteLength(JSON.stringify(spec)),
            questionFile: {
              ...file,
              directive: evidence.directive.sha256,
              state: evidence.state.sha256,
              issuedFile,
            },
            checkpoint: block.title,
          };
      }
    }
  }
  return null;
}

// The installed method logs the mode question before showing it. A guided
// batch names the presented question numbers in the same log command. Read
// only the settled active stage's published question file.
export function nativeRequirementsForm({
  snapshot,
  beforeFiles,
  harness,
  method,
  guidedQuestions,
}) {
  if (!method?.decision && !method?.recordedRequirementsDecision) return null;
  const issuedFile = method.stageFile ?? guidedQuestions?.issuedFile;
  let { evidence } = classifyNativeFirstWait({ snapshot, harness, issuedFile });
  if (!evidence && issuedFile) {
    const nativeIntentPath = issuedFile.path.split('/').slice(0, 5).join('/');
    const state = snapshot.files.find((f) => f.path === `${nativeIntentPath}/aidlc-state.md`);
    const current =
      state && currentQuestionFile(snapshot, { issuedFile, state: state.sha256 }, harness);
    if (current)
      evidence = {
        nativeIntentPath,
        stage: issuedFile.stage,
        state: fileRef(state),
        directive: { sha256: current.cursorHash },
        questions: [fileRef(current.file)],
      };
  }
  if (
    !evidence ||
    (!issuedFile && evidence.stage !== 'requirements-analysis') ||
    (method.recordedStage && method.recordedStage !== evidence.stage)
  )
    return null;
  const recorded = fileDecisionFromAudit({ snapshot, beforeFiles, evidence, issuedFile, method });
  if (!recorded) return null;
  const { decision, field } = recorded;
  const file = evidence.questions[0];
  const modeLabels = ['Guide me', "I'll edit the file", 'Chat'];
  let questions;
  const checkpoint = checkpointQuestion({
    issuedFile,
    decision,
    snapshot,
    file,
    method,
    field,
    evidence,
  });
  if (checkpoint) return checkpoint;
  if (method.decision?.checkpoint || field('Checkpoint')) return null;
  if (decision.questionKind === 'answer-mode') {
    const labels = decision.options?.split(',').map((value) => value.trim());
    if (labels?.length !== 3 || !modeLabels.every((label) => labels.includes(label))) return null;
    questions = [
      {
        prompt: decision.prompt,
        options: labels.map((label) => ({
          label,
          ...(label === "I'll edit the file"
            ? {
                description: issuedFile
                  ? 'Edit the answer slots here, then tell AI-DLC when you are ready.'
                  : 'Published files are read-only here. Choose Guide me or Chat to answer in this UI.',
              }
            : {}),
        })),
      },
    ];
  } else {
    if (
      decision.questionKind ||
      (method.guidedStage !== evidence.stage &&
        method.stageFile?.mode !== 'guide' &&
        (guidedQuestions?.path !== file.path ||
          guidedQuestions.directive !== evidence.directive.sha256))
    )
      return null;
    const parsed = parseQuestionFile(
      snapshot.files.find((entry) => entry.path === file.path).content,
    );
    if (!parsed) return null;
    const range = /^Q(\d+)\s*[-–]\s*Q?(\d+)$/i.exec(decision.prompt);
    let ids =
      range &&
      +range[2] >= +range[1] &&
      +range[2] - +range[1] < NATIVE_PENDING_INPUT_LIMITS.questions
        ? Array.from({ length: +range[2] - +range[1] + 1 }, (_, i) => `Q${+range[1] + i}`)
        : decision.prompt.split(/,\s*/);
    if (!ids.every((id) => /^Q\d+$/.test(id))) {
      const matching = parsed.blocks.filter(
        (b) =>
          b.pending &&
          (b.question.prompt === decision.prompt || b.question.header === decision.prompt) &&
          b.question.options.map((o) => o.label).join(',') ===
            (decision.options ?? '').split(/,\s*/).join(','),
      );
      if (matching.length !== 1) return null;
      ids = [matching[0].id];
    }
    const form = ordinaryFileForm(parsed, ids);
    if (!form) return null;
    questions = form.spec.questions;
    if (issuedFile)
      return {
        ...form,
        questionFile: {
          ...file,
          directive: evidence.directive.sha256,
          state: evidence.state.sha256,
          issuedFile,
        },
        fileStep: 'guide',
        decision: decision.prompt,
      };
  }
  const spec = { version: 2, questions };
  return buildNativePendingInput({ spec })
    ? {
        spec,
        bytes: Buffer.byteLength(JSON.stringify(spec)),
        questionFile: {
          ...file,
          directive: evidence.directive.sha256,
          ...(issuedFile ? { state: evidence.state.sha256, issuedFile } : {}),
        },
        answerMode: decision.questionKind === 'answer-mode',
      }
    : null;
}

export const decodeNativeTurnInteraction = ({
  interactionContract,
  snapshot,
  rendered,
  messages,
  forbiddenBytes = [],
  onDiagnostic = () => {},
}) => {
  const renderedSpec = rendered.spec;
  const supported = interactionContract === NATIVE_AIDLC_INTERACTION_CONTRACT;
  const pendingInput = supported
    ? buildNativePendingInput({ gate: nativeGateFromSnapshot(snapshot), spec: renderedSpec })
    : null;
  const presentation = pendingInput
    ? null
    : {
        status: 'degraded',
        reason: !supported
          ? 'unsupported_methodology'
          : (rendered.reason ??
            (renderedSpec?.version === 3 ? 'unsupported_ask' : 'invalid_schema')),
      };
  // Persist only fixed categories/counts in owner status and lifecycle logs;
  // raw rejected JSON is discarded. The immutable interaction retains the
  // same degraded condition for UI/history after this owner is gone.
  const diagnostic = {
    reason: presentation?.reason ?? 'structured',
    bytes: rendered.bytes,
    ...(rendered.sha256 ? { sha256: rendered.sha256 } : {}),
    ...(renderedSpec?.version === 3
      ? {
          askType: NATIVE_TYPED_ASK_TYPES.includes(renderedSpec.ask?.ask_type)
            ? renderedSpec.ask.ask_type
            : 'unknown',
          responseRoute: ['next', 'command', 'claim'].includes(renderedSpec.ask?.response_route)
            ? renderedSpec.ask.response_route
            : 'unknown',
          suppliedChoices: Array.isArray(renderedSpec.ask?.choices)
            ? Math.min(renderedSpec.ask.choices.length, 513)
            : 0,
          suppliedScopeOptions: Array.isArray(renderedSpec.ask?.scope_commands)
            ? Math.min(renderedSpec.ask.scope_commands.length, 513)
            : 0,
        }
      : {}),
    declaredVersion:
      Number.isSafeInteger(renderedSpec?.version) &&
      renderedSpec.version >= 0 &&
      renderedSpec.version <= 3
        ? renderedSpec.version
        : 0,
    suppliedQuestions: Array.isArray(renderedSpec?.questions)
      ? Math.min(renderedSpec.questions.length, 513)
      : 0,
    suppliedOptions: Array.isArray(renderedSpec?.questions)
      ? Math.min(
          renderedSpec.questions.reduce(
            (n, q) => n + (Array.isArray(q?.options) ? q.options.length : 0),
            0,
          ),
          513,
        )
      : 0,
    questions: pendingInput?.questions.length ?? 0,
    options: pendingInput?.questions.reduce((n, q) => n + q.options.length, 0) ?? 0,
  };
  try {
    onDiagnostic(diagnostic);
  } catch {
    // Presentation telemetry cannot change the decoding outcome.
  }
  // A form can render text absent from the prose (prompt, header, descriptions).
  // Apply the same known-credential boundary before either public upload, also
  // catching a credential split across adjacent form fields.
  const formText =
    messages.map((message) => message.text).join('') +
    (pendingInput?.questions ?? [])
      .flatMap((entry) => [
        entry.header ?? '',
        entry.prompt,
        ...entry.options.flatMap((option) => [option.label, option.description ?? '']),
      ])
      .join('');
  if (
    forbiddenBytes.some((value) => {
      const secret = Buffer.from(value).toString('utf8');
      return secret && formText.includes(secret);
    })
  )
    fail('native_execution_output_credential');
  return { pendingInput, presentation };
};
