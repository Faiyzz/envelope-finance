/**
 * Money utilities - TD-01 §2
 * 
 * Pure TypeScript. No floating point. All amounts are integer paisa.
 */

export type Paisa = bigint & { readonly __brand: 'Paisa' };
export const MAX_PAISA = 99_999_999_999n as Paisa; // 999,999,999.99 PKR
export const PAISA_PER_RUPEE = 100n;

export function paisa(n: bigint): Paisa {
  if (n < 0n || n > MAX_PAISA) {
    throw new Error(`Paisa out of range: ${n}`);
  }
  return n as Paisa;
}

export type ParseResult =
  | { ok: true; value: Paisa }
  | { ok: false; reason: ParseFailure };

export type ParseFailure =
  | 'EMPTY'
  | 'FORMAT'
  | 'TOO_MANY_DECIMALS'
  | 'NOT_POSITIVE'
  | 'TOO_LARGE'
  | 'BAD_GROUPING';

/**
 * Parse money string to paisa
 * Pipeline: normalise → validate → convert
 */
export function parseMoney(
  input: string,
  opts?: { allowZero?: boolean; allowNegative?: boolean }
): ParseResult {
  // 1. Trim and normalise
  let s = input.trim();
  
  // Remove internal spaces and NBSP
  s = s.replace(/[\s\u00A0]/g, '');
  
  // Remove Arabic grouping separators
  s = s.replace(/[\u066C\u060C]/g, '');
  
  // 2. Digit normalisation (Arabic-Indic and Urdu digits)
  s = s.replace(/[\u0660-\u0669]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x0660 + 0x30));
  s = s.replace(/[\u06F0-\u06F9]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x06F0 + 0x30));
  
  // Arabic decimal separator
  s = s.replace(/\u066B/g, '.');
  
  if (s.length === 0) {
    return { ok: false, reason: 'EMPTY' };
  }
  
  // 3. Grammar validation
  const plain = /^\d+(\.\d{1,2})?$/;
  const westernGrouping = /^\d{1,3}(,\d{3})+(\.\d{1,2})?$/;
  const lakhGrouping = /^\d{1,2}(,\d{2})*,\d{3}(\.\d{1,2})?$/;
  
  if (!plain.test(s) && !westernGrouping.test(s) && !lakhGrouping.test(s)) {
    if (s.includes(',') && !westernGrouping.test(s) && !lakhGrouping.test(s)) {
      return { ok: false, reason: 'BAD_GROUPING' };
    }
    if (s.includes('.') && (s.split('.')[1]?.length ?? 0) > 2) {
      return { ok: false, reason: 'TOO_MANY_DECIMALS' };
    }
    return { ok: false, reason: 'FORMAT' };
  }
  
  // Check for invalid characters
  if (/[^0-9.,]/.test(s)) {
    return { ok: false, reason: 'FORMAT' };
  }
  
  // Check for negative sign (only allowed if allowNegative)
  if (s.startsWith('-') && !opts?.allowNegative) {
    return { ok: false, reason: 'NOT_POSITIVE' };
  }
  
  // 4. Convert
  const withoutCommas = s.replace(/,/g, '');
  const parts = withoutCommas.split('.');
  const intPart = parts[0] ?? '0';
  const fracPart = parts[1] ?? '';
  
  // Handle case where there's no decimal part
  if (parts.length === 1) {
    const intPaisa = BigInt(intPart);
    if (intPaisa > MAX_PAISA) {
      return { ok: false, reason: 'TOO_LARGE' };
    }
    const total = intPaisa * PAISA_PER_RUPEE;
    if (!opts?.allowNegative && total < 0n) {
      return { ok: false, reason: 'NOT_POSITIVE' };
    }
    if (!opts?.allowZero && total === 0n) {
      return { ok: false, reason: 'NOT_POSITIVE' };
    }
    if (total > MAX_PAISA) {
      return { ok: false, reason: 'TOO_LARGE' };
    }
    return { ok: true, value: total as Paisa };
  }
  
  if (intPart.length > 11) { // More than 999,999,999.99
    return { ok: false, reason: 'TOO_LARGE' };
  }
  
  const intPaisa = BigInt(intPart);
  const fracPaisa = fracPart.length > 0 
    ? BigInt(fracPart.padEnd(2, '0').slice(0, 2))
    : 0n;
  
  const total = intPaisa * PAISA_PER_RUPEE + fracPaisa;
  
  // 5. Range check
  if (!opts?.allowNegative && total < 0n) {
    return { ok: false, reason: 'NOT_POSITIVE' };
  }
  
  if (!opts?.allowZero && total === 0n) {
    return { ok: false, reason: 'NOT_POSITIVE' };
  }
  
  if (total > MAX_PAISA) {
    return { ok: false, reason: 'TOO_LARGE' };
  }
  
  if (total < -MAX_PAISA) {
    return { ok: false, reason: 'TOO_LARGE' };
  }
  
  return { ok: true, value: total as Paisa };
}

