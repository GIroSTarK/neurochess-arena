export function formatUsd(amount: string, locale: string) {
  const [whole = "0", fraction = ""] = amount.split(".");
  const significant = fraction.replace(/0+$/, "").padEnd(2, "0");
  const digits = new Intl.NumberFormat(locale, {
    useGrouping: false,
    minimumIntegerDigits: significant.length,
    maximumFractionDigits: 0,
  }).format(Number(significant));
  // Format the whole amount separately so even large totals retain every pico-USD digit.
  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD" })
    .formatToParts(BigInt(whole))
    .map((part) => (part.type === "fraction" ? digits : part.value))
    .join("");
}
