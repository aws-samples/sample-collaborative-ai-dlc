// AI-DLC 2.11.1 stage-protocol §3. The issued run-stage identifies the output.
// An answer may change only the blank slot displayed at the admitted revision.
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import {
  buildNativePendingInput,
  NATIVE_PENDING_INPUT_LIMITS,
} from '../../shared/native-pending-input.js';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const segment = (text) =>
  typeof text === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(text);
const conflict = () => {
  throw Object.assign(new Error('Question file changed'), {
    code: 'native_execution_reply_conflict',
  });
};

// The plan questionnaire is written by the engine's plan-approval command.
// Isolated runs and swarm/wave directives carry different ownership rules.
export function issuedQuestionFile(d) {
  if (
    d.kind !== 'run-stage' ||
    !segment(d.stage) ||
    d.stage === 'code-generation' ||
    d.single ||
    d.gate_only ||
    d.wave ||
    d.swarm_settled ||
    d.kept_replies ||
    d.parked_reply ||
    d.artifact_reuse ||
    !['inception', 'ideation', 'construction', 'operation', 'initialization'].includes(d.phase) ||
    !Array.isArray(d.produces) ||
    typeof d.answer_mode?.ask !== 'boolean'
  )
    return null;
  const unit = d.unit && d.unit !== '{unit-name}' ? d.unit : null;
  if (unit && (!segment(unit) || d.phase !== 'construction')) return null;
  const suffix = [d.phase, ...(unit ? [unit] : []), d.stage, `${d.stage}-questions.md`].join('/');
  const matches = d.produces.filter((p) => typeof p === 'string' && p.endsWith('/' + suffix));
  // Some graph nodes declare only generated artifacts; section 3 still uses
  // answeredQuestionsFile's stage directory. memory_path identifies the record
  // from this issued directive. Confirm its phase, unit and stage before using it.
  const dir = suffix.slice(0, suffix.lastIndexOf('/'));
  const diaryDir =
    typeof d.memory_path === 'string' && d.memory_path.endsWith('/memory.md')
      ? dirname(d.memory_path)
      : '';
  const stageDir = `${d.phase}/${d.stage}`;
  let recordDir = null;
  if (
    typeof d.stage_file === 'string' &&
    d.stage_file.endsWith(`/aidlc-common/stages/${stageDir}.md`)
  ) {
    if (diaryDir.endsWith('/' + dir)) recordDir = diaryDir;
    // buildRunStageDirective emits the stage diary even when answeredQuestionsFile
    // resolves the questionnaire under a particular construction unit.
    else if (unit && diaryDir.endsWith('/' + stageDir)) {
      const unitDir = diaryDir.slice(0, -stageDir.length) + dir;
      if (d.produces.some((p) => typeof p === 'string' && dirname(p) === unitDir))
        recordDir = unitDir;
    }
  }
  const path =
    d.questions_answered?.path ??
    matches[0] ??
    (recordDir && `${recordDir}/${d.stage}-questions.md`);
  if (
    typeof path !== 'string' ||
    !path.endsWith('/' + suffix) ||
    (matches.length && (matches.length !== 1 || matches[0] !== path))
  )
    return null;
  const parts = path.split('/');
  if (
    parts.length !== suffix.split('/').length + 5 ||
    parts[0] !== 'aidlc' ||
    parts[1] !== 'spaces' ||
    parts[3] !== 'intents' ||
    !parts.every(segment)
  )
    return null;
  return {
    path,
    stage: d.stage,
    unit,
    mode: d.answer_mode.ask ? null : d.answer_mode.mode,
    reopened: Boolean(d.questions_answered),
  };
}

