import { t } from './i18n';
import { useId, useRef, useState, type PointerEvent } from 'react';
import type { ScanCrop, ScanPage } from '@openwebprint/shared';
import { Spinner } from './ui';
import s from './ScanCropEditor.module.css';
import app from './App.module.css';

type Size = { width: number; height: number };
type Point = { x: number; y: number };
type Handle = 'nw' | 'ne' | 'sw' | 'se';
type Gesture = {
  pointerId: number;
  action: 'draw' | 'move' | Handle;
  start: Point;
  crop: ScanCrop;
};
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function ScanCropEditor({
  page,
  number,
  url,
  busy,
  apply,
  cancel,
}: {
  page: ScanPage;
  number: number;
  url: string;
  busy: boolean;
  apply: (crop?: ScanCrop) => Promise<void>;
  cancel: () => void;
}) {
  const [size, setSize] = useState<Size>();
  const [crop, setCrop] = useState<ScanCrop>();
  const [loadError, setLoadError] = useState(false);
  const gesture = useRef<Gesture | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const help = useId();
  const valid =
    !!size &&
    !!crop &&
    Object.values(crop).every(Number.isSafeInteger) &&
    crop.x >= 0 &&
    crop.y >= 0 &&
    crop.width > 0 &&
    crop.height > 0 &&
    crop.x + crop.width <= size.width &&
    crop.y + crop.height <= size.height;
  const turned = page.rotation === 90 || page.rotation === 270;
  const view = size && {
    width: turned ? size.height : size.width,
    height: turned ? size.width : size.height,
  };
  const transform =
    size &&
    {
      0: '',
      90: `translate(${size.height} 0) rotate(90)`,
      180: `translate(${size.width} ${size.height}) rotate(180)`,
      270: `translate(0 ${size.width}) rotate(270)`,
    }[page.rotation];

  function point(e: PointerEvent<SVGSVGElement>): Point {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) * view!.width) / rect.width;
    const y = ((e.clientY - rect.top) * view!.height) / rect.height;
    const original = {
      0: { x, y },
      90: { x: y, y: size!.height - x },
      180: { x: size!.width - x, y: size!.height - y },
      270: { x: size!.width - y, y: x },
    }[page.rotation];
    return {
      x: clamp(Math.round(original.x), 0, size!.width),
      y: clamp(Math.round(original.y), 0, size!.height),
    };
  }
  function start(e: PointerEvent<SVGSVGElement>) {
    if (busy || !valid || !e.isPrimary || e.button !== 0) return;
    e.preventDefault();
    const start = point(e);
    const handle = (e.target as Element).closest('[data-handle]')?.getAttribute('data-handle') as
      Handle | undefined;
    const inside =
      start.x >= crop!.x &&
      start.x <= crop!.x + crop!.width &&
      start.y >= crop!.y &&
      start.y <= crop!.y + crop!.height;
    gesture.current = {
      pointerId: e.pointerId,
      action: handle ?? (inside ? 'move' : 'draw'),
      start,
      crop: crop!,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function update(e: PointerEvent<SVGSVGElement>) {
    const current = gesture.current;
    if (!current || e.pointerId !== current.pointerId || busy) return;
    const end = point(e);
    const { crop: before, start, action } = current;
    if (action === 'move') {
      setCrop({
        ...before,
        x: clamp(before.x + end.x - start.x, 0, size!.width - before.width),
        y: clamp(before.y + end.y - start.y, 0, size!.height - before.height),
      });
      return;
    }
    const anchor =
      action === 'draw'
        ? start
        : {
            x: action.endsWith('w') ? before.x + before.width : before.x,
            y: action.startsWith('n') ? before.y + before.height : before.y,
          };
    const x = Math.min(anchor.x, end.x, size!.width - 1);
    const y = Math.min(anchor.y, end.y, size!.height - 1);
    setCrop({
      x,
      y,
      width: Math.max(1, Math.abs(end.x - anchor.x)),
      height: Math.max(1, Math.abs(end.y - anchor.y)),
    });
  }
  function release(revert = false) {
    const current = gesture.current;
    gesture.current = null;
    if (revert && current) setCrop(current.crop);
    if (current && svg.current?.hasPointerCapture(current.pointerId))
      svg.current.releasePointerCapture(current.pointerId);
  }
  const handles: [Handle, number, number][] = crop
    ? [
        ['nw', crop.x, crop.y],
        ['ne', crop.x + crop.width, crop.y],
        ['sw', crop.x, crop.y + crop.height],
        ['se', crop.x + crop.width, crop.y + crop.height],
      ]
    : [];
  return (
    <form
      className={`${app.modalBody} ${s.editor}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !busy) void apply(crop);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) {
          e.preventDefault();
          e.stopPropagation();
          if (gesture.current) release(true);
          else cancel();
        }
      }}
    >
      <h3>{t('Crop page {value1}', { value1: number })}</h3>
      <p id={help} className={app.small}>
        {t(
          'Drag a corner to resize, or drag inside to move. Drag outside to draw a new crop. You can also enter pixels below, measured from the top-left of the original before rotation.',
        )}
      </p>
      <img
        className={s.loader}
        src={url}
        alt=""
        onLoad={(e) => {
          const image = e.currentTarget;
          const size = { width: image.naturalWidth, height: image.naturalHeight };
          setSize(size);
          setCrop(page.crop ?? { x: 0, y: 0, ...size });
        }}
        onError={() => setLoadError(true)}
      />
      {loadError ? (
        <p role="alert" className={app.error}>
          {t('Could not load the original page. Close and reopen the crop editor to try again.')}
        </p>
      ) : !size ? (
        <Spinner />
      ) : (
        <>
          <div className={s.stage}>
            <svg
              ref={svg}
              role="img"
              aria-label={t('Crop selection for page {value1}', { value1: number })}
              aria-describedby={help}
              className={s.canvas}
              viewBox={`0 0 ${view!.width} ${view!.height}`}
              style={{
                aspectRatio: `${view!.width} / ${view!.height}`,
                maxWidth: `min(100%, ${(view!.width / view!.height) * 50}vh)`,
              }}
              onPointerDown={start}
              onPointerMove={update}
              onPointerUp={(e) => {
                update(e);
                release();
              }}
              onPointerCancel={() => release(true)}
              onLostPointerCapture={() => release(true)}
            >
              <g transform={transform}>
                <image href={url} width={size.width} height={size.height} />
                {valid && (
                  <>
                    <path
                      d={`M0 0H${size.width}V${size.height}H0Z M${crop!.x} ${crop!.y}v${crop!.height}h${crop!.width}v-${crop!.height}Z`}
                      fill="#000"
                      fillOpacity="0.5"
                      fillRule="evenodd"
                    />
                    <rect
                      x={crop!.x}
                      y={crop!.y}
                      width={crop!.width}
                      height={crop!.height}
                      fill="transparent"
                      stroke="#fff"
                      strokeWidth="2"
                      vectorEffect="non-scaling-stroke"
                    />
                    {handles.map(([handle, x, y]) => (
                      <g key={handle} data-handle={handle}>
                        <circle
                          cx={x}
                          cy={y}
                          r={Math.max(size.width, size.height) / 45}
                          fill="transparent"
                          stroke="transparent"
                          strokeWidth="24"
                          vectorEffect="non-scaling-stroke"
                        />
                        <circle
                          cx={x}
                          cy={y}
                          r={Math.max(size.width, size.height) / 45}
                          fill="#fff"
                          stroke="#111"
                          strokeWidth="2"
                          vectorEffect="non-scaling-stroke"
                          pointerEvents="none"
                        />
                      </g>
                    ))}
                  </>
                )}
              </g>
            </svg>
          </div>
          <fieldset disabled={busy} className={s.fields}>
            {(['x', 'y', 'width', 'height'] as const).map((key) => (
              <label key={key}>
                {t('{value1} (px)', {
                  value1: t({ x: 'Left', y: 'Top', width: 'Width', height: 'Height' }[key]),
                })}
                <input
                  type="number"
                  autoFocus={key === 'x'}
                  step="1"
                  min={key === 'x' || key === 'y' ? 0 : 1}
                  max={
                    key === 'x'
                      ? size.width - (crop?.width || 1)
                      : key === 'y'
                        ? size.height - (crop?.height || 1)
                        : key === 'width'
                          ? size.width - (crop?.x || 0)
                          : size.height - (crop?.y || 0)
                  }
                  value={Number.isFinite(crop?.[key]) ? crop![key] : ''}
                  aria-describedby={help}
                  onChange={(e) => setCrop({ ...crop!, [key]: e.target.valueAsNumber })}
                />
              </label>
            ))}
          </fieldset>
          {!valid && (
            <p role="alert" className={app.error}>
              {t('Enter a non-empty rectangle within the {value1} × {value2} pixel original.', {
                value1: size.width,
                value2: size.height,
              })}
            </p>
          )}
        </>
      )}
      <div className={app.modalActions}>
        <button type="button" className={app.secondary} disabled={busy} onClick={cancel}>
          {t('Cancel crop')}
        </button>
        <button
          type="button"
          className={app.secondary}
          disabled={busy || !size || loadError}
          onClick={() => void apply(undefined)}
        >
          {t('Reset crop')}
        </button>
        <button className={app.primary} disabled={busy || !valid || loadError}>
          {busy && <Spinner />}
          {t('Apply crop')}
        </button>
      </div>
    </form>
  );
}
