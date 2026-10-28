import { z } from 'zod';
export { resolvePrintPages, formatPrintPages } from './print-pages.js';

export const PRINT_COLOR_MODES = ['monochrome', 'color'] as const;
export const PRINT_SIDES = ['one-sided', 'two-sided-long-edge', 'two-sided-short-edge'] as const;
export const printOptionsSchema = z.object({
  pageRanges: z.string().max(2000).optional(),
  pageParity: z.enum(['all', 'odd', 'even']).optional(),
  copies: z.number().int().min(1).max(99).default(1),
  color: z.enum(PRINT_COLOR_MODES).default('monochrome'),
  sides: z.enum(PRINT_SIDES).default('one-sided'),
  media: z
    .enum(['iso_a4_210x297mm', 'na_letter_8.5x11in', 'iso_a5_148x210mm'])
    .default('iso_a4_210x297mm'),
});
export const MAX_SCAN_EXPORT_DOCUMENTS = 50;
export const MAX_SCAN_EXPORT_BYTES = 100 * 1024 * 1024;
export const scanExportSchema = z
  .object({
    scans: z
      .array(z.object({ id: z.uuid(), revision: z.string().min(1).max(80) }).strict())
      .min(1)
      .max(MAX_SCAN_EXPORT_DOCUMENTS)
      .refine(
        (scans) => new Set(scans.map((scan) => scan.id)).size === scans.length,
        'Select each scan only once.',
      ),
  })
  .strict();
export type ScanExportSelection = z.infer<typeof scanExportSchema>['scans'][number];
export const MAX_SCAN_PAGES = 100;
export const MAX_SCAN_RESOLUTION = 9600;
// Per original page, before cropping/rotation; retain a bounded decoder budget.
export const MAX_SCAN_PIXELS = 80_000_000;
export const SCAN_SIZE_ERROR =
  'A scanned page exceeds the 80-megapixel limit. Choose a lower resolution or a smaller scan area on the scanner, refresh scanner settings and try again. Cropping after scanning does not reduce acquisition size.';
export const FALLBACK_SCAN_RESOLUTIONS = [150, 300, 600];
export const FALLBACK_SCAN_COLOR_MODES = ['Color', 'Gray'];
export const scanChoiceSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((v) => !/[\x00-\x1f\x7f]/.test(v));
export const scanOptionsSchema = z.object({
  resolution: z.number().min(1).max(MAX_SCAN_RESOLUTION).default(300),
  color: scanChoiceSchema.default('Color'),
  source: scanChoiceSchema.optional(),
  batch: z.boolean().optional(),
  duplex: z.boolean().optional(),
});
export const deviceInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['printer', 'scanner']),
  address: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .refine((v) => !/[\x00-\x1f\x7f]/.test(v), 'Invalid device address'),
  location: z.string().trim().max(80).default(''),
});
export type Mode = 'demo' | 'hardware';
export type PrintOptions = z.infer<typeof printOptionsSchema>;
export type ScanOptions = z.infer<typeof scanOptionsSchema>;
export type DeviceInput = z.infer<typeof deviceInputSchema>;
export type DeviceStatus = 'ready' | 'busy' | 'offline' | 'unknown';
export type JobStatus = 'queued' | 'processing' | 'completed' | 'canceled' | 'failed' | 'unknown';
export interface Capabilities {
  // Legacy summary only; never infer selectable modes from this flag.
  color: boolean;
  // Undefined means unavailable; [] means no application-supported color modes.
  colorModes?: PrintOptions['color'][];
  // Undefined means unavailable; an empty array means no supported application sides.
  sides?: PrintOptions['sides'][];
  media: PrintOptions['media'][];
}
export interface Device {
  id: string;
  name: string;
  kind: DeviceInput['kind'];
  address: string;
  location: string;
  provider: 'demo' | 'cups' | 'sane';
  mode: Mode;
  status: DeviceStatus;
  target?: string;
  capabilities?: Capabilities;
  detail?: string;
}
// Integer pixels in the original, unrotated image, measured from its top-left corner.
// Crop before rotating; omitting crop restores the complete original image.
export interface ScanCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface ScanPage {
  id: string;
  rotation: 0 | 90 | 180 | 270;
  crop?: ScanCrop;
}
export type ScanResolutions = number[] | { min: number; max: number; step?: number };
export interface ScanArea {
  widthMm: number;
  heightMm: number;
}
export function scanPixelCount(area: ScanArea, resolution: number): number {
  // Round up each axis so fractional device pixels never understate the budget.
  return (
    Math.ceil((area.widthMm * resolution) / 25.4) * Math.ceil((area.heightMm * resolution) / 25.4)
  );
}
export interface ScanCapabilities {
  // Current source area in mm, explicitly applied by the provider on acquisition.
  // Missing geometry is unknown, never assumed to be A4.
  acquisitionArea?: ScanArea;
  // Undefined means unknown; [] means no selectable values within application limits.
  resolutions?: ScanResolutions;
  colorModes?: string[];
  defaultResolution?: number;
  defaultColorMode?: string;
}
export interface ScanSources extends ScanCapabilities {
  sources: { name: string; feeder: boolean }[];
  duplex: boolean;
  warning?: string;
}
export function supportsScanResolution(resolutions: ScanResolutions, value: number): boolean {
  if (!Number.isFinite(value) || value < 1 || value > MAX_SCAN_RESOLUTION) return false;
  if (Array.isArray(resolutions)) return resolutions.includes(value);
  if (value < resolutions.min || value > resolutions.max) return false;
  if (!resolutions.step) return true;
  const steps = (value - resolutions.min) / resolutions.step;
  return Math.abs(steps - Math.round(steps)) < 0.00001;
}
export function scanSettingsError(capabilities: ScanCapabilities, options: ScanOptions) {
  if (
    !supportsScanResolution(
      capabilities.resolutions ?? FALLBACK_SCAN_RESOLUTIONS,
      options.resolution,
    )
  )
    return capabilities.resolutions === undefined
      ? 'Scanner resolutions are unknown. Choose a fallback resolution (150, 300 or 600 dpi), or retry discovery.'
      : 'The scanner does not support the selected resolution for this paper source.';
  if (
    capabilities.acquisitionArea &&
    scanPixelCount(capabilities.acquisitionArea, options.resolution) > MAX_SCAN_PIXELS
  )
    return SCAN_SIZE_ERROR;
  if (!(capabilities.colorModes ?? FALLBACK_SCAN_COLOR_MODES).includes(options.color))
    return capabilities.colorModes === undefined
      ? 'Scanner color modes are unknown. Choose Color or Gray, or retry discovery.'
      : 'The scanner does not support the selected color mode for this paper source.';
}
export const scanPagesSchema = z.object({
  revision: z.string().min(1).max(80),
  pages: z
    .array(
      z.object({
        id: z.uuid(),
        rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
        crop: z
          .object({
            x: z.int().nonnegative(),
            y: z.int().nonnegative(),
            width: z.int().positive(),
            height: z.int().positive(),
          })
          .optional(),
      }),
    )
    .min(1)
    .max(MAX_SCAN_PAGES),
});
// Instance policy: whole days from job creation; edits/appends do not reset the clock.
export const retentionSchema = z
  .object({
    scanDays: z.int().min(1).max(3650),
    printDays: z.int().min(1).max(3650),
  })
  .strict();
