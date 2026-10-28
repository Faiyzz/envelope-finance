import { DataPanel } from '@/components/settings/data-panel';
import { msg } from '@/messages/en';

export default function DataPage() {
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-bold">{msg.data.title()}</h1>
      <DataPanel />
    </div>
  );
}
