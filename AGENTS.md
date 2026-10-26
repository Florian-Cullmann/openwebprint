# Project instructions

## Required GitHub workflow

Every project change must be tracked by a GitHub issue and delivered through a pull request. This applies to features, bug fixes, documentation, tests, refactoring, configuration, dependencies, and maintenance, including work performed by coding agents.

1. Find the relevant existing issue or create one before implementing a change. Keep its scope and acceptance criteria concrete; avoid duplicate issues.
2. Work on a dedicated branch based on `main`. Include the issue number in the branch name when practical.
3. Run checks appropriate to the change, then commit and push the working branch.
4. Open a pull request linked to the issue. Use `Closes #<number>` when the PR resolves it, or `Related to #<number>` for partial work. Describe the resulting behavior, meaningful validation, and remaining limitations.
5. Changes reach `main` through a pull request. Do not commit or push directly to `main`, including for small fixes or documentation-only changes.

Dependency-bot pull requests also need a linked tracking issue before merging. For security vulnerabilities, follow the private reporting process in [SECURITY.md](SECURITY.md); do not publish sensitive details merely to create a public issue.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and validation guidance. Report the issue and pull request links when handing off completed work.
