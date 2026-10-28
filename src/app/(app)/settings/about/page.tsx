import { AboutPanel } from '@/components/pwa/about-panel';
import { msg } from '@/messages/en';

export default function AboutPage() {
  return (
    <div className="grid gap-4">
      <h1 className="text-2xl font-bold">{msg.pwa.aboutTitle()}</h1>
      <AboutPanel version={process.env.NEXT_PUBLIC_APP_VERSION ?? 'dev'} />
    </div>
  );
}
