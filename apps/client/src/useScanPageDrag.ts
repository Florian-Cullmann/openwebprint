import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import type { ScanPage } from '@openwebprint/shared';

type Point = { clientX: number; clientY: number };
type Preview = {
  id: string;
  from: number;
  to: number;
  ids: string[];
  slots: { left: number; top: number; width: number; height: number }[];
};
type Gesture = {
  pointerId: number;
  list: HTMLOListElement;
  scroller: HTMLElement;
  start: Point;
  point: Point;
  active: boolean;
  preview: Preview;
};

export function useScanPageDrag(
  pages: ScanPage[],
  locked: boolean,
  move: (id: string, to: number) => Promise<void> | undefined,
) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const saving = useRef(false);
  const dragging = !!preview;

  function release() {
    const current = gesture.current;
    gesture.current = null;
    if (current?.list.hasPointerCapture(current.pointerId))
      current.list.releasePointerCapture(current.pointerId);
  }
  function cancel() {
    release();
    if (!saving.current) setPreview(null);
  }
  function update(point: Point) {
    const current = gesture.current;
    if (!current) return;
    current.point = point;
    if (
      !current.active &&
      Math.hypot(point.clientX - current.start.clientX, point.clientY - current.start.clientY) < 5
    )
      return;
    current.active = true;
    const rect = current.list.getBoundingClientRect();
    const clip = current.scroller.getBoundingClientRect();
    const x = point.clientX - rect.left;
    const y = point.clientY - rect.top;
    const { slots, from } = current.preview;
    let nearest = 0;
    let distance = Infinity;
    slots.forEach((slot, index) => {
      const dx = Math.max(slot.left - x, 0, x - slot.left - slot.width);
      const dy = Math.max(slot.top - y, 0, y - slot.top - slot.height);
      if (dx * dx + dy * dy < distance) {
        distance = dx * dx + dy * dy;
        nearest = index;
      }
    });
    const slot = slots[nearest];
    const columns = slots.length > 1 && slots[0].top === slots[1].top;
    const delta = columns ? x - slot.left - slot.width / 2 : y - slot.top - slot.height / 2;
    // Dropping on a page's center follows the direction of travel; its edges expose precise insertion positions.
    const after = Math.abs(delta) <= 16 ? from < nearest : delta > 0;
    const insertion =
      y < slots[0].top
        ? 0
        : y > slots.at(-1)!.top + slots.at(-1)!.height
          ? slots.length
          : nearest + Number(after);
    const inside =
      point.clientX >= Math.max(rect.left, clip.left) &&
      point.clientX <= Math.min(rect.right, clip.right) &&
      point.clientY >= Math.max(rect.top, clip.top) &&
      point.clientY <= Math.min(rect.bottom, clip.bottom);
    const to = inside ? insertion - Number(insertion > from) : from;
    if (current.preview.to !== to || !preview) {
      current.preview = { ...current.preview, to };
      setPreview(current.preview);
    }
  }
  function start(e: PointerEvent<HTMLLIElement>, index: number) {
    if (
      locked ||
      saving.current ||
      e.button !== 0 ||
      e.pointerType === 'touch' ||
      (e.target as Element).closest('button, a, input, select')
    )
      return;
    e.preventDefault();
    const list = e.currentTarget.parentElement as HTMLOListElement;
    let scroller = list.parentElement!;
    while (scroller.parentElement && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY))
      scroller = scroller.parentElement;
    const slots = Array.from(list.querySelectorAll<HTMLElement>('[data-page-id]'), (element) => ({
      left: element.offsetLeft,
      top: element.offsetTop,
      width: element.offsetWidth,
      height: element.offsetHeight,
    }));
    gesture.current = {
      pointerId: e.pointerId,
      list,
      scroller,
      start: { clientX: e.clientX, clientY: e.clientY },
      point: { clientX: e.clientX, clientY: e.clientY },
      active: false,
      preview: {
        id: pages[index].id,
        from: index,
        to: index,
        ids: pages.map((page) => page.id),
        slots,
      },
    };
    list.setPointerCapture(e.pointerId);
  }
  function finish(e: PointerEvent<HTMLOListElement>) {
    const current = gesture.current;
    if (!current || e.pointerId !== current.pointerId) return;
    if (current.active) update(e);
    const pending = current.active ? move(current.preview.id, current.preview.to) : undefined;
    saving.current = !!pending;
    release();
    if (pending)
      void pending.finally(() => {
        saving.current = false;
        setPreview(null);
      });
    else setPreview(null);
  }
  useEffect(() => {
    if (!dragging) return;
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && gesture.current) {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      }
    };
    let frame: number;
    const scroll = () => {
      const current = gesture.current;
      if (!current?.active) return;
      const rect = current.scroller.getBoundingClientRect();
      const y = current.point.clientY;
      const before = current.scroller.scrollTop;
      if (y < rect.top + 36) current.scroller.scrollTop -= Math.min(12, (rect.top + 36 - y) / 3);
      else if (y > rect.bottom - 36)
        current.scroller.scrollTop += Math.min(12, (y - rect.bottom + 36) / 3);
      if (current.scroller.scrollTop !== before) update(current.point);
      frame = requestAnimationFrame(scroll);
    };
    frame = requestAnimationFrame(scroll);
    document.addEventListener('keydown', escape, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', escape, true);
    };
  }, [dragging]);

  const ids = preview ? [...preview.ids] : [];
  if (preview) {
    ids.splice(preview.from, 1);
    ids.splice(preview.to, 0, preview.id);
  }
  function style(id: string): CSSProperties | undefined {
    if (!preview) return;
    const before = preview.slots[preview.ids.indexOf(id)];
    const after = preview.slots[ids.indexOf(id)];
    if (before && after)
      return { transform: `translate(${after.left - before.left}px, ${after.top - before.top}px)` };
  }
  let insertionStyle: CSSProperties | undefined;
  if (preview && preview.to !== preview.from) {
    const slot = preview.slots[preview.to];
    const previous = preview.slots[preview.to - 1];
    const horizontal = !previous || previous.top < slot.top;
    insertionStyle = {
      left: slot.left - (horizontal ? 0 : 9),
      top: slot.top - (horizontal ? 9 : 0),
      width: horizontal ? slot.width : 3,
      height: horizontal ? 3 : slot.height,
    };
  }
  return {
    preview,
    insertionStyle,
    style,
    start,
    events: {
      onPointerMove: (e: PointerEvent<HTMLOListElement>) => {
        if (gesture.current?.pointerId === e.pointerId) update(e);
      },
      onPointerUp: finish,
      onPointerCancel: cancel,
      onLostPointerCapture: cancel,
      onDragStart: (e: React.DragEvent<HTMLOListElement>) => e.preventDefault(),
    },
  };
}
