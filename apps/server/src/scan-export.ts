import { open, type FileHandle } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import type { ReadStream as FileReadStream } from 'node:fs';
import { ZipFile } from 'yazl';
import {
  MAX_SCAN_EXPORT_BYTES,
  scanExportSchema,
  type Mode,
  type ScanExportSelection,
} from '@openwebprint/shared';
import type { Store, StoredJob } from './store.js';
import { expiry, retentionPolicy } from './retention.js';
import { AppError } from './errors.js';

// Fixed bounds per mode: at most two streaming exports and 50 open PDFs each.
const MAX_ACTIVE_EXPORTS = 2;
export const SCAN_EXPORT_TIMEOUT = 120_000;

export function scanArchiveName(job: Pick<StoredJob, 'id' | 'title'>) {
  const title = job.title
    .normalize('NFC')
    .replace(/\.pdf$/i, '')
    .replace(/[\p{Cc}\p{Cf}<>:"/\\|?*]/gu, '_')
    .replace(/^[. ]+|[. ]+$/g, '');
  let stem = '';
  for (const character of title) {
    if (Buffer.byteLength(stem + character) > 120) break;
    stem += character;
  }
  // The full immutable ID resolves collisions, including case-insensitive names,
  // independent of selection order. No source path is ever used in a ZIP name.
  return `${stem || 'scan'}-${job.id}.pdf`;
}
interface ExportOperation {
  controller: AbortController;
  done: Promise<void>;
  updateDeadline: () => void;
}
export class ScanExports {
  private operations = new Set<ExportOperation>();
  constructor(
    private store: Store,
    private mode: Mode,
    private locks: Set<string>,
  ) {}

  async create(selections: ScanExportSelection[], requestSignal?: AbortSignal): Promise<Readable> {
    // Validate here as well so non-HTTP callers cannot bypass count/duplicate bounds.
    scanExportSchema.parse({ scans: selections });
    if (this.operations.size >= MAX_ACTIVE_EXPORTS)
      throw new AppError(429, 'Two ZIP exports are already running. Wait for one to finish.');
    const controller = new AbortController();
    const handles: FileHandle[] = [];
    const inputs: FileReadStream[] = [];
    const locked: string[] = [];
    const jobs: StoredJob[] = [];
    let output: Transform | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const interrupted = () =>
      new AppError(410, 'ZIP export interrupted or expired. Refresh the selection and try again.');
    const operation: ExportOperation = {
      controller,
      done,
      updateDeadline: () => {
        clearTimeout(timer);
        const deadline = Math.min(
          started + SCAN_EXPORT_TIMEOUT,
          ...jobs.map((job) => expiry(job, retentionPolicy(this.store))),
        );
        if (deadline <= Date.now()) controller.abort(interrupted());
        else {
          timer = setTimeout(() => controller.abort(interrupted()), deadline - Date.now());
          timer.unref();
        }
      },
    };
    this.operations.add(operation);
    let cleaning: Promise<void> | undefined;
    const cleanup = () =>
      (cleaning ??= (async () => {
        clearTimeout(timer);
        requestSignal?.removeEventListener('abort', abortRequest);
        controller.signal.removeEventListener('abort', abort);
        for (const input of inputs) input.destroy();
        // FileHandle.close waits for pending reads, including on client disconnect.
        await Promise.allSettled(handles.map((handle) => handle.close()));
        for (const id of locked) this.locks.delete(id);
        this.operations.delete(operation);
        resolveDone();
      })());
    const abortRequest = () => controller.abort(interrupted());
    const abort = () => {
      output?.destroy(interrupted());
      // Preflight owns cleanup until it has finished opening handles. Its
      // awaits check the signal so cancellation cannot orphan a late-opened FD.
    };
    requestSignal?.addEventListener('abort', abortRequest, { once: true });
    controller.signal.addEventListener('abort', abort, { once: true });
    if (requestSignal?.aborted) abortRequest();
    operation.updateDeadline();
    try {
      // Acquire every document lock synchronously before any filesystem await.
      for (const selection of selections) {
        controller.signal.throwIfAborted();
        const job = this.store.job(selection.id, this.mode);
        if (!job || job.kind !== 'scan')
          throw new AppError(
            404,
            `Selected scan ${selection.id} was deleted or is unavailable in this mode. Remove it from the selection.`,
          );
        const label = `Scan “${job.title}” (${job.id})`;
        if (!job.hasFile || !job.filePath || expiry(job, retentionPolicy(this.store)) <= Date.now())
          throw new AppError(
            410,
            `${label} has expired or has no saved PDF. Remove it from the selection.`,
          );
        if (selection.revision !== (job.scanRevision ?? job.updatedAt))
          throw new AppError(
            409,
            `${label} has changed. Remove it from the selection and select it again.`,
          );
        if (this.locks.has(job.id) || job.status !== 'completed')
          throw new AppError(
            409,
            `${label} is busy. Wait for it to finish and refresh the selection.`,
          );
        this.locks.add(job.id);
        locked.push(job.id);
        jobs.push(job);
      }
      operation.updateDeadline();
      let total = 0;
      const sizes: number[] = [];
      for (const job of jobs) {
        controller.signal.throwIfAborted();
        const handle = await open(job.filePath!, 'r').catch(() => {
          throw new AppError(
            410,
            `Scan “${job.title}” (${job.id}) has a missing or unreadable PDF. Remove it from the selection.`,
          );
        });
        handles.push(handle);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size <= 0)
          throw new AppError(
            410,
            `Scan “${job.title}” (${job.id}) has no readable PDF. Remove it from the selection.`,
          );
        total += stat.size;
        if (total > MAX_SCAN_EXPORT_BYTES)
          throw new AppError(
            413,
            'Selected PDFs exceed the 100 MiB ZIP export limit. Select fewer scans.',
          );
        sizes.push(stat.size);
      }
      controller.signal.throwIfAborted();
      operation.updateDeadline();
      controller.signal.throwIfAborted();
      // Stream already-open, fixed-size PDFs with backpressure. No ZIP or PDF
      // is buffered in server memory or written to temporary disk storage.
      let bytes = 0;
      output = new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          // Stored entries have bounded UTF-8 names and a small ZIP header cost.
          if (bytes > MAX_SCAN_EXPORT_BYTES + 64 * 1024)
            callback(new AppError(413, 'ZIP export exceeded its size limit. Select fewer scans.'));
          else callback(null, chunk);
        },
      });
      const zip = new ZipFile();
      zip.on('error', () =>
        output!.destroy(
          new AppError(
            503,
            'A selected PDF could not be read. Refresh the selection and try again.',
          ),
        ),
      );
      output.on('error', () => {}); // Also safe if aborted immediately before HTTP send.
      output.once('close', () => {
        controller.abort();
        (zip.outputStream as Readable).destroy();
        void cleanup();
      });
      for (const [index, job] of jobs.entries()) {
        zip.addReadStreamLazy(
          scanArchiveName(job),
          {
            size: sizes[index],
            compress: false,
            mode: 0o100600,
            mtime: new Date(job.createdAt),
          },
          (callback) => {
            if (controller.signal.aborted) return callback(interrupted(), Readable.from([]));
            const input = handles[index].createReadStream({
              autoClose: false,
              start: 0,
              end: sizes[index] - 1,
            });
            inputs.push(input);
            callback(null, input);
          },
        );
      }
      zip.outputStream.on('error', () => output!.destroy(interrupted()));
      zip.outputStream.pipe(output);
      zip.end();
      return output;
    } catch (error) {
      await cleanup();
      if (error instanceof AppError) throw error;
      if (controller.signal.aborted) throw interrupted();
      throw new AppError(
        410,
        'A selected PDF is missing or unreadable. Refresh the selection and select the available scans again.',
      );
    }
  }
  retentionChanged() {
    for (const operation of this.operations) operation.updateDeadline();
  }
  async close() {
    const operations = [...this.operations];
    for (const operation of operations) operation.controller.abort();
    await Promise.all(operations.map((operation) => operation.done));
  }
}
