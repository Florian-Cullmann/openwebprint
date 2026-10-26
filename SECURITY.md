# Security policy

This is an early self-hosted project. Only the latest `main` / current release is maintained. Do not expose a development server or hardware daemon directly to the internet.

## Report a vulnerability

Use the repository's **Security → Report a vulnerability** private reporting flow if enabled. If unavailable, contact the maintainer through the contact details on their GitHub profile and request a private reporting channel. Do not publish exploit details, credentials, scans, or an unpatched authorization bypass in a public issue.

Include affected revision, reproduction steps using synthetic documents, impact, and a suggested fix if available. There is no paid bug-bounty program or promised response SLA.

## Trust model

- All users are trusted administrators. They can manage accounts, print to and scan from LAN devices, configure local CUPS queues and writable server scan storage, and access all instance documents. Per-user document isolation and roles are not implemented.
- New instances have no users and are intentionally open without login. Anyone who can reach an instance with no users can use its API and create the first account. Adding the first user immediately protects the API and enables login; only authenticated users can create subsequent accounts. Deleting the last user reopens the instance. Origin/header checks remain active in both modes. Sessions expire after seven days, are bound to a user, and store only token hashes; passwords use salted scrypt. Deleting a user revokes their sessions. Existing legacy passwords are migrated without silently disabling authentication.
- The web process is unprivileged in the Docker image. The container starts CUPS, Avahi, and D-Bus as system services. Its CUPS policy trusts loopback clients and must never be rebound/exposed to an untrusted interface. Linux host-networking also includes local host processes in that loopback trust boundary.
- Browser mutations require an application header and a matching Origin when present. CORS is not enabled. Non-browser clients may omit Origin but must supply the application header and authenticate when users exist.
- Auth and mutation endpoints are rate-limited. Proxy headers are not trusted by default.
- File types are checked against magic bytes and decoded. Images have a pixel limit; PDFs reject encryption, corruption, empty files, and more than 500 pages. Documents are rebuilt and page annotations removed. These checks are **not a malware scanner or complete PDF sandbox**. Only upload documents you trust; CUPS filters and image/PDF libraries remain security-sensitive dependencies.
- Commands use `execFile`, validated argument values, no shell, and bounded time/output. Network device discovery records are untrusted. Hardware addresses intentionally allow connections to the administrator's LAN through CUPS/SANE.
- Scan storage is a trusted administrator setting: the app checks an absolute server path with a temporary write probe. Restrict filesystem permissions and Docker mounts to suitable locations. Existing scans keep their recorded paths when the root changes. SQLite and scans are not encrypted at rest. Restrict host/backup access, use filesystem encryption where needed, and deploy HTTPS with secure cookies for network access.
- Demo mode is an explicit first-run choice and never contacts hardware. Removing it waits for running demo work before deleting demo records and their referenced files; accounts and hardware data are preserved.
- Print files are deleted after submission attempts; CUPS maintains a separate spool. Scan files expire after seven days (startup/hourly sweep) or manual deletion. Deletion does not securely erase backups or filesystem snapshots.

For a shared or hostile environment, add operating-system isolation, storage quotas, firewall restrictions, hardened document processing, and an appropriate reverse proxy. The project does not claim multi-tenant isolation.
