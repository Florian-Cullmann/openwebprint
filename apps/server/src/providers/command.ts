import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError } from '../errors.js';
const execute = promisify(execFile);
export type Command = (executable: string, args: string[], timeout?: number) => Promise<string>;
export const command: Command = async (executable, args, timeout = 20_000) => {
  try {
    const { stdout } = await execute(executable, args, {
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
      shell: false,
    });
    return stdout;
  } catch (error) {
    const e = error as { code?: string; killed?: boolean; stderr?: string };
    if (e.code === 'ENOENT')
      throw new AppError(503, `${executable} is not installed. Check the hardware configuration.`);
    if (e.killed)
      throw new AppError(504, `${executable}: operation timed out. Check the device connection.`);
    // stderr may contain device addresses; it is deliberately not returned to clients.
    throw new AppError(
      502,
      `${executable} could not complete the operation. Check connectivity, permissions and device options.`,
    );
  }
};
