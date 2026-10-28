import { t, formatNumber } from './i18n';
import { useId } from 'react';
import type { ScanResolutions } from '@openwebprint/shared';
import s from './CapabilityControls.module.css';

export function ColorModeControl({
  modes,
  value,
  onChange,
  disabled,
  emptyLabel = t('No supported color modes'),
}: {
  modes: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  emptyLabel?: string;
}) {
  const name = useId();
  if (modes.length > 2)
    return (
      <label>
        {t('Color mode')}
        <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          {modes.map((mode) => (
            <option key={mode.value} value={mode.value}>
              {t(mode.label)}
            </option>
          ))}
        </select>
      </label>
    );
  return (
    <fieldset className={s.colorMode} disabled={disabled}>
      <legend>{t('Color mode')}</legend>
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
              <span>{t(mode.label)}</span>
            </label>
          ))}
        </div>
      ) : (
        <p className={s.fixedValue}>{t(modes[0]?.label ?? emptyLabel)}</p>
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
          <span>{t('Resolution')}</span>
          <p className={s.fixedValue}>
            {empty ? t('No supported resolutions') : t('{value1} dpi', { value1: dpi(min) })}
          </p>
        </div>
      ) : (
        <>
          <div className={s.resolutionHeading}>
            <label htmlFor={id}>{t('Resolution')}</label>
            <output htmlFor={id} aria-live="off">
              {t('{value1} dpi', { value1: value })}
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
            aria-valuetext={t('{value1} dpi', { value1: value })}
            disabled={disabled}
            onChange={(e) => onChange(dpi(e.target.valueAsNumber))}
          />
          <div className={s.anchors} aria-hidden="true">
            {anchors.map((anchor) => (
              <span key={anchor} style={{ left: `${((anchor - min) / (max - min)) * 100}%` }}>
                {formatNumber(dpi(anchor))}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
