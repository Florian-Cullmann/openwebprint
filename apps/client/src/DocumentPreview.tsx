import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { PDFDocumentProxy, PDFDocumentLoadingTask, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { Spinner } from './ui';
import s from './App.module.css';

export function DocumentPreview({
  data,
  monochrome = false,
}: {
  data: Uint8Array;
  monochrome?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [page, setPage] = useState(1);
  const [width, setWidth] = useState(360);
  const [error, setError] = useState('');
  const [rendering, setRendering] = useState(true);
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
          scale: Math.min(width / base.width, 520 / base.height, 1.5),
        });
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const element = canvas.current;
        const context = element.getContext('2d');
        if (!context) throw new Error('Canvas unavailable');
        element.width = Math.ceil(viewport.width * ratio);
        element.height = Math.ceil(viewport.height * ratio);
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
  }, [pdf, page, width]);
  return (
    <section className={s.documentPreview} aria-label="Document preview">
      <div className={s.previewToolbar}>
        <button
          type="button"
          className={s.iconButton}
          aria-label="Previous page"
          disabled={!pdf || page <= 1}
          onClick={() => setPage(page - 1)}
        >
          <ChevronLeft size={18} />
        </button>
        <span aria-live="polite">
          {pdf ? `Page ${page} of ${pdf.numPages}` : 'Loading preview…'}
        </span>
        <button
          type="button"
          className={s.iconButton}
          aria-label="Next page"
          disabled={!pdf || page >= pdf.numPages}
          onClick={() => setPage(page + 1)}
        >
          <ChevronRight size={18} />
        </button>
      </div>
      <div ref={container} className={s.previewCanvas}>
        {error ? (
          <p role="alert" className={s.error}>
            {error}
          </p>
        ) : (
          <>
            {(!pdf || rendering) && (
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
                visibility: !pdf || rendering ? 'hidden' : undefined,
              }}
            />
          </>
        )}
      </div>
    </section>
  );
}
