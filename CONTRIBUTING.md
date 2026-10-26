# Contributing to openwebprint

Useful, small contributions are welcome: a verified device report, a clearer error message, accessibility work, localization, or a new provider. Start with an issue for a large feature so we can agree on its scope.

## Local setup

Use Node 24 LTS or 26, then follow the [README](README.md#quick-start). Choose **Try demo** on the first-run screen to develop without hardware. The React frontend is in `apps/client`, Fastify in `apps/server`, and shared types/Zod schemas in `packages/shared`.

```sh
npm ci
cp .env.example .env
npm run dev
npm run check
npx playwright install chromium
npm run test:e2e
```

The browser tests start separate temporary servers for desktop and mobile, exercise the actual production frontend, and remove their private database afterward. Run `npm run build` before them. They intentionally verify uploads, downloads, persistence, navigation, mobile overflow, and serious/critical axe findings. They also verify the first-run choice, demo removal, and hardware setup without connecting physical devices. No print/scanner hardware is needed. Browser screenshots are written to `test-results/`, not the public README gallery.

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
4. Ensure `npm run check` passes; run browser tests when changing user journeys.
5. Disclose any new dependency, license constraint, or platform-specific assumption.

By submitting a contribution, you agree to license your contribution under the project's [MIT license](LICENSE). Dependencies and bundled OS packages retain their own licenses. No CLA is required.

Be respectful and practical. Help other contributors reproduce problems, avoid personal attacks, and keep device reports free of private data. For vulnerabilities, follow [SECURITY.md](SECURITY.md) rather than a public issue.