export type RetentionPolicy = z.infer<typeof retentionSchema>;
export interface RetentionImpact {
  scans: number;
  prints: number;
}
export const DEFAULT_RETENTION: RetentionPolicy = { scanDays: 7, printDays: 7 };

export interface Job {
  id: string;
  deviceId: string;
  deviceName: string;
  kind: 'print' | 'scan';
  title: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  mode: Mode;
  options: PrintOptions | ScanOptions;
  error?: string;
  errorMessages?: import('./public-messages.js').PublicMessage[];
  hasFile: boolean;
  expiresAt?: string;
  pages?: ScanPage[];
  scanRevision?: string;
  recovery?: { revision: string; pageNumbers: number[]; expiresAt: string };
}
export type JobFilter = 'all' | 'active' | 'completed';
export interface JobPage {
  jobs: Job[];
  total: number;
  offset: number;
  nextCursor?: string;
}
export interface DiscoveryResult {
  devices: DeviceInput[];
  warnings: string[];
  hostDiscovery?: { source: 'macos-bonjour'; updatedAt: string };
}
export interface Snapshot {
  devices: Device[];
  devicesCheckedAt: string;
  jobs: Job[];
  mode: Mode;
  warnings: string[];
}
export interface OnboardingState {
  phase: 'welcome' | 'devices' | 'storage' | 'complete';
  mode: Mode;
  scanRoot: string;
  devices: Device[];
}
export interface SessionInfo {
  onboardingRequired: boolean;
  authenticationRequired: boolean;
  authenticated: boolean;
  user?: User;
  mode: Mode;
}

export interface User {
  id: string;
  username: string;
  createdAt: string;
}

export interface HardwareReport {
  checkedAt: string;
  platform: string;
  method: 'native' | 'container' | 'source';
  ready: boolean;
  checks: {
    id: string;
    label: string;
    state: 'ok' | 'empty' | 'missing' | 'unavailable' | 'permission' | 'timeout';
  }[];
  guidance: string;
  setupCommand?: string;
  note: string;
}

export {
  publicMessages,
  publicMessage,
  publicMessageText,
  publicErrorBody,
  publicMessageParts,
} from './public-messages.js';
export type { PublicMessageCode, MessageParams, PublicMessage } from './public-messages.js';
