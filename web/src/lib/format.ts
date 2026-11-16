/** A price as a plain number, no currency, Indonesian grouping: "70", "1.000", "4.280,5". */
export function amount(value: number): string {
  return value.toLocaleString("id-ID", { maximumFractionDigits: 2 });
}

/** Per-page price label: "70 / page", or "Coming soon" when the tier is not priced. */
export function perPage(price: number | null): string {
  if (price === null) return "Coming soon";
  return `${amount(price)} / page`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function duration(from: string | null, to: string | null): string {
  if (!from) return "–";
  const seconds = Math.max(0, Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  return m < 60 ? `${m}m ${seconds % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "1-5, 9, 12-13" */
export function pageRanges(pages: number[]): string {
  const out: string[] = [];
  let start: number | null = null;
  let prev: number | null = null;
  for (const p of [...pages].sort((a, b) => a - b)) {
    if (start === null) start = prev = p;
    else if (p === (prev as number) + 1) prev = p;
    else {
      out.push(start === prev ? `${start}` : `${start}-${prev}`);
      start = prev = p;
    }
  }
  if (start !== null) out.push(start === prev ? `${start}` : `${start}-${prev}`);
  return out.join(", ");
}

/** A provider cost in US dollars: cents above $1, otherwise enough digits to show fractions of a cent. */
export function usd(value: number | null | undefined): string {
  if (value == null) return "–";
  if (value === 0) return "$0";
  if (value >= 1) return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  // two significant digits, never in exponent notation (embedding a page costs ~$0.000002)
  const digits = Math.min(10, Math.max(2, 1 - Math.floor(Math.log10(value))));
  return `$${value.toFixed(digits).replace(/0+$/, "")}`;
}
