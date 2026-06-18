/**
 * Display formatters. Calculations carry full precision — round ONLY here.
 * (CALCULATION_RULES.md §"Rounding & formatting".)
 */

import type { CurrencyCode } from "../types/contracts";

const BIG_NUMBER_SUFFIXES: Array<[number, string]> = [
  [1_000_000_000_000, "T"],
  [1_000_000_000, "B"],
  [1_000_000, "M"],
  [1_000, "K"],
];

/** Compact money: $12.4B, €3.0B, ¥1.2M. Currency ALWAYS shown (CLAUDE.md rule 5). */
export function formatMoneyCompact(
  value: number | null | undefined,
  currency: CurrencyCode,
  options: { decimals?: number } = {},
): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const decimals = options.decimals ?? 1;
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  for (const [scale, suffix] of BIG_NUMBER_SUFFIXES) {
    if (abs >= scale) {
      return `${sign}${(abs / scale).toFixed(decimals)}${suffix} ${currency}`;
    }
  }
  return `${sign}${abs.toFixed(0)} ${currency}`;
}

/** Full money: $12,400,000,000. Use in tooltips / detail panels. */
export function formatMoneyFull(
  value: number | null | undefined,
  currency: CurrencyCode,
): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    // Unknown ISO code — fall back to a manual format with the literal code.
    return `${value.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${currency}`;
  }
}

/** Ratio in [0,1] → "18.2%" (1 dp by default). null → "—". */
export function formatPercent(
  value: number | null | undefined,
  decimals = 1,
): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${(value * 100).toFixed(decimals)}%`;
}

/** Integer with thousands separators. */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return Math.trunc(value).toLocaleString();
}
