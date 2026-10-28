import type { MetadataRoute } from 'next';

/** Web app manifest - TD-12 §2 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Envelope Finance',
    short_name: 'Envelopes',
    description: 'Virtual-envelope money management over one bank balance.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0b0f14',
    theme_color: '#4f46e5',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Add expense', url: '/?add=expense', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
      { name: 'Dashboard', url: '/' },
    ],
  };
}
