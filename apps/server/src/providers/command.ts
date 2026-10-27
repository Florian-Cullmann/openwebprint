import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError } from '../errors.js';
const execute = promisify(execFile);
export type Command = (executable: string, args: string[], timeout?: number) => Promise<string>;
export class CommandError extends AppError {
  constructor(
    message: string,
    readonly reason: 'empty-destinations' | 'no-documents' | 'failed' = 'failed',
  ) {
    super(502, message);
  }
}
export const command: Command = async (executable, args, timeout = 20_000) => {
  try {
    const { stdout } = await execute(executable, args, {
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, LANG: 'C', LC_ALL: 'C', LANGUAGE: 'C' },
      shell: false,
    });
    return stdout;
  } catch (error) {
    const e = error as { code?: string | number; killed?: boolean; stderr?: string };
    if (e.code === 'ENOENT')
      throw new AppError(503, `${executable} is not installed. Check the hardware configuration.`);
    if (e.killed)
      throw new AppError(504, `${executable}: operation timed out. Check the device connection.`);
    // CUPS exits with 1 for an empty destination list even when its scheduler is healthy.
    // Recognize only this exact result; connection and permission failures must stay visible.
    if (
      executable === 'lpstat' &&
      args.includes('-v') &&
      e.code === 1 &&
      e.stderr?.trim() === 'lpstat: No destinations added.'
    )
      throw new CommandError('No printers have been configured in CUPS.', 'empty-destinations');
    if (executable === 'scanimage' && e.code === 7)
      throw new CommandError('The document feeder is empty.', 'no-documents');
    // stderr may contain device addresses; it is deliberately not returned to clients.
    throw new CommandError(
      `${executable} could not complete the operation. Check connectivity, permissions and device options.`,
    );
  }
};
