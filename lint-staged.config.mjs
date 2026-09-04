// Lint-staged configuration.
//
// Only commands that are *always* available via npm devDependencies live here:
//   - oxfmt + oxlint for JS/TS
//   - secretlint for any staged file
//
// Commands that depend on system binaries or external state (terraform, tflint,
// tsc against an uninstalled frontend, semgrep/opengrep) are handled in
// .husky/pre-commit with explicit "command -v" guards so a missing tool
// silently skips instead of breaking the commit.
export default {
  '*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}': ['oxfmt --check', 'oxlint'],
  '*': 'secretlint',
};
