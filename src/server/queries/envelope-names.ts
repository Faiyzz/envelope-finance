import { getEnvelopeList } from '@/server/repositories/envelopes';

/** id -> name for every envelope (incl. archived), for labelling ledger rows. */
export async function envelopeNames(userId: string): Promise<Record<string, string>> {
  const list = await getEnvelopeList(userId, { includeArchived: true });
  return Object.fromEntries(list.map((e) => [e.id, e.name]));
}
