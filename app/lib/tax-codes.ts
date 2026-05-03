// DHL Express Germany invoice tax codes — what the single-letter "Tax Code"
// column on the invoice CSV actually means. Used by the audit UI to display a
// human-readable label next to the rate.

export const TAX_CODE_INFO: Record<string, { rate: number; label: string; description: string }> = {
  A: { rate: 0.19, label: "German VAT 19%",  description: "Standard VAT — Germany 19%" },
  B: { rate: 0.07, label: "German VAT 7%",   description: "Reduced VAT — Germany 7%" },
  C: { rate: 0.00, label: "Zero-rated",      description: "Zero-rated — intl. transport (Art. 146)" },
  X: { rate: 0.00, label: "Tax-exempt",      description: "Tax-exempt / suspended" },
  Z: { rate: 0.00, label: "Pass-through",    description: "Zero / pass-through (duties)" },
};
