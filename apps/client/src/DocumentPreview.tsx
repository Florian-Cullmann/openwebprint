import { useEffect, useId, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react';
import type { PDFDocumentProxy, PDFDocumentLoadingTask, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { Spinner } from './ui';
import s from './App.module.css';

// Bound both the longest canvas edge and its total backing-store allocation.
const MAX_CANVAS_EDGE = 4096;
const MAX_CANVAS_PIXELS = 8_000_000;
const ZOOM_LEVELS = [0.5, 0.75, 1, 1.5, 2, 3, 4];

export function DocumentPreview({
  data,
  monochrome = false,
}: {
  data: Uint8Array;
  monochrome?: boolean;
}) {
  const instructionsId = useId();
  const drag = useRef<{ x: number; y: number; left: number; top: number } | undefined>(undefined);
  const [zoom, setZoom] = useState(1);
  const container = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [page, setPage] = useState(1);
  const [width, setWidth] = useState(360);
  const [error, setError] = useState('');
  const [rendering, setRendering] = useState(true);
  function resetView() {
    setZoom(1);
    container.current?.scrollTo(0, 0);
    drag.current = undefined;
  }
  function changePage(next: number) {
    resetView();
    setPage(next);
  }
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(100, entry.contentRect.width - 24)),
    );
    observer.observe(container.current!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let cancelled = false;
    let task: PDFDocumentLoadingTask | undefined;
    setPdf(undefined);
    setPage(1);
    resetView();
    setRendering(true);
    setError('');
    void (async () => {
      try {
        const library = await import('pdfjs-dist');
        if (cancelled) return;
        library.GlobalWorkerOptions.workerSrc = workerUrl;
        task = library.getDocument({
          data: data.slice(),
          stopAtErrors: true,
          cMapUrl: '/pdfjs/cmaps/',
          cMapPacked: true,
          standardFontDataUrl: '/pdfjs/standard_fonts/',
          wasmUrl: '/pdfjs/wasm/',
        });
        const document = await task.promise;
        if (!cancelled) setPdf(document);
      } catch (e) {
        if (!cancelled) setError('Unable to display this document preview.');
      }
    })();
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [data]);
  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    let task: RenderTask | undefined;
    setRendering(true);
    setError('');
    void (async () => {
      try {
        const documentPage = await pdf.getPage(page);
        if (cancelled || !canvas.current) return;
        const base = documentPage.getViewport({ scale: 1 });
        const viewport = documentPage.getViewport({
          scale: Math.min(width / base.width, 520 / base.height, 1.5) * zoom,
        });
        const ratio = Math.min(
          window.devicePixelRatio || 1,
          2,
          MAX_CANVAS_EDGE / viewport.width,
          MAX_CANVAS_EDGE / viewport.height,
          Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)),
        );
        const element = canvas.current;
        const context = element.getContext('2d');
        if (!context) throw new Error('Canvas unavailable');
        element.width = Math.max(1, Math.floor(viewport.width * ratio));
        element.height = Math.max(1, Math.floor(viewport.height * ratio));
        element.style.width = `${viewport.width}px`;
        element.style.height = `${viewport.height}px`;
        task = documentPage.render({
          canvas: element,
          canvasContext: context,
          viewport,
          transform: [ratio, 0, 0, ratio, 0, 0],
          background: 'rgb(255,255,255)',
        });
        await task.promise;
      } catch (e) {
        if (!cancelled) setError('Unable to render this page.');
      } finally {
        if (!cancelled) setRendering(false);
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, page, width, zoom]);
  return (
    <section className={s.documentPreview} aria-label="Document preview">
      <div className={s.previewToolbar}>
        <button
          type="button"
          className={s.iconButton}
          aria-label="Previous page"
          disabled={!pdf || page <= 1}
          onClick={() => changePage(page - 1)}
        >
          <ChevronLeft size={18} />
        </button>
        <span aria-live="polite">
          {error
            ? 'Preview unavailable'
            : pdf
              ? `Page ${page} of ${pdf.numPages}`
              : 'Loading preview…'}
        </span>
        <button
          type="button"
          className={s.iconButton}
          aria-label="Next page"
          disabled={!pdf || page >= pdf.numPages}
          onClick={() => changePage(page + 1)}
        >
          <ChevronRight size={18} />
        </button>
      </div>
      <div
        className={`${s.previewToolbar} ${s.previewZoomToolbar}`}
        role="group"
        aria-label="Preview zoom controls"
      >
        <div className={s.previewZoomGroup}>
          <button
            type="button"
            className={s.iconButton}
            aria-label="Zoom out"
            disabled={!pdf || zoom === ZOOM_LEVELS[0]}
            onClick={() =>
              setZoom([...ZOOM_LEVELS].reverse().find((level) => level < zoom) ?? zoom)
            }
          >
            <ZoomOut size={18} />
          </button>
          <span className={s.previewZoomLevel} aria-live="polite" aria-label="Preview zoom">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            className={s.iconButton}
            aria-label="Zoom in"
            disabled={!pdf || zoom === ZOOM_LEVELS[ZOOM_LEVELS.length - 1]}
            onClick={() => setZoom(ZOOM_LEVELS.find((level) => level > zoom) ?? zoom)}
          >
            <ZoomIn size={18} />
          </button>
        </div>
        <button type="button" className={s.secondary} disabled={!pdf} onClick={resetView}>
          Fit page
        </button>
      </div>
      <p id={instructionsId} className={s.previewHint}>
        Scroll, swipe or use arrow keys to explore a zoomed page.
      </p>
      <div
        ref={container}
        className={s.previewCanvas}
        role="region"
        aria-label="Document page viewport"
        aria-describedby={instructionsId}
        tabIndex={0}
        onPointerDown={(event) => {
          // Touch keeps native scrolling; a mouse can also drag the enlarged page.
          if (event.pointerType !== 'mouse' || event.button !== 0 || zoom <= 1) return;
          const element = event.currentTarget;
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            left: element.scrollLeft,
            top: element.scrollTop,
          };
          element.setPointerCapture(event.pointerId);
          element.focus({ preventScroll: true });
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          event.currentTarget.scrollLeft = drag.current.left + drag.current.x - event.clientX;
          event.currentTarget.scrollTop = drag.current.top + drag.current.y - event.clientY;
        }}
        onPointerUp={(event) => {
          drag.current = undefined;
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={() => {
          drag.current = undefined;
        }}
        onPointerCancel={() => {
          drag.current = undefined;
        }}
        style={{ cursor: zoom > 1 ? 'grab' : undefined }}
      >
        <div className={s.previewPage}>
          {error && (
            <p role="alert" className={s.error}>
              {error}
            </p>
          )}
          {!error && (!pdf || rendering) && (
            <span className={s.previewLoading}>
              <Spinner />
            </span>
          )}
          <canvas
            ref={canvas}
            role="img"
            aria-label={`Document page ${page}`}
            aria-busy={!pdf || rendering}
            style={{
              filter: monochrome ? 'grayscale(1)' : undefined,
              display: error ? 'none' : undefined,
              visibility: !pdf || rendering ? 'hidden' : undefined,
            }}
          />
        </div>
      </div>
    </section>
  );
}
