// Number formatting helpers — thousand separators everywhere so 91794.15 EUR
// reads as "91,794.15 EUR" and not as one indistinguishable blob of digits.
//
// We render in en-US (1,234.56) regardless of the user's locale because:
//   1) the underlying CSV values come from DHL in mixed locales (DE/FR/UK) and
//      the parser already normalises them to a JS Number — so display locale
//      is purely a UI choice;
//   2) the team operates in English internally;
//   3) consistency beats locale-correctness for an internal audit tool.

const moneyFmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const intFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function fmtMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return moneyFmt.format(n);
}

// Signed amount with a real minus sign and currency symbol prefix. Values
// rounded-to-zero-at-cent are rendered as "€0.00" (not "+€0.00").
export function fmtMoneySigned(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (Math.abs(n) < 0.005) return "€0.00";
  return (n > 0 ? "+€" : "−€") + moneyFmt.format(Math.abs(n));
}

export function fmtMoneyWithCurrency(n: number | null | undefined, currency: string | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${moneyFmt.format(n)} ${currency ?? ""}`.trim();
}

export function fmtInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return intFmt.format(n);
}
