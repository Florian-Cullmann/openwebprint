import { useId } from 'react';
import type { ScanResolutions } from '@openwebprint/shared';
import s from './CapabilityControls.module.css';

export function ColorModeControl({
  modes,
  value,
  onChange,
  disabled,
}: {
  modes: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const name = useId();
  if (modes.length > 2)
    return (
      <label>
        Color mode
        <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          {modes.map((mode) => (
            <option key={mode.value} value={mode.value}>
              {mode.label}
            </option>
          ))}
        </select>
      </label>
    );
  return (
    <fieldset className={s.colorMode} disabled={disabled}>
      <legend>Color mode</legend>
      {modes.length === 2 ? (
        <div className={s.toggle}>
          {modes.map((mode) => (
            <label key={mode.value}>
              <input
                type="radio"
                name={name}
                value={mode.value}
                checked={value === mode.value}
                onChange={() => onChange(mode.value)}
              />
              <span>{mode.label}</span>
            </label>
          ))}
        </div>
      ) : (
        <p className={s.fixedValue}>{modes[0]?.label ?? 'No supported color modes'}</p>
      )}
    </fieldset>
  );
}

// Indexing discrete values (including stepped ranges) prevents unsupported intermediate dpi.
// An unstepped range stays continuous, as advertised by the scanner.
export function ResolutionControl({
  resolutions,
  value,
  onChange,
  disabled,
}: {
  resolutions: ScanResolutions;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const values = Array.isArray(resolutions)
    ? [...new Set(resolutions)].sort((a, b) => a - b)
    : undefined;
  const range = Array.isArray(resolutions) ? undefined : resolutions;
  const indexed = !!values || !!range?.step;
  const min = indexed ? 0 : range!.min;
  let max = values
    ? values.length - 1
    : range?.step
      ? Math.floor((range.max - range.min) / range.step + 1e-8)
      : range!.max;
  const dpiAt = (position: number) =>
    values ? values[position] : Number((range!.min + position * range!.step!).toPrecision(15));
  // Tolerate arithmetic noise without ever offering a value above the advertised maximum.
  if (range?.step && dpiAt(max) > range.max) max--;
  const position = values
    ? Math.max(0, values.indexOf(value))
    : range?.step
      ? Math.round((value - range.min) / range.step)
      : value;
  const dpi = (position: number) => (indexed ? dpiAt(position) : position);
  const fixed = max <= min;
  const empty = values?.length === 0;
  const anchors = fixed
    ? []
    : [
        ...new Set(
          Array.from({ length: 5 }, (_, i) => {
            const position = min + ((max - min) * i) / 4;
            return indexed ? Math.round(position) : position;
          }),
        ),
      ];
  return (
    <div className={s.resolution}>
      {fixed ? (
        <div className={s.fixedResolution}>
          <span>Resolution</span>
          <p className={s.fixedValue}>{empty ? 'No supported resolutions' : `${dpi(min)} dpi`}</p>
        </div>
      ) : (
        <>
          <div className={s.resolutionHeading}>
            <label htmlFor={id}>Resolution</label>
            <output htmlFor={id} aria-live="off">
              {value} dpi
            </output>
          </div>
          <input
            id={id}
            className={s.slider}
            type="range"
            min={min}
            max={max}
            step={indexed ? 1 : 'any'}
            value={position}
            aria-valuetext={`${value} dpi`}
            disabled={disabled}
            onChange={(e) => onChange(dpi(e.target.valueAsNumber))}
          />
          <div className={s.anchors} aria-hidden="true">
            {anchors.map((anchor) => (
              <span key={anchor} style={{ left: `${((anchor - min) / (max - min)) * 100}%` }}>
                {dpi(anchor)}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
