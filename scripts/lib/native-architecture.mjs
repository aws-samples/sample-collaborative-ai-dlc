import { parse } from 'acorn';
import { createHash } from 'node:crypto';
import path from 'node:path';

const functions = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const decisions = new Set([
  'IfStatement',
  'ConditionalExpression',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
  'CatchClause',
]);
export const nativeArchitectureScope = (file) =>
  /^(lambda\/native-runtime-control\/|lambda\/agentcore\/native\/|lambda\/shared\/native-)/.test(
    file,
  ) ||
  [
    'lambda/intents/index.js',
    'lambda/intents/realtime-token.js',
    'lambda/agentcore/commands/run-stage.js',
    'lambda/shared/v2-process-store.js',
    'lambda/v2-orchestrator/index.js',
  ].includes(file);
export const productionSource = (file) =>
  file.startsWith('lambda/') &&
  /\.m?js$/.test(file) &&
  !/(^|\/)(test|tests|fixtures|node_modules|\.build|\.probe-build|\.repair-build)\//.test(file);

export const analyzeArchitectureSource = (file, source) => {
  const result = {
    file,
    sha256: createHash('sha256').update(source).digest('hex'),
    imports: [],
    functions: [],
    directWrites: [],
    dynamicEdges: [],
  };
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  const seen = new Map();
  const sdkNames = new Map();
  const name = (node, parent) =>
    node.id?.name ??
    (parent?.type === 'VariableDeclarator' ? parent.id.name : parent?.key?.name) ??
    '<anonymous>';
  const walk = (node, parent, owner) => {
    let current = owner;
    if (functions.has(node.type)) {
      const label = `${owner?.name ?? ''}/${name(node, parent)}`;
      const ordinal = (seen.get(label) ?? 0) + 1;
      seen.set(label, ordinal);
      current = {
        name: label,
        key: `${file}:${label}:${ordinal}`,
        score: 1,
        line: node.loc.start.line,
        lines: node.loc.end.line - node.loc.start.line + 1,
      };
      result.functions.push(current);
    }
    if (current && (decisions.has(node.type) || (node.type === 'SwitchCase' && node.test)))
      current.score++;
    if (
      ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) &&
      node.source
    ) {
      const target = node.source.value.startsWith('.')
        ? path.posix.normalize(path.posix.join(path.posix.dirname(file), node.source.value))
        : node.source.value;
      if (['@aws-sdk/lib-dynamodb', '@aws-sdk/client-dynamodb'].includes(target))
        for (const specifier of node.specifiers ?? [])
          sdkNames.set(specifier.local.name, specifier.imported?.name ?? '*');
      result.imports.push({
        target,
        names:
          node.type === 'ExportAllDeclaration'
            ? ['*']
            : node.specifiers.map((s) =>
                s.type === 'ImportNamespaceSpecifier'
                  ? '*'
                  : (s.imported?.name ?? s.local?.name ?? '*'),
              ),
      });
    }
    if (node.type === 'ImportExpression')
      result.dynamicEdges.push({
        line: node.loc.start.line,
        target: node.source.value ?? 'unresolved',
      });
    if (node.type === 'NewExpression') {
      const constructor =
        sdkNames.get(node.callee.name) ?? node.callee.name ?? node.callee.property?.name;
      if (
        /^(Put|PutItem|Update|UpdateItem|Delete|DeleteItem|TransactWrite|TransactWriteItems|BatchWrite|BatchWriteItem)Command$/.test(
          constructor ?? '',
        )
      )
        result.directWrites.push({ constructor, line: node.loc.start.line });
    }
    if (
      file === 'lambda/agentcore/commands/discussion-assist-start.js' &&
      node.type === 'CallExpression' &&
      ['property', 'addV', 'addE', 'drop'].includes(node.callee.property?.name)
    )
      result.directWrites.push({ constructor: 'QuorumGraphWrite', line: node.loc.start.line });
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'start', 'end'].includes(key)) continue;
      if (Array.isArray(value))
        value.forEach((child) => {
          if (child?.type) walk(child, node, current);
        });
      else if (value?.type) walk(value, node, current);
    }
  };
  walk(ast);
  return result;
};

export const checkArchitecture = (files, manifest, baseline) => {
  const errors = [];
  for (const file of files) {
    if (file.directWrites.some((write) => write.constructor === 'QuorumGraphWrite'))
      errors.push(`Quorum must submit results to the discussion owner: ${file.file}`);
    if (file.file.startsWith('lambda/native-runtime-control/')) {
      if (file.directWrites.length && !manifest.controlWriters.includes(file.file))
        errors.push(`Undeclared control writer: ${file.file}`);
    }
    // Check imports throughout production, including a bypass hidden in shared
    // helpers or a barrel export. Named read-only key helpers remain permitted.
    for (const edge of file.imports) {
      const names =
        edge.names.includes('*') && manifest.mutatorModules[edge.target]
          ? [manifest.mutatorModules[edge.target]]
          : edge.names;
      for (const factory of names.filter((name) => Object.hasOwn(manifest.mutatorFactories, name)))
        if (!manifest.mutatorFactories[factory].includes(file.file))
          errors.push(`Forbidden ${factory} import: ${file.file}`);
    }
    for (const edge of file.dynamicEdges) {
      const target =
        typeof edge.target === 'string' && edge.target.startsWith('.')
          ? path.posix.normalize(path.posix.join(path.posix.dirname(file.file), edge.target))
          : null;
      if (manifest.mutatorModules[target])
        errors.push(`Dynamic mutator import requires an explicit static boundary: ${file.file}`);
    }
    if (!nativeArchitectureScope(file.file)) continue;
    for (const fn of file.functions) {
      const legacy = baseline.functions[fn.key] ?? 20;
      const exception = manifest.complexityExceptions[fn.key];
      const ceiling = exception?.maximum ?? Math.max(20, legacy);
      if (fn.score > ceiling) errors.push(`Complexity ${fn.score} > ${ceiling}: ${fn.key}`);
    }
  }
  return errors;
};
