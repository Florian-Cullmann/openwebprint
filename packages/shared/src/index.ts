import { z } from 'zod';

export const printOptionsSchema = z.object({
  copies: z.number().int().min(1).max(99).default(1),
  color: z.enum(['color', 'monochrome']).default('monochrome'),
  sides: z.enum(['one-sided', 'two-sided-long-edge', 'two-sided-short-edge']).default('one-sided'),
  media: z
    .enum(['iso_a4_210x297mm', 'na_letter_8.5x11in', 'iso_a5_148x210mm'])
    .default('iso_a4_210x297mm'),
});
export const scanOptionsSchema = z.object({
  resolution: z.union([z.literal(150), z.literal(300), z.literal(600)]).default(300),
  color: z.enum(['Color', 'Gray']).default('Color'),
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
  color: boolean;
  duplex: boolean;
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
  hasFile: boolean;
}
export interface DiscoveryResult {
  devices: DeviceInput[];
  warnings: string[];
}
export interface Snapshot {
  devices: Device[];
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
