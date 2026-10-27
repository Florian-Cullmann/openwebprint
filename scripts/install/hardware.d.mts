import type { HardwareReport } from '../../packages/shared/src/index.js';
export function checkHardware(options?: {
  platform?: string;
  method?: HardwareReport['method'];
  server?: string;
  setupCommand?: string;
}): Promise<HardwareReport>;
