# Contributing Guidelines

Thank you for your interest in contributing to our project. Whether it's a bug report, new feature, correction, or additional
documentation, we greatly value feedback and contributions from our community.

Please read through this document before submitting any issues or pull requests to ensure we have all the necessary
information to effectively respond to your bug report or contribution.

## Reporting Bugs/Feature Requests

We welcome you to use the GitHub issue tracker to report bugs or suggest features.

When filing an issue, please check existing open, or recently closed, issues to make sure somebody else hasn't already
reported the issue. Please try to include as much information as you can. Details like these are incredibly useful:

- A reproducible test case or series of steps
- The version of our code being used
- Any modifications you've made relevant to the bug
- Anything unusual about your environment or deployment

## Pre-commit Hooks

This repo uses [Husky](https://typicode.github.io/husky/) and [lint-staged](https://github.com/lint-staged/lint-staged) for fast inner-loop checks before each commit:

```bash
npm install
```

The `prepare` script wires up the git hook automatically. The hook runs:

- `oxfmt --check` and `oxlint` on staged JS/TS files
- `secretlint` on every staged file
- `npm audit --omit=dev --audit-level=high` on root (and frontend if its `node_modules` exists)
- `tsc -b` on the frontend project if any frontend TS/TSX is staged and frontend deps are installed
- `terraform fmt -check` and `tflint` if any `.tf` is staged and the binaries are on `PATH`
- `semgrep` or `opengrep` SAST preview if either binary is on `PATH`
- `vitest run --changed` for affected unit tests

Every optional check (frontend, terraform, SAST) is **silently skipped** when its tool or dependency tree isn't available — the hook never blocks a commit because something isn't installed. CI is the enforcement layer (see [`.github/workflows/`](.github/workflows/)) and includes:

- `oxlint` + `oxfmt --check` (root + frontend)
- Frontend `tsc -b && vite build`
- Unit tests on Node 22 + 24
- [CodeQL default setup](https://docs.github.com/en/code-security/code-scanning/creating-an-advanced-setup-for-code-scanning/configuring-default-setup-for-code-scanning) for JS/TS SAST on every PR

To bypass the hook for a WIP commit, use `git commit --no-verify`.

### Optional local enhancements

If you want deeper local feedback before pushing, install any of the following on your `PATH`:

| Tool                            | What it adds                                                                                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `terraform`, `tflint`           | Format/lint checks on `.tf` (configured for AWS provider via `terraform/.tflint.hcl`)                                                                                             |
| `semgrep` or `opengrep`         | Fast SAST preview against `p/javascript` + `p/typescript` rule packs                                                                                                              |
| `checkov` or `tfsec`            | IaC security scanning — not wired into the hook today (the repo has known pre-existing findings tracked as a follow-up); run `checkov -d terraform` or `tfsec terraform` manually |
| `npm --prefix frontend install` | Enables frontend audit and type-check steps                                                                                                                                       |

Real SAST runs in CI via GitHub's [CodeQL default setup](https://docs.github.com/en/code-security/code-scanning/creating-an-advanced-setup-for-code-scanning/configuring-default-setup-for-code-scanning) on every PR — that is the enforcement layer. The CodeQL CLI takes 1–4 minutes per run, which is too slow for a pre-commit hook.

If you want a fast inner-loop preview locally, install [`semgrep`](https://semgrep.dev/) or [`opengrep`](https://github.com/opengrep/opengrep) on your `PATH`. The pre-commit hook detects them automatically and runs `p/javascript` + `p/typescript` rule packs against staged JS/TS files. If neither is installed, the SAST step is silently skipped — CodeQL still catches everything in CI.

## Contributing via Pull Requests

Contributions via pull requests are much appreciated. Before sending us a pull request, please ensure that:

1. You are working against the latest source on the _main_ branch.
2. You check existing open, and recently merged, pull requests to make sure someone else hasn't addressed the problem already.
3. You open an issue to discuss any significant work - we would hate for your time to be wasted.

To send us a pull request, please:

1. Fork the repository.
2. Modify the source; please focus on the specific change you are contributing.
3. Ensure local tests pass (`npm run test`) and the linter is clean (`npm run lint`).
4. Run the formatter (`npm run format`) so your changes match the repo style. CI runs `npm run format:check` and will fail on unformatted files. The pre-commit hook (see above) runs these automatically if installed.
5. Commit to your fork using clear commit messages.
6. Send us a pull request, answering any default questions in the pull request interface.
7. Pay attention to any automated CI failures reported in the pull request, and stay involved in the conversation.

GitHub provides additional document on [forking a repository](https://help.github.com/articles/fork-a-repo/) and
[creating a pull request](https://help.github.com/articles/creating-a-pull-request/).

## Finding contributions to work on

Looking at the existing issues is a great way to find something to contribute on. As our projects, by default, use the default GitHub issue labels (enhancement/bug/duplicate/help wanted/invalid/question/wontfix), looking at any 'help wanted' issues is a great place to start.

## Code of Conduct

This project has adopted the [Amazon Open Source Code of Conduct](https://aws.github.io/code-of-conduct).
For more information see the [Code of Conduct FAQ](https://aws.github.io/code-of-conduct-faq) or contact
opensource-codeofconduct@amazon.com with any additional questions or comments.

## Security issue notifications

If you discover a potential security issue in this project we ask that you notify AWS/Amazon Security via our [vulnerability reporting page](http://aws.amazon.com/security/vulnerability-reporting/). Please do **not** create a public github issue.

## Licensing

See the [LICENSE](LICENSE) file for our project's licensing. We will ask you to confirm the licensing of your contribution.
