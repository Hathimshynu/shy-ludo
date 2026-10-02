import { useEffect } from 'react';
import { BRAND } from '@ludo/config';

const SITE = (import.meta.env.VITE_SITE_URL || window.location.origin).replace(/\/$/, '');

function setMeta(selector: string, attr: string, value: string): void {
  let el = document.head.querySelector<HTMLMetaElement | HTMLLinkElement>(selector);
  if (!el) {
    const [tag, rest] = selector.split('[');
    el = document.createElement(tag as 'meta');
    const [k, v] = rest!.replace(']', '').split('=');
    el.setAttribute(k!, v!.replace(/"/g, ''));
    document.head.appendChild(el);
  }
  el.setAttribute(attr, value);
}

/** Per-route title, description, canonical URL and robots directives. */
export function usePageMeta(opts: { title?: string; description?: string; path?: string; noindex?: boolean }): void {
  useEffect(() => {
    document.title = opts.title ? `${opts.title} · ${BRAND.name}` : `${BRAND.name} — 3D Online Ludo for 2–8 Players`;
    setMeta('meta[name="description"]', 'content', opts.description ?? BRAND.description);
    setMeta('meta[name="robots"]', 'content', opts.noindex ? 'noindex, nofollow' : 'index, follow');
    if (opts.path !== undefined) setMeta('link[rel="canonical"]', 'href', `${SITE}${opts.path}`);
  }, [opts.title, opts.description, opts.path, opts.noindex]);
}
