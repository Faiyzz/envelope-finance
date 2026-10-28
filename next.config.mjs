import withSerwistInit from '@serwist/next';
import { randomUUID } from 'node:crypto';

// Revision for the precached offline shell: changes every build.
const revision = process.env.APP_VERSION && process.env.APP_VERSION !== 'dev' ? process.env.APP_VERSION : randomUUID();

const withSerwist = withSerwistInit({
  swSrc: 'src/app/sw.ts',
  swDest: 'public/sw.js',
  disable: process.env.NODE_ENV !== 'production', // TD-12 §4: disabled in development
  register: false, // registered manually so updates never swap mid-form (TD-12 §6)
  cacheOnNavigation: false, // authenticated HTML is never stored
  reloadOnOnline: false,
  additionalPrecacheEntries: [{ url: '/offline', revision }],
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    serverActions: { bodySizeLimit: '2mb' },
    optimizePackageImports: ['lucide-react', 'framer-motion'],
  },
  async headers() {
    return [
      // The worker must always be revalidated so updates are noticed (TD-12 §6)
      { source: '/sw.js', headers: [
        { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
        { key: 'Service-Worker-Allowed', value: '/' },
      ] },
      { source: '/icons/:path*', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
      // Authenticated HTML/JSON must not be stored by shared caches (TD-02 §7)
      { source: '/((?!_next/static|_next/image|icons|favicon.ico).*)', headers: [{ key: 'Cache-Control', value: 'private, no-store' }] },
    ];
  },
};

export default withSerwist(nextConfig);
