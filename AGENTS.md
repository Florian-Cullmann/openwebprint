# Project instructions

## Required GitHub workflow

Every project change must use a dedicated branch and a pull request, including work performed by coding agents. Keep the process lightweight and welcoming to external contributors.

- GitHub issues are mandatory for features, bug fixes, and significant refactoring.
- Issues are optional for minor documentation changes, formatting, routine dependency updates, and trivial maintenance.
- Reuse an applicable existing issue. Do not create unnecessary issues solely to satisfy the workflow.

1. Before implementation, find or create an issue when required. Keep its scope and intended outcome concrete; discuss large changes before starting them.
2. Work on a dedicated branch based on `main`. Include the issue number in the branch name when one applies and it is practical.
3. Run checks appropriate to the change, then commit and push the working branch.
4. Open a pull request and reference an existing issue when applicable. Use `Closes #123` when the PR resolves that issue. Describe the resulting behavior, meaningful validation, and remaining limitations. Include a screenshot of the actual implemented result as **Proof of Done** whenever possible; this requirement also applies to maintainers and coding agents. If a screenshot is not meaningful or cannot be captured, explicitly explain why in the PR and provide alternative verification evidence. Follow the screenshot guidance in [CONTRIBUTING.md](CONTRIBUTING.md); screenshots do not replace required checks.
5. Changes reach `main` through a pull request. Do not commit or push directly to `main`, including for small fixes or documentation-only changes.

Routine dependency-bot pull requests can proceed without a separate issue. For security vulnerabilities, follow the private reporting process in [SECURITY.md](SECURITY.md); do not publish sensitive details merely to create a public issue.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and validation guidance. Report the pull request link and any applicable issue link when handing off completed work.
