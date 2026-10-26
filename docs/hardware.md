# Hardware guide

openwebprint talks to **CUPS** for printing and **SANE** for scanning. The application does not contain proprietary device SDKs. Hardware support depends on the model, firmware, enabled protocols, host drivers, and network.

## Brother from day one

Brother is supported through the same open standards as other manufacturers:

| Device capability                  | Print path                                | Scan path              |
| ---------------------------------- | ----------------------------------------- | ---------------------- |
| IPP Everywhere / AirPrint + eSCL   | CUPS `everywhere`                         | sane-airscan eSCL      |
| IPP Everywhere / AirPrint + WSD    | CUPS `everywhere`                         | sane-airscan WSD       |
| Older CUPS/SANE-compatible model   | Existing queue with an appropriate driver | Installed SANE backend |
| Unsupported proprietary-only model | No automatic fallback                     | No simulated success   |

For example, the upstream sane-airscan compatibility list includes Brother MFC-L2750DW with eSCL and WSD, MFC-L2700DW with WSD, and ADS-2700W with WSD. These are **upstream reports**, not certifications from openwebprint. The Brother pair in demo mode is a simulation, not evidence of a hardware test.

Check the [sane-airscan compatibility list](https://github.com/alexpevzner/sane-airscan#compatibility) and your device's manual. Enable AirPrint/IPP, eSCL, or WSD scan in the device's web interface where supported. Wi-Fi Direct, guest Wi-Fi isolation, VPNs, and different VLANs can prevent discovery.

The Docker image includes the open-source `printer-driver-brlaser` package for some older monochrome Brother models. It is **not** automatically selected: automatic creation uses the CUPS `everywhere` model. For legacy devices, configure a queue with an installed suitable driver outside the app, then import it. Vendor Brother `brscan` packages are not bundled; install them on a native host only if your particular model needs them and you accept their licensing. Driverless devices need none of these packages.

## Hardware validation

Brother DCP-L2620DW: real Bonjour discovery and printing were confirmed during development, including a user-observed printed page. SANE successfully queried its eSCL scan options over both HTTP and HTTPS. Physical page scanning has not yet been confirmed for this model. These observations do not certify other models or firmware versions.

## Printers

1. Choose **Start setup** on a fresh installation, or **Remove demo data** in the demo banner. Select discovered devices, or add their addresses manually. The Docker hardware profile provides Linux host networking; it does not bypass the browser setup choice.
2. Open **Devices → Add device → Discover devices**.
3. Discovery lists existing CUPS queues and `_ipp._tcp` / `_ipps._tcp` mDNS advertisements. SANE scanners appear separately.
4. Add a device. New IPP devices are probed/configured with `lpadmin -m everywhere`. A failure is returned as an error and does not become a pretend device.
5. Alternatively enter an address manually:

```text
ipp://192.168.1.50:631/ipp/print
ipps://printer.example.lan:631/ipp/print
cups://Brother_Office
```

The precise path comes from the printer's manual or its mDNS `rp` record; `/ipp/print` is common but not universal. Only `ipp://` and `ipps://` URIs without embedded credentials, query strings, or fragments are accepted for new queues. Existing local queue names must contain only letters, digits, `_`, `.`, or `-`, and cannot start with `-`.

On a native host, verify CUPS first:

```sh
lpstat -h localhost:631 -r
lpstat -h localhost:631 -v
lpoptions -h localhost:631 -p YOUR_QUEUE -l
```

If queue creation requires administrator authentication, create the queue using your operating system's printer settings, and import `cups://YOUR_QUEUE`. openwebprint does not store CUPS admin passwords. Remote CUPS authentication, Unix socket targets, raw port 9100, and LPD URLs are not accepted directly by the MVP. They can be configured behind an existing local CUPS queue where appropriate.

CUPS must report at least one supported A4/A5/Letter media size for printing to be enabled. Color and duplex are checked from IPP capabilities. A paused queue appears offline/held; a ready queue is the scheduler's report, not a physical device probe. This prevents inventing consumable levels or network reachability.

Removing a device does not delete CUPS configuration or external jobs. This also applies to `owp_…` queues that openwebprint originally created. Reimport an existing queue from discovery rather than creating duplicates for the same physical printer. Separate printer and scanner entries are intentional for multifunction devices.

## Scanners

SANE uses backend-specific device identifiers, not generic printer IPP addresses.

```sh
scanimage -L
scanimage --formatted-device-list='%d\t%v %m%n'
scanimage --device-name 'airscan:e0:Brother MFC-L2750DW' --all-options
```

Copy the exact identifier from your own system into the manual scanner form. Do not copy an example identifier and assume it matches your machine.

- `sane-airscan` discovers eSCL and WSD devices. Some Brother scanners expose WSD only.
- Manually configured airscan devices belong in `/etc/sane.d/airscan.conf`; consult the [upstream documentation](https://github.com/alexpevzner/sane-airscan).
- Native backend packages may use different names such as `brother4:…`.
- Scanner status is **Not checked** until a scan actually accesses the backend. Discovery does not prove the scanner is currently reachable.
- The MVP requests one PNG via `scanimage`, then embeds it into an A4 PDF, preserving aspect ratio. It does not batch pages or choose an ADF source; the backend's default source applies.
- 150, 300, and 600 dpi and `Color` / `Gray` are available choices. The SANE backend is authoritative: unsupported combinations fail explicitly. Mono-only/lineart-only devices may require a future capabilities adapter.
- Only one scan per configured scanner ID runs at once. A scan times out after 120 seconds. Closing the UI does not cancel it.

For USB devices, the host must expose them through a working CUPS/SANE installation. Docker Compose deliberately does not mount `/dev` wholesale or use `privileged: true`.

## Docker networking

On **macOS**, first enable **Docker** under **System Settings → Privacy & Security → Local Network**. Without this permission, Docker Desktop cannot connect to LAN printers even if the Mac itself can reach them. See [Docker's troubleshooting guide](https://docs.docker.com/desktop/troubleshoot-and-support/troubleshoot/topics/#containers-cant-reach-devices-on-my-local-network). The permission takes effect without restarting Docker.

This permission allows direct device connections; it does not guarantee multicast discovery through Docker's bridge. If discovery remains empty, use the macOS helper below for automatic printer discovery, or **Add manually** with the printer's IPP address (for example, `ipp://192.168.1.50:631/ipp/print`; confirm the path/port in the device's manual or network advertisement), or use a native installation / Linux host networking. A printer already installed in macOS is not automatically installed in the container's separate CUPS scheduler.

The hardware Compose profile targets **Linux** and uses host networking so link-local multicast can work. The application itself binds to `127.0.0.1:3001`, CUPS to `127.0.0.1:631`. A local reverse proxy can expose the web app with TLS. Never expose the container's CUPS policy on a public interface: it intentionally trusts local clients inside this dedicated scheduler boundary.

The container starts its own private D-Bus and Avahi processes without mounting the host's D-Bus socket. An existing host mDNS daemon or CUPS scheduler can conflict. If port 631 is in use, prefer a native application installation using the host's existing scheduler. You can also run the image in bridge networking and manually add reachable printer IPs, but automatic discovery may be incomplete. Docker Desktop host networking differs from native Linux networking; eSCL/WSD and mDNS may require a real Linux host.

### Automatic device discovery with Docker Desktop on macOS

Use the optional host helper when the container cannot receive Bonjour multicast. It uses Apple's **Network.framework** (`NWBrowser`, TXT records, and service resolution) to discover actual IPP/IPPS and eSCL advertisements on the Mac. It does not import your installed printer list. A TCP connection resolves each advertised printer or scanner service to an IPv4 address usable inside Docker; no print data is sent. IPP/IPPS advertisements with the same device UUID appear once, preferring IPPS.

Requires Node 24/26 and Xcode Command Line Tools on the Mac (`xcode-select --install` if missing). From the repository root, keep this command running in a terminal:

```sh
npm run discovery:macos
```

In another terminal, start the bridge profile with the macOS override:

```sh
docker compose -f compose.yaml -f compose.macos.yaml --profile demo up --build -d
```

Open **Search again** in setup or Devices. A successful host search is labeled **Network discovery via macOS Bonjour.** Devices are candidates for you to select; finding them does not configure a CUPS queue, print or scan a document. Existing instance data and CUPS volumes are retained.

The helper must keep running alongside Docker. It atomically refreshes `.local/discovery/devices.json` every 10 seconds; Docker mounts only that folder, read-only. No extra HTTP port, API key, host D-Bus socket, or Docker socket is used. The inventory contains device names, addresses, and locations and is readable by local users so the container's unprivileged user can consume it. Do not put credentials or documents there. Results expire after 30 seconds if the helper stops; a clean Ctrl+C removes its snapshot immediately. The API rejects oversized, malformed, expired, future-dated, or unsafe snapshots. No addresses from your development network belong in the repository.

The bridge also browses `_uscan._tcp` / `_uscans._tcp`. Discovered scanners use sane-airscan’s direct `airscan:escl:NAME:URL` format so the container can probe and scan them without receiving the host’s multicast. Add a scanner separately under Devices, or use **Find and add a scanner** in the Scan dialog. The backend probes its actual options before accepting it. WSD-only scanners still need SANE discovery or explicit configuration; the Bonjour helper does not implement WS-Discovery. IPv6-only services are not currently exported because link-local interface scopes do not carry across the Docker boundary. For a Linux server, use the existing host-network profile without this helper.

To stop using the helper, stop it with Ctrl+C and recreate the service with the base Compose file only. Keep using both `-f` arguments when restarting the bridged setup. Rebooting the Mac requires restarting the helper; it does not install a login item or system daemon.

Named volumes retain `/etc/cups` and the CUPS spool. To supply custom SANE configuration, mount a specific trusted configuration file read-only. Back up volumes before changing them. Do not mount a user's whole home directory or the host Docker socket.

## Troubleshooting

| Symptom                                   | Check                                                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Device never appears                      | Same subnet, multicast enabled, guest-network isolation, VPN, Avahi, device protocol settings            |
| Mac can reach a printer but Docker cannot | Enable Docker's macOS Local Network permission; check VPN/firewall rules for Docker Desktop              |
| Printer is found but cannot be added      | Exact IPP path, IPP Everywhere support, CUPS queue-creation rights                                       |
| No selectable paper size                  | IPP capabilities unavailable or missing standard A4/A5/Letter media; inspect CUPS queue configuration    |
| Queue is ready but no page comes out      | Physical network/device state, paper, CUPS backend errors; queue readiness is not a ping                 |
| Print status is unknown                   | CUPS unavailable, response lost, or history purged; check queue before resubmitting to avoid duplicates  |
| Scanner is found but fails                | `scanimage --all-options`, supported mode/resolution, device permissions, firewall and eSCL/WSD settings |
| `lp` / `scanimage` is missing             | Install CUPS client tools / sane-utils on the server; demo mode does not need them                       |
| Browser write gets 403                    | `APP_ORIGIN` must exactly match the browser origin; proxy must preserve `Origin`                         |
| Login cookie is not stored                | `COOKIE_SECURE=true` requires HTTPS; align configuration and browser URL                                 |

Child process errors returned by the API omit raw stderr to avoid exposing local paths/addresses. Inspect CUPS logs (`journalctl -u cups` on many Linux systems) or run the relevant diagnostic commands yourself. Do not post scans, passwords, session cookies, or unredacted network details in public issues.

## Report a tested device

Please open a device compatibility issue with model, firmware, OS, CUPS/SANE versions, protocols, whether printing/scanning worked, and any tested options. State whether a result came from real hardware or demo. Include redacted diagnostics only. Successful hardware reports and failed-device reports are both useful.

References: [CUPS lp](https://openprinting.github.io/cups/doc/man-lp.html), [CUPS lpadmin](https://openprinting.github.io/cups/doc/man-lpadmin.html), [SANE scanimage](https://sane-project.gitlab.io/website/man/scanimage.1.html), [sane-airscan](https://github.com/alexpevzner/sane-airscan).
