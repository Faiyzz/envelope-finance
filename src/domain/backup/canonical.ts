/**
 * Canonical JSON + safe parsing - TD-11 §2, §4.2. Pure (hashing is done by the caller).
 */

/** Deterministic JSON: keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export const MAX_JSON_DEPTH = 20;

/** Depth of JSON text without parsing it (string-aware bracket scan). */
export function jsonDepth(text: string): number {
  let depth = 0;
  let max = 0;
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inStr) {
      if (c === 92) i++; // backslash escape
      else if (c === 34) inStr = false;
      continue;
    }
    if (c === 34) inStr = true;
    else if (c === 123 || c === 91) {
      depth++;
      if (depth > max) max = depth;
    } else if (c === 125 || c === 93) depth--;
  }
  return max;
}

export type SafeParse = { ok: true; value: unknown } | { ok: false; message: string };

export function parseJsonSafe(text: string, maxDepth = MAX_JSON_DEPTH): SafeParse {
  if (jsonDepth(text) > maxDepth) return { ok: false, message: 'This file is nested too deeply to be a backup.' };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, message: "This file isn't valid JSON, so it can't be a backup." };
  }
}
