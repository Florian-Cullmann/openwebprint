# Provider development

`apps/server/src/providers/types.ts` is the extension point. `Workspace` owns the persisted setup state, explicit demo/hardware choice, and transitions between them. `Service` owns persistence, mode isolation, file lifecycle, concurrency, and public job state. Providers own device discovery, backend configuration, actual execution, and status interpretation.

| Method                                | Contract                                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `discover()`                          | Return candidate `DeviceInput[]` plus partial-failure warnings; finding a device is not a successful health probe |
| `add(input, id)`                      | Validate/probe a target; return the configured device with a real backend target                                  |
| `inspect(device)`                     | Return available capabilities and truthful state; use `unknown` when unreachable/unconfirmed                      |
| `print(device, path, title, options)` | Submit the normalized PDF exactly once; return the external job ID                                                |
| `poll(job, device)`                   | Map backend state explicitly; never infer completion from disappearance                                           |
| `cancel(job, device)`                 | Ask the real backend to cancel; throw on rejection                                                                |
| `scan(device, outputPath, options)`   | Write one real PNG to the supplied private path or throw; respect timeouts                                        |

Real scan output uses a validated, writable absolute server root configured during setup or in Settings. Each job captures its paths when created; changing the root does not relocate existing files. Demo scans stay in instance storage.

## Adding an integration

1. Keep it in a separate provider module. Select it in the server factory through trusted startup configuration, never through arbitrary client-supplied executable names.
2. Reuse existing Zod/shared contracts where applicable. Extend those contracts and UI capabilities together if a new feature needs more than the standard paper/color/duplex model.
3. Use a maintained protocol library or system tool. `command.ts` uses `execFile` with no shell, output limits, locale stability, and timeouts. Validate addresses and generated queue names independently of escaping.
4. Add failure-path tests and fixtures for the actual library representation. IPP enum values may be decoded to strings (`completed`, `idle`), not numbers.
5. Document platform dependencies, licensing, privileges, network boundaries, and hardware verification status.

The current combined hardware provider delegates printing to CUPS and scanning to SANE. Only the demo provider generates output. Production code has no fallback to that provider. The server persists mode on every device and job and filters all lookups to the persisted active mode. Fresh installations seed nothing until the user explicitly chooses the demo. Removing demo data blocks new operations, drains running demo work, and deletes only demo records and their referenced files before starting hardware setup.

`cupsIpp()` queries the local scheduler; arbitrary client-controlled IPP hosts are not passed to the Node HTTP client. New printer URIs go to CUPS after validation; reaching LAN devices is an intentional administrator capability. Discovery advertisements are untrusted and must pass the same checks as manually entered addresses.

## Persistence and failures

The SQLite schema is managed in `store.ts` with `user_version=2`, WAL mode, parameterized statements, and a busy timeout. The version-2 migration preserves legacy credentials in the users table and revokes legacy sessions; new databases start without accounts. A future incompatible schema change must ship an explicit versioned migration; do not silently reinterpret existing JSON fields. Public job serialization strips internal file paths and external job IDs.

A print transport error can happen after the scheduler accepted a job. Store `unknown`, keep a clear error, and never retry automatically. Queued/processing scan jobs are marked failed after restart; interrupted unconfirmed print submissions remain unknown. Already submitted CUPS print jobs continue to be polled after restart.

Scanner concurrency is per configured device ID. Two aliases for the same physical scanner can bypass that logical lock; backends must still handle device-busy errors. Scan cancellation and distributed workers are outside the MVP.

## Verification boundaries

Unit/integration tests use injected command and IPP request functions. A local HTTP IPP fixture additionally exercises real library serialization/parsing. Browser tests use the explicit demo provider and real document conversion. CI container tests verify daemon startup without hardware. Only a report from an actual device should be described as hardware-tested.
