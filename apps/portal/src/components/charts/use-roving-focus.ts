"use client";

import { type KeyboardEvent, useRef, useState } from "react";
export function useRovingFocus(count: number, onMove: (i: number) => void) {
  const [current, setCurrent] = useState(count - 1);
  const items = useRef<(HTMLElement | null)[]>([]);
  const focusIndex = Math.min(current, count - 1);
  function onKeyDown(e: KeyboardEvent) {
    const next =
      e.key === "ArrowRight" ? focusIndex + 1
      : e.key === "ArrowLeft" ? focusIndex - 1
      : e.key === "Home" ? 0
      : e.key === "End" ? count - 1
      : null;
    if (next === null) return;
    e.preventDefault();
    const i = Math.max(0, Math.min(count - 1, next));
    setCurrent(i);
    onMove(i);
    items.current[i]?.focus();
  }
  return {
    onKeyDown,
    item: (i: number) => ({
      tabIndex: i === focusIndex ? 0 : -1,
      ref: (el: HTMLElement | null) => {
        items.current[i] = el;
      },
      onFocusCapture: () => setCurrent(i),
    }),
  };
}
