import { fromBuffer } from 'yauzl';
import { buffer } from 'node:stream/consumers';

export function readArchive(data: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    fromBuffer(data, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error);
      const entries = new Map<string, Buffer>();
      zip.on('error', reject);
      zip.on('end', () => resolve(entries));
      zip.on('entry', (entry) =>
        zip.openReadStream(entry, async (error, stream) => {
          if (error || !stream) return reject(error);
          try {
            entries.set(entry.fileName, await buffer(stream));
            zip.readEntry();
          } catch (error) {
            reject(error);
          }
        }),
      );
      zip.readEntry();
    });
  });
}
