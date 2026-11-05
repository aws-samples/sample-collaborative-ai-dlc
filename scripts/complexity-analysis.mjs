import { createHash } from 'node:crypto';
import { ESLint } from 'eslint';
import sonarjs from 'eslint-plugin-sonarjs';
import config from '../eslint.complexity.config.mjs';
import { coverageChange, coverageRegressed } from './complexity-coverage.mjs';

export const complexityRule = 'sonarjs/cognitive-complexity';
export const complexityThreshold = config.find((entry) => entry.rules?.[complexityRule]).rules[
  complexityRule
][1];

const functions = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

function propertyName(node) {
  if (node.computed) return null;
  return node.key?.name ?? node.key?.value?.toString() ?? null;
}

function functionName(node) {
  const parent = node.parent;
  if (parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
    return parent.id.name;
  }
  if (['Property', 'MethodDefinition', 'PropertyDefinition'].includes(parent.type)) {
    const name = propertyName(parent);
    return name === null
      ? null
      : `${parent.static ? 'static ' : ''}${parent.kind ?? 'init'} ${name}`;
  }
  if (node.id) return node.id.name;
  if (parent.type === 'ExportDefaultDeclaration') return 'default';
  return null;
}

function functionIdentity(node) {
  const scope = [];
  let named = true;
  for (let current = node; current; current = current.parent) {
    if (functions.has(current.type)) {
      const name = functionName(current);
      scope.unshift(name ?? '<anonymous>');
      named &&= name !== null;
    } else if (['ClassDeclaration', 'ClassExpression'].includes(current.type)) {
      const name = current.id?.name ?? current.parent.id?.name;
      scope.unshift(`class ${name ?? '<anonymous>'}`);
      named &&= Boolean(name);
    } else if (['ObjectExpression', 'ArrayExpression'].includes(current.type)) {
      const parent = current.parent;
      const name = parent.type === 'VariableDeclarator' ? parent.id.name : propertyName(parent);
      scope.unshift(`object ${name ?? '<anonymous>'}`);
      named &&= Boolean(name);
    }
  }
  return { name: scope.join(' / '), identity: named ? JSON.stringify(scope) : null };
}

function describeFunction(node, sourceCode) {
  const tokens = [...node.params, node.body].flatMap((part) =>
    sourceCode.getTokens(part).map((token) => [token.type, token.value]),
  );
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([node.async, node.generator, tokens]))
    .digest('hex');
  return {
    ...functionIdentity(node),
    line: node.loc.start.line,
    column: node.loc.start.column + 1,
    start: node.loc.start,
    end: node.loc.end,
    score: 0,
    fingerprint,
  };
}

export function createAnalyzer(cwd) {
  return new ESLint({
    cwd,
    overrideConfigFile: true,
    overrideConfig: config,
    allowInlineConfig: false,
  });
}

export async function analyzeSource(cwd, filePath, source) {
  const measured = new Map();
  const sonarRule = sonarjs.rules['cognitive-complexity'];
  const measurementRule = {
    ...sonarRule,
    create(context) {
      let currentFunction;
      // Capture SonarJS's numeric result while it is visiting the function.
      // Diagnostic text is not a data API, and locations can be identical for
      // a computed method and a function expression used as its key.
      const reportingContext = Object.create(context, {
        report: {
          value(descriptor) {
            const fn = measured.get(currentFunction);
            const score = descriptor.data?.complexityAmount;
            if (
              !fn ||
              descriptor.messageId !== 'refactorFunction' ||
              !Number.isSafeInteger(score) ||
              score <= 0 ||
              fn.score !== 0
            ) {
              throw new Error(`${filePath}: unsupported SonarJS measurement`);
            }
            fn.score = score;
            fn.line = descriptor.loc.start.line;
            fn.column = descriptor.loc.start.column + 1;
            context.report(descriptor);
          },
        },
      });
      const visitors = sonarRule.create(reportingContext);
      if (!visitors[':function'] || !visitors[':function:exit']) {
        throw new Error('Unsupported SonarJS function visitors; check the pinned analyzer version');
      }
      return {
        ...visitors,
        ':function'(node) {
          measured.set(node, describeFunction(node, context.sourceCode));
          visitors[':function'](node);
        },
        ':function:exit'(node) {
          currentFunction = node;
          try {
            visitors[':function:exit'](node);
          } finally {
            currentFunction = undefined;
          }
        },
      };
    },
  };
  const eslint = new ESLint({
    cwd,
    overrideConfigFile: true,
    allowInlineConfig: false,
    overrideConfig: [
      ...config,
      {
        plugins: { measurement: { rules: { cognitive: measurementRule } } },
        rules: {
          [complexityRule]: 'off',
          'measurement/cognitive': ['warn', 0],
        },
      },
    ],
  });
  const [result] = await eslint.lintText(source, { filePath });
  if (result.errorCount) {
    throw new Error(
      `${filePath}: ${result.messages.map((message) => `${message.line ?? 1}: ${message.message}`).join('\n')}`,
    );
  }
  return [...measured.values()];
}

