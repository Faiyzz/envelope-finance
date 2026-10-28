/**
 * Versioned migrators - TD-11 §4.3.2. Each step is a pure function n -> n+1.
 * Only v1 exists today; the framework is exercised with fixtures in tests.
 */

import { CURRENT_SCHEMA_VERSION } from './schema';

export type Migrator = (doc: Record<string, unknown>) => Record<string, unknown>;

/** migrators[n] upgrades a version-n document to n+1. */
export const migrators: Record<number, Migrator> = {};

export type MigrateResult =
  | { ok: true; doc: Record<string, unknown> }
  | { ok: false; message: string };

export function migrate(raw: unknown, steps: Record<number, Migrator> = migrators, target = CURRENT_SCHEMA_VERSION): MigrateResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: "This file doesn't look like an Envelope Finance backup." };
  }
  let doc = raw as Record<string, unknown>;
  const v = doc.schema_version;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    return { ok: false, message: "This file doesn't look like an Envelope Finance backup." };
  }
  if (v > target) return { ok: false, message: 'This backup was made by a newer version of the app.' };
  for (let n = v; n < target; n++) {
    const step = steps[n];
    if (!step) return { ok: false, message: `This backup (version ${v}) can't be upgraded.` };
    doc = { ...step(doc), schema_version: n + 1 };
  }
  return { ok: true, doc };
}
