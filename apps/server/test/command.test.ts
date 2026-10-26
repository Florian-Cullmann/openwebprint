import { describe, expect, it, vi } from 'vitest';
import { command, CommandError } from '../src/providers/command.js';

const execute = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  return { execFile: Object.assign(() => {}, { [promisify.custom]: execute }) };
});

describe('command failure classification (stubbed process boundary)', () => {
  it('classifies SANE no-documents separately from transport failures (stubbed process)', async () => {
    execute.mockRejectedValue({ code: 7, stderr: 'private scanner address' });
    await expect(command('scanimage', [])).rejects.toMatchObject({ reason: 'no-documents' });
    await expect(command('another-tool', [])).rejects.toMatchObject({ reason: 'failed' });
    execute.mockRejectedValue({ code: 9, stderr: 'private scanner address' });
    await expect(command('scanimage', [])).rejects.toMatchObject({ reason: 'failed' });
  });
  it('recognizes only the exact empty CUPS destination result without exposing stderr', async () => {
    execute.mockRejectedValue({ code: 1, stderr: 'lpstat: No destinations added.\n' });
    await expect(command('lpstat', ['-h', 'localhost:631', '-v'])).rejects.toMatchObject({
      reason: 'empty-destinations',
    });
    expect(execute).toHaveBeenLastCalledWith(
      'lpstat',
      ['-h', 'localhost:631', '-v'],
      expect.objectContaining({
        shell: false,
        env: expect.objectContaining({ LANG: 'C', LC_ALL: 'C', LANGUAGE: 'C' }),
      }),
    );

    for (const stderr of [
      'lpstat: Scheduler is not running.',
      'lpstat: Forbidden: private-host.local',
      'lpstat: No destinations added.\nUnexpected error',
    ]) {
      execute.mockRejectedValue({ code: 1, stderr });
      try {
        await command('lpstat', ['-v']);
        expect.fail('Expected command failure');
      } catch (error) {
        expect(error).toBeInstanceOf(CommandError);
        expect(error).toMatchObject({ reason: 'failed', statusCode: 502 });
        expect((error as Error).message).not.toContain(stderr);
        expect(error).not.toHaveProperty('stderr');
      }
    }
    execute.mockRejectedValue({ code: 1, stderr: 'lpstat: No destinations added.' });
    await expect(command('lpstat', ['-p', 'missing'])).rejects.toMatchObject({ reason: 'failed' });
    await expect(command('another-tool', ['-v'])).rejects.toMatchObject({ reason: 'failed' });
  });
});
