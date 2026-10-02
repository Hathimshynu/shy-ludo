import { useEffect, useRef } from 'react';

/**
 * Hardware/browser back-button handling (Android in particular).
 *
 * While a guard is active, one extra history entry (same URL) sits on top of the stack.
 * Pressing Back pops that entry; we immediately restore it and call the top-most
 * handler — e.g. close the open bottom sheet, or ask "Leave this game?". Guards nest:
 * only the most recently activated one handles Back.
 *
 * When a guard deactivates normally (sheet closed with a button) its entry is removed
 * again with `history.back()`, which we ignore. If the user navigated away instead,
 * the entry is no longer on top and is left alone, so normal navigation is unaffected.
 */
type Handler = { current: () => void };
const stack: Handler[] = [];
let ignorePops = 0;
let listening = false;

function onPopState(): void {
  if (ignorePops > 0) {
    ignorePops -= 1;
    return;
  }
  const top = stack[stack.length - 1];
  if (!top) return;
  // Re-arm the guard so the next Back press is caught too.
  window.history.pushState({ ...(window.history.state as object), ludoGuard: stack.length }, '', window.location.href);
  top.current();
}

export function useBackGuard(active: boolean, handler: () => void): void {
  const ref = useRef(handler);
  ref.current = handler;

  useEffect(() => {
    if (!active) return;
    if (!listening) {
      window.addEventListener('popstate', onPopState);
      listening = true;
    }
    const entry: Handler = { current: () => ref.current() };
    stack.push(entry);
    const depth = stack.length;
    window.history.pushState({ ...(window.history.state as object), ludoGuard: depth }, '', window.location.href);
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      const state = window.history.state as { ludoGuard?: number } | null;
      if (state?.ludoGuard === depth) {
        ignorePops += 1;
        window.history.back();
      }
    };
  }, [active]);
}
