'use client';
import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
const STORAGE_WARNING_EVENT = 'neuro2026:storage-warning';

// Read at the point of mutation to avoid overwriting another tab's latest change.
export function useLocalRecord<T>(key: string, initial: T, decode: (value: unknown) => T) {
  const [value, setValue] = useState(initial);
  const current = useRef(initial);
  const initialValue = useRef(initial);
  const dirty = useRef(false);
  const decodeRef = useRef(decode);
  useEffect(() => {
    const sync = () => {
      if (dirty.current) return;
      try {
        const raw = localStorage.getItem(key);
        const next = raw === null ? initialValue.current : decodeRef.current(JSON.parse(raw));
        current.current = next; setValue(next);
      } catch { /* Never overwrite unreadable storage during initialization. */ }
    };
    queueMicrotask(sync);
    const onStorage = (event: StorageEvent) => { if (event.key === key || event.key === null) sync(); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [key]);
  const update = useCallback((action: SetStateAction<T>) => {
    let base = current.current;
    if (!dirty.current) {
      try { const raw = localStorage.getItem(key); base = raw === null ? initialValue.current : decodeRef.current(JSON.parse(raw)); } catch { /* retain current session */ }
    }
    const next = typeof action === 'function' ? (action as (previous: T) => T)(base) : action;
    current.current = next; setValue(next);
    try { localStorage.setItem(key, JSON.stringify(next)); dirty.current = false; }
    catch { dirty.current = true; window.dispatchEvent(new Event(STORAGE_WARNING_EVENT)); }
  }, [key]);
  return [value, update] as const;
}
