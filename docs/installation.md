# Install openwebprint

The end-user package runs the production web application in your browser. It includes its own Node.js runtime and application libraries, including the native image-processing library. You do not install Node.js, npm, Git, Docker, a virtual machine, or a desktop web wrapper. Installation takes place in your user account and does not change your system Node.js or PATH.

**Current release:** [v0.1.0-beta.2](releases/v0.1.0-beta.2.md), the second public beta. The commands below pin this prerelease explicitly because GitHub’s `latest` endpoint selects stable releases. Downloads require the published installer assets; a source checkout alone is not an installer release.

## Supported systems

Windows is currently unsupported. Complete Windows installation, distribution, printing, and scanning are tracked in [#14](https://github.com/Florian-Cullmann/openwebprint/issues/14).

| System                    | Requirements                                                                                                                           | Real printers and scanners                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Linux x64 / arm64         | Desktop session; glibc 2.28+, kernel 4.18+; `curl`, `tar`, `ps`, `sha256sum` or `shasum`; `xdg-open` to open the browser automatically | CUPS/SANE; guided setup on Debian/Ubuntu (next release)              |
| macOS x64 / Apple Silicon | macOS 14 or newer                                                                                                                      | System CUPS; guided SANE setup with existing Homebrew (next release) |

Linux musl/Alpine and 32-bit systems are not supported by these packages. Linux x64 also requires SSE4.2. Platform requirements follow the bundled [Node.js runtime](https://github.com/nodejs/node/blob/v24.22.1/BUILDING.md#platform-list) and [sharp binaries](https://sharp.pixelplumbing.com/install/#prebuilt-binaries). The OS and CPU are selected automatically. Internet access is required to download the installer/package, but the application runs locally afterward. Allow room for the package, an installed copy, and an update staging copy, plus your documents. Updates temporarily keep the previous application files as well.

The package is a private application directory, not an operating-system sandbox. It runs with your user account's permissions. It does not include CUPS, SANE, vendor drivers, or a Linux environment.

## Linux and macOS

Open Terminal and paste these two lines. Run as your normal user, **without sudo**:

```sh
curl -fsSL https://github.com/Florian-Cullmann/openwebprint/releases/download/v0.1.0-beta.2/install.sh -o install-openwebprint.sh
OPENWEBPRINT_VERSION=v0.1.0-beta.2 sh install-openwebprint.sh
```

The installer downloads a release matching your computer, verifies its SHA-256 checksum before extracting/running it, configures local access, creates a launcher, enables startup at login, starts the application, and opens **http://127.0.0.1:3001**. The two downloads resolve to the same versioned release. You can inspect `install-openwebprint.sh` before running it.

- **Linux:** find **openwebprint** in your desktop's application menu. Login startup uses the standard XDG autostart directory.
- **macOS:** open **openwebprint** from your home folder's **Applications** directory. This small launcher opens your browser; it does not embed a browser. Login startup uses a per-user LaunchAgent.

To opt out of login startup, use `OPENWEBPRINT_VERSION=v0.1.0-beta.2 sh install-openwebprint.sh --no-autostart`. For a headless Linux machine or SSH session add `--no-open --no-shortcuts` to the version-pinned install command; start it yourself after a reboot. The default login hooks do not start a system service before login or automatically restart a crashed process.

## First launch

Choose **Try demo** to explore without hardware, or **Start setup** to check hardware prerequisites and connect real devices. Nothing is simulated in hardware mode. The default installation is accessible only from your computer. Closing the browser leaves the local server running. Clicking the application shortcut opens it again and starts the server if needed.

The URL uses `127.0.0.1` consistently for its origin and cookies. If port 3001 is already occupied, the installer explains the conflict instead of taking over another service. Choose another port with `OPENWEBPRINT_VERSION=v0.1.0-beta.2 sh install-openwebprint.sh --port 3002`. Use the URL printed by the installer afterward.

## Hardware on Linux and macOS

The guided hardware setup below is part of the **next release after v0.1.0-beta.2**. The currently published beta.2 installer still requires manual installation of hardware dependencies; rerunning that release does not add this new flow.

The new installer checks the CUPS print tools (`lp`, `lpadmin`, `lpstat`, `cancel`), scheduler access, configured printer search and SANE scanner search before opening the application. Missing software, unavailable services/backends, permission failures, timeouts and successful searches without devices have separate results. A successful check confirms software access, **not** physical compatibility or queue-creation permission. No print or scan is acquired during these checks.

It displays an OS change plan and asks for consent before installing packages or enabling services. Administrative commands may request your OS password; the application and its login startup continue to run as your normal user. Refusing a change or canceling authentication leaves an explicit unresolved requirement. Noninteractive installs never imply consent. The application can still open for demo mode or unaffected hardware functions; “running” does not mean hardware is ready.

- **Debian/Ubuntu with apt-get and systemd:** offers CUPS client/server, print filters, SANE utilities, sane-airscan and Avahi from configured OS repositories. A separate consent step enables/starts CUPS and Avahi. The package manager may install their dependencies. Vendor drivers are not installed speculatively.
- **macOS:** uses system CUPS and offers `brew install sane-backends` through an **existing** Homebrew installation. If CUPS is stopped, it offers enabling/starting the macOS CUPS service separately. Without Homebrew, it identifies that requirement and links to [Homebrew's official installation](https://brew.sh); no package manager is installed automatically. [sane-backends](https://formulae.brew.sh/formula/sane-backends) provides the SANE tools and available backends; installing it does not imply eSCL/WSD support for a particular device or compatibility with vendor-only macOS scanner drivers.
- **Other Linux distributions:** the application package remains usable with existing CUPS/SANE, but automatic OS changes are not supported. The installer explains the required CUPS, filters, SANE and discovery components to install with the distribution's software manager.

The onboarding screen shows live prerequisite results and the exact local **hardware** management command to reopen the guided flow in Terminal. After completing it, choose **Check prerequisites again** and **Search again**. The browser cannot install software or request administrator privileges. For example:

```sh
# Linux default installation
~/.local/share/openwebprint/openwebprint hardware
# macOS default installation
"$HOME/Library/Application Support/openwebprint/openwebprint" hardware
```

`hardware` exits with status 2 while checks remain unresolved and 0 when software checks pass. `--skip-hardware-setup` explicitly skips the install-time checks and OS changes (useful for unattended/demo installations); output records the skip, and onboarding still checks prerequisites. The launcher includes standard Homebrew binary directories, so login startup does not depend on an interactive shell profile. CUPS command locale is fixed even on localized macOS systems.

For the currently published beta.2, Debian/Ubuntu prerequisites can be installed manually:

```sh
sudo apt-get update
sudo apt-get install cups cups-client cups-filters sane-utils sane-airscan avahi-daemon
sudo systemctl enable --now cups avahi-daemon
```

If CUPS denies queue creation, add the printer in the OS **Printers & Scanners** / printer settings, then import its `cups://QUEUE_NAME` address. A scanner backend, USB/udev access, vendor driver or OS Local Network permission may still be device-specific requirements. The onboarding guidance names these OS boundaries and shows container advice only for container installations. See [hardware support and troubleshooting](hardware.md). Installing packages does not grant the web application administrative privileges or change CUPS access policy.

## Files, settings, and logs

| System | Installation directory                          |
| ------ | ----------------------------------------------- |
| Linux  | `${XDG_DATA_HOME:-~/.local/share}/openwebprint` |
| macOS  | `~/Library/Application Support/openwebprint`    |

Inside this directory:

- `app/`: replaceable application, private runtime, and dependency licenses.
- `config.json`: local port and optional `cupsServer` (defaults to `localhost:631`). Installer settings are separate from a development checkout's `.env`.
- `data/`: SQLite, accounts, sessions, uploaded documents, and default scan storage. Keep this private.
- `logs/server.log`: server startup and request logs. Stop the app before rotating or deleting this log.
- `openwebprint`: local management command.

Files are created with private permissions. External scan folders selected in the browser are outside `data/` and need their own backup. The application deliberately remains on loopback; use the [self-hosting instructions](../README.md#self-hosting) for a separately managed LAN/HTTPS deployment.

For example, manage the default installation locally with:

```sh
# Linux
~/.local/share/openwebprint/openwebprint status
~/.local/share/openwebprint/openwebprint stop
~/.local/share/openwebprint/openwebprint start
# macOS
"$HOME/Library/Application Support/openwebprint/openwebprint" status
```

Use `open` to start the server and open the browser. After editing `config.json`, run `stop` followed by `start`. Invalid ports are rejected. The `autostart` and `shortcuts` preferences are retained across installer updates; edit them in `config.json` and rerun the installer to re-enable a previously disabled option. Updating with `--no-shortcuts --no-autostart` removes this installation's existing menu and login entries as well as disabling their creation. Entries belonging to another installation directory are preserved.

A private loopback endpoint authenticates both control requests and responses. If the controller times out or returns an unexpected protocol/response, the launcher checks the saved PID and a public per-launch identifier against the OS process arguments using `ps`. State is discarded only when that launch no longer exists, including when its PID has been reused. A paused or busy application keeps its state and files; retry when it responds again. If process identity cannot be verified, recovery stops without removing state. The secret is never placed in process arguments, and the launcher never kills a process based only on a stored PID.

Startup writes the private controller state completely before publishing `running.json`, so launchers cannot read partially written JSON. Publication requires hard-link support within the installation directory (standard Linux/macOS filesystems support this) and refuses to overwrite an existing instance's state. Invalid existing state remains an explicit error; it is not silently treated as a stopped application.

## Updates and removal

**Before updating, stop openwebprint and back up `data/`, `config.json`, and any external scan folders.** Run the installation commands again to update. The installer stages the new application before stopping the current process, replaces only application files, preserves configuration and documents, and checks that the new server starts. If startup fails, inspect `logs/server.log`; `app.previous/` remains available for diagnosis. Database migrations can require the new version, so reverting application files alone is not a supported database rollback. Restore a matching backup if reverting an upgrade.

Use a specific release when needed:

```sh
OPENWEBPRINT_VERSION=v0.1.0-beta.2 sh install-openwebprint.sh
```

To uninstall, use the downloaded installer:

```sh
OPENWEBPRINT_VERSION=v0.1.0-beta.2 sh install-openwebprint.sh uninstall
```

This stops the server and removes the application, launcher, and login startup entry. **Configuration, documents, and logs remain.** To permanently remove them, delete the installation directory afterward; delete external scan folders separately only if you no longer need their contents. Reinstalling reuses the retained configuration and data.

For an installation without internet access, transfer the matching release `.tar.gz`, checksum, and installer package from a trusted computer, verify the checksum, extract it, then run its `runtime/node` with `scripts/install/manage.mjs`. Commands and options are the same as the shell installer. Use that extracted runtime for uninstall too. Custom locations use `--root /absolute/path`; supply the same location for subsequent installer operations. Install outside the downloaded/extracted package directory. Only one menu/login shortcut per user is supported.

## Maintainer release process

`npm run package:release` builds a package for the current OS/CPU after `npm run build`. It installs only production server dependencies using the committed npm lockfile, downloads the pinned Node.js runtime from nodejs.org, verifies its published SHA-256 checksum, and retains the Node/dependency licenses. It does not ship npm or build tools. Native dependencies are resolved on each target runner.

CI builds and smoke-tests all four Linux/macOS OS/CPU combinations, including a path containing spaces. The package test verifies real production assets, first-run demo setup, native image-to-PDF conversion, authenticated process control, port conflicts, restart, update with persistent data, reinstall, and uninstall. CI also creates/removes the native shortcuts in its disposable runner account. The initial packaged install also runs noninteractive prerequisite checks without OS changes; subsequent lifecycle checks explicitly skip them. Controlled OS fixtures exercise Linux/macOS missing/present software, consent refusal, package/service failures and recovery on all four CI runners. These are application/installation checks, not physical hardware tests or a reboot/login certification. Actual package-manager/service integration is exercised separately in disposable CI runners; see [hardware setup validation](validation/issue-72-hardware-setup.md).

To publish, prepare the root/workspace versions, lockfile, install commands, and release notes on a dedicated release branch. Merge its PR after checks pass, then push a matching version tag (for example, `v0.1.0-beta.2`) pointing to that tested `main` commit. The release workflow rebuilds and tests the four packages and publishes them with SHA-256 files and the shell installer. Tag/package versions must match. Publishing a prerelease does not replace GitHub's latest stable release: prerelease install commands must pin both the installer download URL and `OPENWEBPRINT_VERSION`. After the workflow publishes the assets, replace the generated release notes with the reviewed file under `docs/releases/`. Node runtime updates require changing the pinned version in `scripts/package-release.mjs`; rebuild every target and rerun the package checks.
