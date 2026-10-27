import type {
  Device,
  DeviceInput,
  DiscoveryResult,
  JobStatus,
  PrintOptions,
  ScanOptions,
  ScanSources,
} from '@openwebprint/shared';
import type { StoredJob } from '../store.js';
export interface JobUpdate {
  status: JobStatus;
  error?: string;
}
export interface Provider {
  discover(): Promise<DiscoveryResult>;
  add(input: DeviceInput, id: string): Promise<Device>;
  inspect(device: Device): Promise<Device>;
  print(device: Device, filePath: string, title: string, options: PrintOptions): Promise<string>;
  poll(job: StoredJob, device: Device): Promise<JobUpdate>;
  cancel(job: StoredJob, device: Device): Promise<void>;
  scanSources(device: Device): Promise<ScanSources>;
  scan(device: Device, outputPath: string, options: ScanOptions, pageLimit?: number): Promise<void>;
}
