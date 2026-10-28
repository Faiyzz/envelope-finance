/**
 * Money types - TD-00 §4.1
 * 
 * Paisa is a branded bigint. On the wire (JSON/Server Action boundary),
 * it's a decimal string of integer paisa (e.g., "250050").
 */

export type Paisa = bigint & { readonly __brand: unique symbol };

export const PAISA_PER_RUPEE = 100n;
export const MAX_PAISA = 99999999999n; // 999,999,999.99 PKR

export function paisa(value: bigint): Paisa {
  if (value < 0n) {
    throw new Error('Paisa cannot be negative');
  }
  if (value > MAX_PAISA) {
    throw new Error('Amount exceeds maximum');
  }
  return value as Paisa;
}

export function asPaisa(value: bigint): Paisa {
  return value as Paisa;
}
