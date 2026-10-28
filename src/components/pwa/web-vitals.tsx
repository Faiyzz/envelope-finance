'use client';

import { useReportWebVitals } from 'next/web-vitals';

/** Web Vitals -> our own structured log. No third party (TD-12 §8.3). */
export function WebVitals() {
  useReportWebVitals((m) => {
    if (!['LCP', 'INP', 'CLS', 'FCP', 'TTFB'].includes(m.name)) return;
    const body = JSON.stringify({ name: m.name, value: Math.round(m.value * 1000) / 1000, rating: m.rating, nav: m.navigationType, path: location.pathname.replace(/[0-9a-f-]{36}/g, ':id') });
    navigator.sendBeacon?.('/api/vitals', new Blob([body], { type: 'application/json' }));
  });
  return null;
}
