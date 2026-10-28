/**
 * Category picker ordering - TD-05 §9.3 / FR-CAT-02. Pure.
 *
 * 1) categories recently used with this envelope (max 5, most recent first)
 * 2) group heuristic: envelope name contains home|house -> Home group first, else Personal first
 * 3) the rest alphabetically
 * 4) system "Uncategorized" always last
 */

export interface PickerCategory {
  id: string;
  name: string;
  groupName: 'home' | 'personal' | 'other' | null;
  isSystem: boolean;
}

export function orderCategories<T extends PickerCategory>(
  categories: T[],
  envelopeName: string,
  recentIds: string[]
): T[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const out: T[] = [];
  const used = new Set<string>();

  for (const id of recentIds.slice(0, 5)) {
    const c = byId.get(id);
    if (c && !c.isSystem && !used.has(id)) {
      out.push(c);
      used.add(id);
    }
  }

  const homeFirst = /home|house/i.test(envelopeName);
  const rank = (c: T) => {
    const g = c.groupName;
    if (homeFirst) return g === 'home' ? 0 : g === 'personal' ? 1 : 2;
    return g === 'personal' ? 0 : g === 'home' ? 1 : 2;
  };

  const rest = categories
    .filter((c) => !used.has(c.id) && !c.isSystem)
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  out.push(...rest);
  out.push(...categories.filter((c) => c.isSystem));
  return out;
}
