import {
  MAX_SCAN_RESOLUTION,
  scanChoiceSchema,
  supportsScanResolution,
  type ScanResolutions,
  type ScanSources,
} from '@openwebprint/shared';

// scanimage's C-locale --all-options output, not descriptions or stderr.
// See https://gitlab.com/sane-project/backends/-/blob/master/frontend/scanimage.c
function option(output: string, name: string) {
  const lines = output.split(/\r?\n/);
  const index = lines.findIndex((line) => line.trimStart().startsWith(`--${name} `));
  if (index < 0) return;
  let value = lines[index].trimStart().slice(name.length + 3);
  for (let next = index + 1; next < lines.length && value.trimEnd().endsWith('|'); next++) {
    if (lines[next].trimStart().startsWith('--')) break;
    value += lines[next].trim();
  }
  return {
    values: value.replace(/\s+\[.*$/, '').trim(),
    current: /\[([^\]]*)\]/.exec(value)?.[1],
    unavailable: /\[(?:inactive|hardware|read-only)\]/.test(value),
  };
}
function choices(value: string) {
  if (/^\{no_\w+\}$/.test(value)) return [];
  const parts = value.split('|').filter((part) => part !== 'auto');
  if (parts.some((part) => part.startsWith('<') || !scanChoiceSchema.safeParse(part).success))
    return;
  return [...new Set(parts.map((part) => part.trim()))];
}
function resolutions(value: string): ScanResolutions | undefined {
  const spec = value.replace(/^auto\|/, '');
  const range = /^(\d+(?:\.\d+)?)\.\.(\d+(?:\.\d+)?)dpi(?: \(in steps of (\d+(?:\.\d+)?)\))?$/.exec(
    spec,
  );
  if (range) {
    const low = Number(range[1]);
    const high = Number(range[2]);
    const step = range[3] === undefined ? undefined : Number(range[3]);
    if (low > high || (step !== undefined && step <= 0)) return;
    const min = low < 1 ? (step ? low + Math.ceil((1 - low) / step) * step : 1) : low;
    const max = Math.min(high, MAX_SCAN_RESOLUTION);
    return min > max ? [] : { min, max, ...(step ? { step } : {}) };
  }
  if (/^\{no_\w+\}(?:dpi)?$/.test(spec)) return [];
  if (!/^\d+(?:\.\d+)?(?:\|\d+(?:\.\d+)?)*dpi$/.test(spec)) return;
  return [...new Set(spec.slice(0, -3).split('|').map(Number))]
    .filter((dpi) => dpi >= 1 && dpi <= MAX_SCAN_RESOLUTION)
    .sort((a, b) => a - b);
}
export function saneCapabilities(output: string): ScanSources {
  const source = option(output, 'source');
  const resolution = option(output, 'resolution');
  const mode = option(output, 'mode');
  const dpi = resolution?.unavailable ? [] : resolution && resolutions(resolution.values);
  const colors = mode?.unavailable ? [] : mode && choices(mode.values);
  const defaultResolution = Number(resolution?.current);
  return {
    sources: (source?.unavailable ? [] : (source && choices(source.values)) || []).map((name) => ({
      name,
      feeder: /adf|document feeder/i.test(name),
    })),
    duplex: /^\s*--duplex(?:\[|[= \t]|$)(?![^\n]*\[(?:inactive|hardware|read-only)\])/m.test(
      output,
    ),
    ...(dpi !== undefined ? { resolutions: dpi } : {}),
    ...(colors !== undefined ? { colorModes: colors } : {}),
    ...(dpi && supportsScanResolution(dpi, defaultResolution) ? { defaultResolution } : {}),
    ...(mode?.current && colors?.includes(mode.current) ? { defaultColorMode: mode.current } : {}),
  };
}
