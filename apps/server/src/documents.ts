import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import { AppError } from './errors.js';

export const MAX_UPLOAD = 25 * 1024 * 1024;
export async function normalizeDocument(buffer: Buffer, claimedType: string): Promise<Buffer> {
  if (buffer.length === 0 || buffer.length > MAX_UPLOAD)
    throw new AppError(413, 'The file must be between 1 byte and 25 MB.');
  if (buffer.subarray(0, 5).toString() === '%PDF-') {
    if (claimedType !== 'application/pdf')
      throw new AppError(415, 'The file type does not match its contents.');
    try {
      const source = await PDFDocument.load(buffer, { updateMetadata: false });
      if (source.isEncrypted || source.getPageCount() === 0 || source.getPageCount() > 500)
        throw new Error('Unsupported PDF');
      // Copy only pages: do not carry document-level scripts, attachments or open actions.
      source.getForm().flatten({ updateFieldAppearances: false });
      const clean = await PDFDocument.create();
      const pages = await clean.copyPages(source, source.getPageIndices());
      pages.forEach((page) => {
        page.node.delete(clean.context.obj('Annots'));
        page.node.delete(clean.context.obj('AA'));
        clean.addPage(page);
      });
      return Buffer.from(await clean.save());
    } catch {
      throw new AppError(
        422,
        'The PDF is damaged, encrypted, has unsupported form fields or exceeds 500 pages.',
      );
    }
  }
  const png = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if ((!png && !jpeg) || claimedType !== (png ? 'image/png' : 'image/jpeg'))
    throw new AppError(415, 'Only valid PDF, PNG and JPEG files are allowed.');
  try {
    const image = await sharp(buffer, { limitInputPixels: 40_000_000 })
      .rotate()
      .flatten({ background: '#fff' })
      .png()
      .toBuffer();
    return await imageToPdf(image);
  } catch {
    throw new AppError(422, 'The image is damaged or exceeds 40 megapixels.');
  }
}
export async function imageToPdf(image: Buffer): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const png = await pdf.embedPng(image);
  const page = pdf.addPage([595.28, 841.89]);
  const scale = Math.min(555.28 / png.width, 801.89 / png.height);
  const width = png.width * scale;
  const height = png.height * scale;
  page.drawImage(png, { x: (595.28 - width) / 2, y: (841.89 - height) / 2, width, height });
  return Buffer.from(await pdf.save());
}
export async function exportScan(pngPath: string, pdfPath: string) {
  const png = await sharp(await readFile(pngPath), { limitInputPixels: 80_000_000 })
    .png()
    .toBuffer();
  await writeFile(pdfPath, await imageToPdf(png), { mode: 0o600 });
}
