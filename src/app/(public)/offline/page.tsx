import { OfflineViewer } from '@/components/pwa/offline-viewer';

// Static + precached by the service worker (TD-12 §4). Reads only IndexedDB.
export const dynamic = 'force-static';

export default function OfflinePage() {
  return <main><OfflineViewer /></main>;
}