export function parseQuestionFile(bytes) {
  if (bytes.length > NATIVE_PENDING_INPUT_LIMITS.specBytes) return null;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
  // Embedded examples and hidden markup do not identify editable slots. A
  // structural marker inside one makes the bounded normal form ambiguous.
  let fence = null,
    comment = false;
  for (const line of text.split(/\r?\n/)) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter && !comment) {
      if (!fence) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = null;
      continue;
    }
    if (line.includes('<!--')) comment = true;
    if ((fence || comment) && /^(?:## |\[Answer\]:)/.test(line)) return null;
    if (line.includes('-->')) comment = false;
  }
  const headings = [...text.matchAll(/^## (.+?)\r?$/gm)];
  const blocks = [],
    checkpoints = [],
    numbers = new Set();
  for (const [i, h] of headings.entries()) {
    const section = text.slice(h.index + h[0].length, headings[i + 1]?.index ?? text.length);
    const tags = [...section.matchAll(/^\[Answer\]:([^\r\n]*)/gm)];
    if (!tags.length) continue;
    const heading = /^Q(\d+)[.)]\s+(.+)$/i.exec(h[1]);
    // Summary, assumption, requested-changes and plan entries have their own
    // sequencing or receipt semantics. Never include them in an ordinary batch.
    if (tags.length !== 1) return null;
    const title = heading?.[2] ?? h[1];
    if (!heading || title === 'Consolidated Summary Confirmation') {
      if (
        ![
          'Consolidated Summary Confirmation',
          'Assumption Confirmation',
          'Requested Changes Feedback',
        ].includes(title)
      )
        return null;
      const tag = tags[0];
      const start = h.index + h[0].length + tag.index + '[Answer]:'.length;
      checkpoints.push({
        title,
        body: section.slice(0, tag.index).trim(),
        value: section.slice(tag.index + '[Answer]:'.length).trim(),
        start,
        end: start + tag[1].length,
      });
      continue;
    }
    if (/consolidated summary confirmation/i.test(heading[2]) || numbers.has(heading[1]))
      return null;
    numbers.add(heading[1]);
    const tag = tags[0];
    const body = section.slice(0, tag.index).trim().split(/\r?\n/);
    const optionPattern = /^\s*(?:[-*]\s+)?([A-Z])[.)]\s+(.+?)\s*$/;
    const firstOption = body.findIndex((line) => optionPattern.test(line));
    const prompt =
      (firstOption < 0 ? body : body.slice(0, firstOption)).join('\n').trim() || heading[2];
    const letters = [],
      options = [];
    for (const line of firstOption < 0
      ? []
      : body.slice(firstOption).filter((line) => line.trim())) {
      const match = optionPattern.exec(line);
      if (!match || letters.includes(match[1])) return null;
      letters.push(match[1]);
      options.push({ label: match[2] });
    }
    const start = h.index + h[0].length + tag.index + '[Answer]:'.length;
    const trailing = section.slice(tag.index + tag[0].length).trim();
    const pending = /^[\t _]*$/.test(tag[1]) && (!trailing || /^-{3,}$/.test(trailing));
    blocks.push({
      id: `Q${heading[1]}`,
      start,
      end: start + tag[1].length,
      pending,
      letters,
      question: {
        header: heading[2],
        prompt,
        options,
        multiSelect: /\(select all that apply\)/i.test(`${heading[2]} ${prompt}`),
      },
    });
  }
  // Extra slots, including unsupported headings and fenced examples, cannot be
  // discarded when deciding completeness. Keep their original artifact visible.
  if (
    (!blocks.length && !checkpoints.length) ||
    (text.match(/^\[Answer\]:/gm) ?? []).length !== blocks.length + checkpoints.length
  )
    return null;
  return { text, blocks, checkpoints };
}

export function ordinaryFileForm(parsed, ids) {
  if (parsed?.checkpoints.some((c) => !c.value)) return null;
  const pending = parsed?.blocks.filter((b) => b.pending && (!ids || ids.includes(b.id)));
  if (
    !pending?.length ||
    (ids && (pending.length !== ids.length || pending.some((b, i) => b.id !== ids[i])))
  )
    return null;
  const spec = { version: 2, questions: pending.map((b) => b.question) };
  return buildNativePendingInput({ spec })
    ? { spec, ids: pending.map((b) => b.id), bytes: Buffer.byteLength(JSON.stringify(spec)) }
    : null;
}

