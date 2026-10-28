# Self-hosting openwebprint

[Back to the README](../README.md) · [Packaged installation](installation.md) · [User guide](usage.md)

This guide covers source and Docker deployments of the current `main` branch. For packaged application updates, logs, and removal, use the [installation guide](installation.md).

## Production without Docker

Use a [source checkout](../README.md#run-from-source-development) with Node.js 24 LTS or 26 and a configuration copied from `.env.example`.

```sh
npm ci
npm run build
# In .env, set APP_ORIGIN=http://localhost:3001 for local HTTP.
# For HTTPS, use your deployed origin and COOKIE_SECURE=true.
# Load your deployment configuration, then:
node --env-file=.env apps/server/dist/index.js
```

Run from the repository root: Fastify serves the compiled React app and API on the same port. In production set `APP_ORIGIN=http://localhost:3001` for local HTTP, or your actual HTTPS origin behind a reverse proxy. Do not run the Vite development server as a production server.

## Docker quick start

```sh
docker compose --profile demo up --build -d
docker compose logs demo
```

Open **http://localhost:3001** and choose a setup method. The port is bound to loopback by default. Stop with `docker compose --profile demo down`. Named volumes retain accounts, devices, and job history.

## Real printers and scanners

For a native Linux deployment, install CUPS, SANE, and sane-airscan, then choose **Start setup** in the browser (or **Remove demo data** if you tried the demo). On Debian/Ubuntu:

```sh
sudo apt-get update
sudo apt-get install cups cups-client cups-filters sane-utils sane-airscan avahi-daemon
```

Install a model-specific driver only if required; see the [hardware guide](hardware.md). For packaged Linux/macOS installations, see the [guided hardware setup](installation.md#hardware-on-linux-and-macos) and its release boundary.

The operating-system CUPS administrator must permit the application service user to manage queues, or create queues in CUPS first and import them as `cups://QUEUE_NAME`. Existing queues work without granting queue-creation rights. Do not weaken a shared CUPS server's authentication to match the dedicated container configuration.

For the bundled **Linux Docker** hardware stack:

```sh
# Stop the bridge profile first: both profiles use port 3001.
docker compose --profile demo down
docker compose --profile hardware up --build -d
docker compose logs hardware
```

The profile runs CUPS and Avahi inside the container and drops the web process to the unprivileged `node` user. It uses Linux host networking for mDNS/eSCL/WSD. Port 3001 and the dedicated CUPS scheduler (631) bind to loopback. **Do not run it alongside a host CUPS scheduler already listening on 127.0.0.1:631.** Use a native install instead, or stop the conflicting scheduler deliberately. Port 5353 may also conflict with another mDNS daemon. See [hardware networking and troubleshooting](hardware.md).

The Compose profile controls **networking**, while the browser choice controls the application mode. The historically named `demo` profile uses bridge networking and can also connect manually addressed hardware. Both profiles start the hardware daemons so leaving the demo needs no container restart. They have **separate persistent data and CUPS volumes**, so changing profiles does not transfer accounts or devices. Within an instance, mode and setup progress are stored in SQLite; demo records never become real devices.

Docker Desktop on macOS does not reliably forward link-local discovery. Enable **Docker** under **System Settings → Privacy & Security → Local Network** before connecting LAN devices. If discovery remains empty, use a manual IPP address or run on a Linux host; see [Docker networking](hardware.md#docker-networking). USB passthrough is not configured by the Compose file. The native app can use devices already exposed by CUPS/SANE. Docker Desktop on Windows is not a supported deployment target.

For **automatic printer and eSCL scanner discovery on macOS with Docker Desktop**, run `npm run discovery:macos` on the Mac, then start Compose with `-f compose.yaml -f compose.macos.yaml --profile demo`. The optional native Bonjour helper passes current network advertisements into the container through a read-only folder. See the [macOS discovery setup](hardware.md#automatic-device-discovery-with-docker-desktop-on-macos) for prerequisites, commands, and scanner limitations.

## Configuration

| Variable              | Default                 | Purpose                                                                                                                                       |
| --------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `MODE`                | unset                   | Legacy upgrade hint only; new installations choose their mode in the browser                                                                  |
| `HOST`                | `127.0.0.1`             | HTTP bind address; image defaults to `0.0.0.0`, hardware profile overrides to loopback                                                        |
| `PORT`                | `3001`                  | HTTP port                                                                                                                                     |
| `APP_ORIGIN`          | `http://localhost:5173` | Exact allowed browser origin; set to your deployed URL                                                                                        |
| `DATA_DIR`            | `./data`                | SQLite, sessions, and private scan storage                                                                                                    |
| `COOKIE_SECURE`       | `false`                 | Set `true` with HTTPS                                                                                                                         |
| `HOST_DISCOVERY_FILE` | unset                   | Optional absolute path to a macOS Bonjour snapshot; see [host discovery](hardware.md#automatic-device-discovery-with-docker-desktop-on-macos) |
| `CUPS_SERVER`         | `localhost:631`         | Local scheduler only: localhost, 127.0.0.1, or [::1], optionally with port                                                                    |

For LAN or internet access, put a reverse proxy on the same host in front of loopback port 3001, terminate TLS, set `APP_ORIGIN=https://print.example.org` and `COOKIE_SECURE=true`. The proxy must preserve the `Origin` header and allow uploads of at least 25 MiB plus multipart overhead. No CORS wildcard is used. Request limits use the direct peer IP; the app intentionally does not trust arbitrary forwarding headers. A shared proxy therefore shares rate limits.

If a proxy returns an HTML, empty, or malformed error response, the interface shows the HTTP status (for example, `The request failed (HTTP 502).`) without displaying the proxy response body. Failed print and scan submissions are never automatically retried.

For Docker, export those two variables or put them in the root `.env`; Compose forwards them. Other settings require updating the service environment explicitly. Do not expose CUPS or SANE to an untrusted network. With no users, everyone who can reach the web app has full access; add a user before making the app accessible beyond a trusted environment.

## Storage, backups, and access recovery

- Original uploads are normalized to private PDFs. Print PDFs follow the instance retention policy (**7 days** by default), including unconfirmed submissions, or are removed when you delete the job. Draft previews are processed in memory and create no jobs or stored documents. CUPS has its own spool/history policy; the bundled configuration disables retained job files.
- Real scan storage defaults to `DATA_DIR/scans`. Choose an absolute server path during setup or change it under **Settings → General**. The app creates the folder and checks write access. Existing scans remain in their original location. Demo scans always use temporary instance storage.
- In Docker, paths refer to the container. `/data/scans` is covered by the named data volume. For another location, configure a bind mount and grant the `node` user write access; entering a host path alone does not mount it. Back up any external scan folders as well as `DATA_DIR`.
- Set separate scan and print PDF retention periods under **Settings → General → Document retention**. Both default to **7 days** on new and upgraded instances and accept **1–3650 whole days**; indefinite retention is not offered. Periods run from job creation, including for existing documents. Editing, cropping, reordering, appending pages, downloading, or polling a job does not reset its clock. Document and scan details show the effective expiry in your local time.
- Cleanup runs at startup and hourly in both modes, removing managed page images, previews, PDFs, and obsolete scan revisions from their original folders, including external scan folders. It waits for active scans/edits and queued/processing print jobs; unconfirmed print submissions can expire when no local operation is using them. Records remain after file expiry. A shorter policy requires confirmation if existing documents become eligible for deletion. Extending retention preserves files that have not yet been removed; it cannot restore deleted files. Delete a job to remove its files earlier. Click a document title in Jobs to reopen its preview. Older print jobs may have no retained document.
- Back up `DATA_DIR` and your CUPS configuration while the app is stopped. For Docker, back up the named volumes. Keep backups private; scans and personal metadata are not encrypted at rest.
- Multiple users are supported, all with the same administrator permissions. To reset access, stop the server and run `node --env-file-if-exists=.env scripts/reset-access.mjs --confirm`. This removes all users and sessions, preserving devices/documents. Restart to use the instance without signing in, then add users again in Settings. With Docker, stop the service first, then run `docker compose --profile demo run --rm --entrypoint node demo scripts/reset-access.mjs --confirm` (replace `demo` with `hardware` as appropriate).
