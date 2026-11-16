"use client";
/* Visualisasi SVG murni — tanpa dependensi chart, digambar dari data API. */

export function Donut({ data, size = 150 }: { data: { label: string; value: number; color: string }[]; size?: number }) {
  const total = Math.max(1, data.reduce((a, d) => a + d.value, 0));
  const r = 52, c = 2 * Math.PI * r;
  let acc = 0;
  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} viewBox="0 0 140 140" role="img" aria-label="Donut distribusi">
        {data.map((d) => {
          const frac = d.value / total;
          const el = (
            <circle key={d.label} cx="70" cy="70" r={r} fill="none" stroke={d.color} strokeWidth="17"
              strokeDasharray={`${frac * c} ${c}`} strokeDashoffset={-acc * c} transform="rotate(-90 70 70)" />
          );
          acc += frac;
          return el;
        })}
        <text x="70" y="66" textAnchor="middle" fill="#f1f5fb" fontSize="21" fontWeight="700">{total}</text>
        <text x="70" y="84" textAnchor="middle" fill="#8391a7" fontSize="9">klaim</text>
      </svg>
      <ul className="space-y-1.5 text-xs">
        {data.map((d) => (
          <li key={d.label} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: d.color }} />
            <span className="text-soft">{d.label}</span>
            <span className="ml-auto pl-3 tabular-nums font-semibold">{d.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function HBars({ data, format }: { data: { label: string; value: number; color: string }[]; format?: (v: number) => string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="space-y-2">
      {data.map((d) => (
        <div key={d.label} className="grid grid-cols-[150px_1fr_84px] items-center gap-2 text-xs">
          <span className="truncate text-soft" title={d.label}>{d.label}</span>
          <span className="h-4 overflow-hidden rounded bg-line/60"><span className="block h-full rounded" style={{ width: `${Math.max(2, (d.value / max) * 100)}%`, background: d.color }} /></span>
          <span className="text-right tabular-nums font-medium">{format ? format(d.value) : d.value}</span>
        </div>
      ))}
    </div>
  );
}

/** Gauge setengah lingkaran untuk skor 0-100. */
export function Gauge({ value }: { value: number }) {
  const frac = Math.max(0, Math.min(100, value)) / 100;
  const color = value >= 70 ? "#f0616d" : value >= 50 ? "#f0a843" : value >= 30 ? "#e2b866" : "#34c38f";
  const angle = Math.PI * (1 - frac);
  const x = 80 + 62 * Math.cos(angle), y = 84 - 62 * Math.sin(angle);
  return (
    <svg width="170" height="100" viewBox="0 0 160 95" role="img" aria-label={`Skor ${value}`}>
      <path d="M 18 84 A 62 62 0 0 1 142 84" fill="none" stroke="#1d2735" strokeWidth="13" strokeLinecap="round" />
      <path d="M 18 84 A 62 62 0 0 1 142 84" fill="none" stroke={color} strokeWidth="13" strokeLinecap="round"
        strokeDasharray={`${frac * 195} 195`} />
      <line x1="80" y1="84" x2={x} y2={y} stroke="#f1f5fb" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="80" cy="84" r="5" fill="#f1f5fb" />
      <text x="80" y="72" textAnchor="middle" fill="#f1f5fb" fontSize="19" fontWeight="700">{value}</text>
    </svg>
  );
}

/** Timeline vertikal kronologi kasus. */
export function Timeline({ items }: { items: { tanggal: string; kejadian: string; sumber: string }[] }) {
  return (
    <ol className="relative space-y-3">
      <span className="absolute bottom-1 left-[5px] top-1 w-px bg-line-2" aria-hidden />
      {items.map((k, i) => (
        <li key={i} className="relative flex gap-3 pl-5 text-xs">
          <span className={`absolute left-0 top-1 h-[11px] w-[11px] rounded-full ring-4 ring-panel ${k.sumber === "Fraud engine" ? "bg-bad" : "bg-ocean"}`} />
          <span className="w-[74px] shrink-0 tabular-nums text-muted">{k.tanggal}</span>
          <span className="text-soft">{k.kejadian} <span className="text-muted">· {k.sumber}</span></span>
        </li>
      ))}
    </ol>
  );
}
