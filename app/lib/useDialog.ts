'use client';
import { useEffect, useRef } from 'react';
const dialogs: HTMLElement[] = [];
let previousOverflow = '';
export function useDialog(selector: string, onClose: () => void, active = true) {
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);
  useEffect(() => {
    if (!active) return;
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) return;
    const previous = document.activeElement as HTMLElement | null;
    if (!dialogs.length) { previousOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; }
    dialogs.push(element);
    const targets = () => Array.from(element.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"], [contenteditable="true"]')).filter(item => item.getClientRects().length > 0);
    element.tabIndex = -1;
    (targets()[0] ?? element).focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (dialogs.at(-1) !== element) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close.current(); }
      if (event.key !== 'Tab') return;
      const focusable = targets();
      const first = focusable[0], last = focusable.at(-1);
      if (!first) { event.preventDefault(); element.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !element.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !element.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown, true);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      const index = dialogs.indexOf(element);
      if (index >= 0) dialogs.splice(index, 1);
      if (!dialogs.length) document.body.style.overflow = previousOverflow;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [selector, active]);
}