/**
 * Calculator expression: "1200+350"
 * Grammar: term ('+' term)*
 * Only + allowed (TD-D10)
 */
export function evaluateAmountExpression(input: string): ParseResult {
  const trimmed = input.trim();
  
  if (!trimmed) {
    return { ok: false, reason: 'EMPTY' };
  }
  
  // Trailing + is invalid
  if (trimmed.endsWith('+')) {
    return { ok: false, reason: 'FORMAT' };
  }
  
  const terms = trimmed.split('+');
  if (terms.length < 2) {
    // Single term - parse directly
    return parseMoney(trimmed, { allowZero: false });
  }
  
  let sum = 0n;
  
  for (const term of terms) {
    const result = parseMoney(term, { allowZero: false });
    if (!result.ok) {
      return result;
    }
    sum += result.value;
  }
  
  // Re-check range
  if (sum > MAX_PAISA) {
    return { ok: false, reason: 'TOO_LARGE' };
  }
  
  return { ok: true, value: sum as Paisa };
}

/**
 * Format paisa to display string
 */
export function formatMoney(
  p: Paisa,
  opts?: {
    decimals?: 'auto' | 'always' | 'never';
    sign?: 'auto' | 'always';
    currency?: boolean;
    grouping?: 'western' | 'lakh';
  }
): string {
  const decimals = opts?.decimals ?? 'auto';
  const sign = opts?.sign ?? 'auto';
  const showCurrency = opts?.currency ?? true;
  const grouping = opts?.grouping ?? 'western';
  
  const absP = p < 0n ? -p : p;
  const isNegative = p < 0n;
  
  const rupees = absP / PAISA_PER_RUPEE;
  const paisaRemainder = absP % PAISA_PER_RUPEE;
  
  // Format rupees with grouping
  const rupeesStr = formatNumberGrouping(Number(rupees), grouping);
  
  let result: string;
  
  if (decimals === 'always' || (decimals === 'auto' && paisaRemainder > 0n)) {
    const paisaStr = paisaRemainder.toString().padStart(2, '0');
    result = `${rupeesStr}.${paisaStr}`;
  } else {
    result = rupeesStr;
  }
  
  // Add sign
  if (isNegative || sign === 'always') {
    result = isNegative ? `−${result}` : `+${result}`;
  }
  
  // Add currency
  if (showCurrency) {
    result = `${result} PKR`;
  }
  
  return result;
}

function formatNumberGrouping(n: number, grouping: 'western' | 'lakh'): string {
  const str = Math.floor(n).toString();
  
  if (grouping === 'lakh') {
    // Lakh grouping: 2,00,000
    const parts: string[] = [];
    let i = str.length;
    
    // Last 3 digits
    if (i > 3) {
      parts.unshift(str.slice(i - 3));
      i -= 3;
    } else {
      return str;
    }
    
    // Then pairs
    while (i > 0) {
      parts.unshift(str.slice(Math.max(0, i - 2), i));
      i -= 2;
    }
    
    return parts.join(',');
  }
  
  // Western grouping: 200,000
  return str.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Arithmetic operations
export function add(a: Paisa, b: Paisa): Paisa {
  const sum = a + b;
  if (sum > MAX_PAISA || sum < -MAX_PAISA) {
    throw new Error('Addition overflow');
  }
  return sum as Paisa;
}

export function sub(a: Paisa, b: Paisa): Paisa {
  const diff = a - b;
  if (diff > MAX_PAISA || diff < -MAX_PAISA) {
    throw new Error('Subtraction overflow');
  }
  return diff as Paisa;
}

export function neg(a: Paisa): Paisa {
  return (-a) as Paisa;
}

export function abs(a: Paisa): Paisa {
  return (a < 0n ? -a : a) as Paisa;
}

export function cmp(a: Paisa, b: Paisa): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function min(a: Paisa, b: Paisa): Paisa {
  return (a < b ? a : b) as Paisa;
}

export function max(a: Paisa, b: Paisa): Paisa {
  return (a > b ? a : b) as Paisa;
}

export function sum(ps: Paisa[]): Paisa {
  let total = 0n;
  for (const p of ps) {
    total += p;
  }
  if (total > MAX_PAISA || total < -MAX_PAISA) {
    throw new Error('Sum overflow');
  }
  return total as Paisa;
}
