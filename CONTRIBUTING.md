# Contributing to openwebprint

Useful, small contributions are welcome: a verified device report, a clearer error message, accessibility work, localization, or a new provider. Every change uses a dedicated branch and a pull request, including work performed by coding agents.

## Required workflow

Issues are **mandatory for features, larger bug fixes, and significant refactoring**. They are **optional for small, obvious bug fixes, minor documentation changes, formatting, routine dependency updates, and trivial maintenance**. For a small, obvious bug fix, you can open a PR directly and describe the problem and fix there. Reuse an applicable existing issue; do not create unnecessary issues solely to satisfy the workflow. Small contributions should be easy to submit.

1. Find an existing issue or open one before implementation when required. Describe the problem, scope, and intended outcome. Discuss large changes before starting them.
2. Create a dedicated branch from `main`, including the issue number when applicable, such as `fix/42-scanner-discovery`. A descriptive branch name is sufficient when no issue applies.
3. Implement the change, run appropriate checks, then commit and push that branch.
4. Open a PR and reference an existing issue when applicable, using `Closes #123` when the PR resolves it. Include the resulting behavior, verification, and any limitations.
5. Integrate changes through the PR. **Do not commit or push directly to `main`**, even for small fixes or documentation changes.

Routine dependency-bot PRs can proceed without a separate issue. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), rather than disclosing sensitive details in a public issue. Repository instructions for coding agents are maintained in [AGENTS.md](AGENTS.md).

## Local setup

Use Node 24 LTS or 26, then follow the [source setup](README.md#run-from-source-development). Choose **Try demo** on the first-run screen to develop without hardware. The React frontend is in `apps/client`, Fastify in `apps/server`, and shared types/Zod schemas in `packages/shared`.

```sh
npm ci
cp .env.example .env
npm run dev
npm run check
npx playwright install chromium
npm run test:e2e
```

The browser tests start separate temporary servers for desktop and mobile, exercise the actual production frontend, and remove their private database afterward. Run `npm run build` before them. They intentionally verify uploads, downloads, persistence, navigation, mobile overflow, and serious/critical axe findings. They also verify the first-run choice, demo removal, and hardware setup without connecting physical devices. No print/scanner hardware is needed. Browser screenshots are written to `test-results/`, not the public README gallery.

## macOS discovery helper

The optional macOS Bonjour bridge lives in `scripts/macos/Discovery.swift`; `npm run build:discovery:macos` compiles it with the installed Apple SDK. CI compiles it on macOS and exercises its snapshot trust boundary in the backend tests on Linux. A compiler check or synthetic snapshot is not a physical discovery test. See [hardware.md](docs/hardware.md#automatic-device-discovery-with-docker-desktop-on-macos) to validate a live Bonjour advertisement through Docker and the UI.

## End-user packages

After `npm run build`, run `npm run package:release` and `npm run test:install` to build and exercise a release package for your OS/CPU. The smoke test installs into a disposable directory, starts real production servers on a temporary port, verifies native image processing and persistent data across updates, then stops/removes the installation. It does not change your launchers or login startup. The installer CI additionally creates/removes OS shortcuts in its disposable runner account and builds all four Linux/macOS targets. See [installation and releases](docs/installation.md#maintainer-release-process) for the supported platform boundary, runtime pin, and tag-based publishing process.

## README screenshots

Run `npx playwright install chromium` once, then `npm run screenshots` to rebuild the app and capture the three README images in `docs/images/`. The script starts a disposable instance on a random loopback port, explicitly chooses demo mode, captures the actual UI at 1440 × 1000, and removes its temporary data afterward. It never uses your running instance, accounts, or hardware. Review all three images before committing them alongside any caption changes.

## Design and architecture

- Use **React + TypeScript**. Style with CSS Modules and shared CSS variables; no Tailwind, Vue, or Laravel.
- Keep the interface focused on user tasks; don't expose protocol detail unless it helps make a choice.
- Preserve responsive layouts, light/dark themes, keyboard focus, explicit errors, and empty/loading states.
- Read [docs/providers.md](docs/providers.md) before extending hardware behavior.
- Keep protocol code inside providers and validation at the API boundary. Use established libraries/tools rather than implementing device protocols.
- Hardware providers must never substitute simulated output. Unknown states must remain unknown.
- Use argument-array process execution without a shell. Never interpolate an uploaded filename or device advertisement into a command string.
- Keep credentials, document data, and raw command stderr out of logs and API errors.

## Tests that earn their place

Add tests for behavior that could cause a real regression: authorization bypass, unsafe input, incorrect protocol/state mapping, lost jobs, corrupted PDFs, duplicate operations, or a broken user journey. Avoid tests that merely restate a type, assert CSS class names, or mirror an implementation. Use the narrowest useful checks first.

Tests with a stubbed provider/transport must say so. A passing test fixture is not a physical compatibility certification. Prefer redacted captured protocol fixtures or isolated local protocol servers when useful. Never make CI depend on your LAN printer.

## Pull requests

1. Explain the concrete problem and resulting behavior.
2. Keep the change scoped; include relevant verification and any remaining limitations.
3. Update documentation for configuration, user-facing changes, and device support.
4. Run `npm run check` for code changes and browser tests when changing user journeys. For documentation-only changes, check formatting, links, and the diff; application tests are unnecessary when runtime behavior is unchanged.
5. Include a screenshot as **Proof of Done** in the PR whenever possible. This is a requirement for everyone, including maintainers and coding agents. Capture the actual implemented result, especially for UI changes, and embed or attach the image with a short caption explaining what it verifies. Use before/after screenshots when they help demonstrate a fix. Do not use mockups as completion evidence or expose credentials, personal data, or private documents; use safe sample data.
6. If a screenshot cannot meaningfully demonstrate the change or cannot be captured, explicitly explain why in the PR's **Proof of Done** section and provide the relevant alternative evidence (for example, focused test results). Do not silently omit this section. Screenshots supplement rather than replace required checks.
7. Disclose any new dependency, license constraint, or platform-specific assumption.

By submitting a contribution, you agree to license your contribution under the project's [MIT license](LICENSE). Dependencies and bundled OS packages retain their own licenses. No CLA is required.

Be respectful and practical. Help other contributors reproduce problems, avoid personal attacks, and keep device reports free of private data. For vulnerabilities, follow [SECURITY.md](SECURITY.md) rather than a public issue.