export function fileCompletionForm(questionFile) {
  const prompt = `Your edits are saved in ${questionFile.path}. When you are done, send done or ready to continue.`;
  const spec = { version: 2, questions: [{ prompt, options: [] }] };
  return { spec, bytes: Buffer.byteLength(JSON.stringify(spec)), questionFile, fileReady: true };
}

export function fillQuestionFile(parsed, ids, selection, partial = false) {
  if (!ordinaryFileForm(parsed, ids) || selection?.answers.length !== ids.length) return null;
  let text = parsed.text;
  let filled = 0;
  const details = [];
  for (let i = ids.length - 1; i >= 0; i--) {
    const b = parsed.blocks.find((entry) => entry.id === ids[i]);
    const a = selection.answers[i],
      letters = a.selectedOptions.map((index) => b.letters[index]);
    if (!letters.length && !a.freeText && partial) continue;
    if (
      letters.some((letter) => !letter) ||
      (!letters.length && !a.freeText) ||
      (letters.includes('X') && !a.freeText) ||
      (a.freeText && /^(?:\[Answer\]:|##\s+Q\d+[.)])/im.test(a.freeText))
    )
      return null;
    const words = a.freeText;
    // Preserve an Other written reply even when the words happen to be a
    // displayed option. Keep the file's own letters in their original order.
    const chosen = letters.length ? letters.join(', ') : b.letters.includes('X') ? 'X' : '';
    const value = words ? (chosen ? `${chosen}: ${words}` : words) : chosen;
    if (!value.trim() || /^_+$/.test(value.trim())) return null;
    details.unshift(`${b.id}: ${value}`);
    text = text.slice(0, b.start) + ' ' + value + text.slice(b.end);
    filled++;
  }
  const bytes = Buffer.from(text);
  if (!filled || bytes.length > NATIVE_PENDING_INPUT_LIMITS.specBytes) return null;
  return { bytes, sha256: hash(bytes), details: details.join('; ') };
}

// Checkpoints each have their own stored syntax and receipt. Prose about a
// choice stays with the conductor. Only an explicit button or the requested
// feedback field authorizes changing this slot.
export function fillQuestionCheckpoint(parsed, title, answer) {
  const open = parsed?.checkpoints.filter((c) => !c.value);
  if (open?.length !== 1 || open[0].title !== title || parsed.blocks.some((b) => b.pending))
    return null;
  const [index] = answer.selectedOptions;
  let value, details;
  if (title === 'Requested Changes Feedback') {
    if (index !== undefined || !answer.freeText) return null;
    value = details = answer.freeText;
  } else {
    const summary = title === 'Consolidated Summary Confirmation';
    const options = summary
      ? ['Looks correct', 'Request changes']
      : ['A. Accept assumptions', 'B. Convert to follow-up questions'];
    if (answer.selectedOptions.length !== 1 || !options[index]) return null;
    if (answer.freeText && !(summary && index === 1)) return null;
    value = options[index];
    details = summary ? value : value.slice(3);
    if (answer.freeText) details += `: ${answer.freeText}`;
  }
  if (/^(?:\[Answer\]:|##\s+Q\d+[.)])/im.test(value)) return null;
  const { start, end } = open[0];
  const bytes = Buffer.from(parsed.text.slice(0, start) + ' ' + value + parsed.text.slice(end));
  if (bytes.length > NATIVE_PENDING_INPUT_LIMITS.specBytes) return null;
  return { bytes, sha256: hash(bytes), details };
}

// The executor owns a quiescent workspace. Open each directory without
// following links and anchor Linux child lookups to that open descriptor.
export async function persistQuestionFile(project, binding, result, assertWriter) {
  const directories = [],
    pathParts = binding.path.split('/');
  if (!pathParts.every(segment)) conflict();
  const handles = [];
  try {
    let path = project;
    for (const part of ['', ...pathParts.slice(0, -1)]) {
      if (part) path = join(path, part);
      const dir = await fs.open(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      handles.push(dir);
      directories.push([path, await dir.stat()]);
      if (process.platform === 'linux') path = `/proc/self/fd/${dir.fd}`;
    }
    const target = join(path, basename(binding.path));
    const read = async () => {
      const fd = await fs.open(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = await fd.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > NATIVE_PENDING_INPUT_LIMITS.specBytes)
          conflict();
        const bytes = Buffer.alloc(info.size + 1);
        let n = 0;
        while (n < bytes.length) {
          const r = await fd.read(bytes, n, bytes.length - n, n);
          if (!r.bytesRead) break;
          n += r.bytesRead;
        }
        if (n !== info.size) conflict();
        return { digest: hash(bytes.subarray(0, n)), info };
      } finally {
        await fd.close();
      }
    };
    const check = async () => {
      await assertWriter();
      for (const [p, before] of directories) {
        const now = await fs.lstat(p);
        if (now.dev !== before.dev || now.ino !== before.ino) conflict();
      }
    };
    await check();
    const old = await read();
    if (old.digest !== binding.sha256) conflict();
    const temp = join(dirname(target), `.native-answer-${randomUUID()}.tmp`);
    const fd = await fs.open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      old.info.mode & 0o777,
    );
    try {
      try {
        await fd.writeFile(result.bytes);
        await fd.sync();
      } finally {
        await fd.close();
      }
      await check();
      const before = await read();
      if (before.digest !== old.digest || before.info.ino !== old.info.ino) conflict();
      await fs.rename(temp, target);
      await handles.at(-1).sync();
      if ((await read()).digest !== result.sha256) conflict();
    } finally {
      await fs.rm(temp, { force: true });
    }
  } finally {
    for (const fd of handles.reverse()) await fd.close();
  }
}

export function currentQuestionFile(snapshot, binding, harness) {
  const entries = new Map(snapshot.files.map((f) => [f.path, f]));
  const source = binding.issuedFile,
    parts = source.path.split('/'),
    root = parts.slice(0, 5).join('/');
  if (
    entries.get('aidlc/active-space')?.content.toString().trim() !== parts[2] ||
    entries.get(`aidlc/spaces/${parts[2]}/intents/active-intent`)?.content.toString().trim() !==
      parts[4]
  )
    return null;
  const state = entries.get(`${root}/aidlc-state.md`),
    marker = entries.get(`${root}/.aidlc-engine/active-directive.json`),
    file = entries.get(source.path);
  if (!file || file.role !== 'question' || !state || !marker) return null;
  let cursor;
  try {
    cursor = JSON.parse(marker.content);
  } catch {
    return null;
  }
  if (
    cursor.version !== 2 ||
    cursor.kind !== 'run-stage' ||
    cursor.stage !== source.stage ||
    (cursor.unit ?? null) !== source.unit ||
    cursor.cursor_harness !== harness ||
    cursor.active_attempt?.status !== 'settled' ||
    state.sha256 !== binding.state ||
    [...state.content.toString().matchAll(/^- \*\*Current Stage\*\*: ([a-z][a-z0-9-]*)[ \t]*$/gm)]
      .map((m) => m[1])
      .join() !== source.stage ||
    !/^- \*\*Status\*\*: Running[ \t]*$/m.test(state.content.toString()) ||
    !state.content
      .toString()
      .split(/\r?\n/)
      .some((l) => l.startsWith(`- [-] ${source.stage} — EXECUTE`))
  )
    return null;
  return { file, cursorHash: marker.sha256, parsed: parseQuestionFile(file.content) };
}