function groupBy(items, key) {
  const groups = new Map();
  for (const item of items) {
    const value = key(item);
    if (value === null) continue;
    const group = groups.get(value) ?? [];
    group.push(item);
    groups.set(value, group);
  }
  return groups;
}

function comparisonRow(old, next, kind) {
  return {
    path: next.path,
    line: next.line,
    function: next.name,
    previousPath: old?.path ?? null,
    previousLine: old?.line ?? null,
    before: old?.score ?? null,
    after: next.score,
    delta: old ? next.score - old.score : null,
    kind,
    coverage: {
      before: old?.coverage ?? null,
      after: next.coverage ?? null,
      change: coverageChange(old?.coverage, next.coverage),
    },
  };
}

const unchangedKey = (fn) =>
  JSON.stringify([
    fn.matchPath,
    fn.fingerprint,
    fn.score,
    fn.coverage?.status === 'measured' ? [fn.coverage.covered, fn.coverage.total] : null,
  ]);

export function compareFunctions(files, threshold = complexityThreshold) {
  const before = new Set(
    files.flatMap((file) =>
      file.before.map((fn) => ({ ...fn, path: file.previousPath, matchPath: file.path })),
    ),
  );
  const after = new Set(
    files.flatMap((file) =>
      file.after.map((fn) => ({ ...fn, path: file.path, matchPath: file.path })),
    ),
  );
  const matches = [];
  const matchUnique = (key) => {
    const oldGroups = groupBy(before, key);
    const newGroups = groupBy(after, key);
    for (const [identity, old] of oldGroups) {
      const next = newGroups.get(identity);
      if (old.length !== 1 || next?.length !== 1) continue;
      matches.push([old[0], next[0]]);
      before.delete(old[0]);
      after.delete(next[0]);
    }
  };
  matchUnique((fn) => (fn.identity === null ? null : JSON.stringify([fn.matchPath, fn.identity])));
  // Identical repeated callbacks need no individual identity to establish that
  // their complexity is unchanged. Cancel them by count within the same file.
  const oldBodies = groupBy(before, unchangedKey);
  for (const [key, next] of groupBy(after, unchangedKey)) {
    const old = oldBodies.get(key) ?? [];
    for (let index = 0; index < Math.min(old.length, next.length); index++) {
      before.delete(old[index]);
      after.delete(next[index]);
    }
  }
  // Unique, unchanged bodies recognize moves, renames, and shifted anonymous
  // callbacks. Changed anonymous functions deliberately remain unmatched.
  matchUnique((fn) => JSON.stringify([fn.fingerprint, fn.score]));

  const findings = [];
  const improvements = [];
  for (const [old, next] of matches) {
    if (next.score > threshold && next.score > old.score) {
      findings.push(
        comparisonRow(old, next, old.score <= threshold ? 'crossed-threshold' : 'increased'),
      );
    } else if (next.score > threshold && coverageRegressed(old.coverage, next.coverage)) {
      findings.push(comparisonRow(old, next, 'coverage-decreased'));
    }
    if (old.score > threshold && next.score < old.score) {
      improvements.push(comparisonRow(old, next, 'improved'));
    }
  }
  for (const next of after) {
    if (next.score > threshold) findings.push(comparisonRow(null, next, 'new-or-unmatched'));
  }
  findings.sort(
    (a, b) =>
      Number(coverageRegressed(b.coverage.before, b.coverage.after)) -
        Number(coverageRegressed(a.coverage.before, a.coverage.after)) ||
      (b.coverage.after?.uncovered ?? -1) - (a.coverage.after?.uncovered ?? -1) ||
      (b.delta ?? b.after) - (a.delta ?? a.after) ||
      a.path.localeCompare(b.path),
  );
  return { findings, improvements };
}

export function summarizeFunctions(entries, threshold = complexityThreshold) {
  return {
    functions: entries.length,
    maximum: Math.max(0, ...entries.map((fn) => fn.score)),
    aboveThreshold: entries.filter((fn) => fn.score > threshold).length,
  };
}
