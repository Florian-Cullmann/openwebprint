import { PDFDocument, degrees } from 'pdf-lib';
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';
import type { ScanPage } from '@openwebprint/shared';
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
export async function exportScanPages(
  pages: (ScanPage & { path: string })[],
  pdfPath: string,
  previewPath: string,
) {
  try {
    const pdf = await PDFDocument.create();
    for (const [index, source] of pages.entries()) {
      const { image, originalWidth, originalHeight } = await renderScanPage(source, false);
      const png = await pdf.embedPng(image);
      // Keep the original scale when cropping; do not add A4 borders back around the crop.
      const scale = Math.min(595.28 / originalWidth, 841.89 / originalHeight);
      const width = png.width * scale;
      const height = png.height * scale;
      const page = pdf.addPage([width, height]);
      page.drawImage(png, { x: 0, y: 0, width, height });
      page.setRotation(degrees(source.rotation));
      if (index === 0) await sharp(image).rotate(source.rotation).png().toFile(previewPath);
    }
    await writeFile(pdfPath, await pdf.save(), { mode: 0o600 });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      422,
      'The scanned pages could not be converted to PDF. Check scan storage and try again.',
    );
  }
}

export async function renderScanPage(source: ScanPage & { path: string }, rotate = true) {
  try {
    const pipeline = sharp(source.path, { limitInputPixels: 80_000_000 });
    const { width, height } = await pipeline.metadata();
    if (!width || !height) throw new Error('Missing image dimensions');
    if (source.crop) {
      const crop = source.crop;
      if (
        !Object.values(crop).every(Number.isSafeInteger) ||
        crop.x < 0 ||
        crop.y < 0 ||
        crop.width <= 0 ||
        crop.height <= 0 ||
        crop.x + crop.width > width ||
        crop.y + crop.height > height
      )
        throw new AppError(400, 'The crop must be a non-empty rectangle within the original page.');
      pipeline.extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height });
    }
    const image = await pipeline
      .rotate(rotate ? source.rotation : 0)
      .png()
      .toBuffer();
    return { image, originalWidth: width, originalHeight: height };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      422,
      'The scanned pages could not be converted to PDF. Check scan storage and try again.',
    );
  }
}
