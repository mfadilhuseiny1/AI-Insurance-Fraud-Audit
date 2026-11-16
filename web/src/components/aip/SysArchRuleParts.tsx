"use client";

// System Architecture · rule engine parts: the status chip, a backtest result (Uji) as a picture with its table, the field
// catalogue, and the draft editor where an AI draft (or a rule being changed) is read, edited and saved — its condition
// checked live by the backend's parser (POST /aturan/validasi) while it is typed.

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { usd, wib } from "./aipRun";
import { ChartCard, SERIES, Tooltip, useTip } from "./viz";
import { Angka, Batang, Chip, Tabel, idn, masukan, pct, pctAuto, tombolNetral, tombolUtama, type Nada } from "./SysArchShared";
import { aturanApi, pesan, type Aturan, type AturanIn, type Bawaan, type Draf, type Katalog, type Perubahan, type Uji, type Validasi } from "./SysArchRuleApi";

export const STATUS: Record<string, { label: string; nada: Nada }> = {
  draf: { label: "draf", nada: "netral" }, diuji: { label: "diuji", nada: "biru" }, menunggu: { label: "menunggu persetujuan", nada: "kuning" },
  aktif: { label: "aktif", nada: "hijau" }, ditolak: { label: "ditolak", nada: "merah" }, nonaktif: { label: "nonaktif", nada: "redup" },
};
export function StatusChip({ s }: { s?: string | null }) {
  const x = STATUS[s ?? ""] ?? { label: s || "—", nada: "netral" as Nada };
  return <Chip nada={x.nada}>{x.label}</Chip>;
}
export const waktu = (s?: string | null) => (s ? wib(s) || s : "");

// ------------------------------------------------------------------------------------------------ backtest

const NORMAL = "#8f99a8", FRAUD = SERIES[0];

/** a backtest: what the rule hits in normal claims and in fraud, per fraud scheme, and what it adds to the active rules */
export function UjiView({ uji, versiAturan }: { uji: Uji; versiAturan?: number }) {
  const { box, tip, at, clear } = useTip();
  const kena = uji.kena ?? { normal: 0, fraud: 0 };
  const skema = [...(uji.per_skema ?? [])].filter((s) => s.n > 0).sort((a, b) => b.kena / b.n - a.kena / a.n);
  const tersentuh = skema.filter((s) => s.kena > 0).length;
  const basi = versiAturan != null && uji.versi != null && uji.versi !== versiAturan;
  const laju = [
    { k: "normal", nama: "Klaim normal yang kena", v: uji.laju_normal, n: kena.normal, dari: uji.normal, warna: NORMAL },
    { k: "fraud", nama: "Fraud yang kena (recall)", v: uji.recall, n: kena.fraud, dari: uji.fraud, warna: FRAUD },
  ];
  const tabel = (
    <Tabel kepala={["Kelompok", "Kena", "Dari", "Porsi"]} kanan={[1, 2, 3]}
      baris={[...laju.map((l) => [l.nama, idn(l.n), idn(l.dari), pct(l.v, 2)]), ...skema.map((s) => [`Skema · ${s.label || s.skema}`, idn(s.kena), idn(s.n), pct(s.kena / s.n, 1)])]} />
  );
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-1.5 text-[10.5px] text-[#8f99a8]">
        {uji.versi != null && <Chip nada={basi ? "kuning" : "biru"} ikon={basi ? "alert" : "check"}>{basi ? `uji untuk versi ${uji.versi}, rule sekarang versi ${versiAturan}: uji ulang` : `uji versi ${uji.versi}`}</Chip>}
        {uji.data && <span>{uji.data}</span>}
        {uji.waktu && <span>· {waktu(uji.waktu)}</span>}
        {uji.detik != null && <span>· {idn(uji.detik, 1)} detik</span>}
      </div>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
        <Angka label="Klaim normal kena" nilai={pct(uji.laju_normal, 2)} sub={`${idn(kena.normal)} dari ${idn(uji.normal ?? 0)}`} />
        <Angka label="Fraud kena (recall)" nilai={pct(uji.recall, 1)} sub={`${idn(kena.fraud)} dari ${idn(uji.fraud ?? 0)}`} />
        <Angka label="Precision" nilai={uji.precision == null ? "—" : pct(uji.precision, 1)} sub="tanda yang benar fraud" />
        <Angka label="Beban per hari" nilai={uji.beban_per_hari == null ? "—" : idn(uji.beban_per_hari, uji.beban_per_hari < 10 ? 1 : 0)} sub="klaim ditandai per hari" />
        <Angka label="Fraud baru vs rule aktif" nilai={uji.unik?.fraud_baru_vs_rule == null ? "—" : idn(uji.unik.fraud_baru_vs_rule)}
          sub={uji.unik?.fraud_baru_vs_keputusan == null ? undefined : `${idn(uji.unik.fraud_baru_vs_keputusan)} belum tertangkap PERIKSA/TAHAN`} />
      </div>
      <ChartCard title="Hasil uji" insight={skema.length ? `${tersentuh} dari ${skema.length} skema fraud tersentuh rule ini.` : undefined} table={tabel}>
        <div ref={box} className="relative space-y-3" onPointerLeave={clear}>
          <div className="space-y-1.5">
            {laju.map((l) => (
              <div key={l.k} tabIndex={0} className="grid items-center gap-2 outline-none" style={{ gridTemplateColumns: "minmax(0, 36%) 1fr" }}
                onPointerMove={(e) => at(e, { title: l.nama, lines: [{ key: l.warna, value: pct(l.v, 2), label: `${idn(l.n)} dari ${idn(l.dari)}` }] })}
                onFocus={(e) => at(e, { title: l.nama, lines: [{ key: l.warna, value: pct(l.v, 2), label: `${idn(l.n)} dari ${idn(l.dari)}` }] })} onBlur={clear}>
                <span className="truncate text-[11.5px] text-[#e5e8eb]">{l.nama}</span>
                <Batang nilai={l.v} warna={l.warna} label={pctAuto(l.v)} tinggi={10} />
              </div>
            ))}
          </div>
          {!!skema.length && (
            <div>
              <p className="mb-1 text-[11px] text-[#abb3bf]">Recall per skema fraud</p>
              <div className="space-y-1">
                {skema.map((s) => (
                  <div key={s.skema} tabIndex={0} className="grid items-center gap-2 outline-none" style={{ gridTemplateColumns: "minmax(0, 36%) 1fr" }}
                    onPointerMove={(e) => at(e, { title: s.label || s.skema, lines: [{ key: FRAUD, value: pct(s.kena / s.n, 1), label: `${idn(s.kena)} dari ${idn(s.n)} fraud` }] })}
                    onFocus={(e) => at(e, { title: s.label || s.skema, lines: [{ key: FRAUD, value: pct(s.kena / s.n, 1), label: "recall" }] })} onBlur={clear}>
                    <span className="truncate text-[11px] text-[#d3d8de]" title={s.label || s.skema}>{s.label || s.skema}</span>
                    <Batang nilai={s.kena / s.n} warna={FRAUD} label={pct(s.kena / s.n, 0)} tinggi={7} />
                  </div>
                ))}
              </div>
            </div>
          )}
          <Tooltip tip={tip} />
        </div>
      </ChartCard>
      {!!uji.contoh_kode?.length && (
        <div className="flex flex-wrap items-center gap-1 text-[10.5px] text-[#8f99a8]">
          <span>Contoh klaim yang kena (id saja):</span>
          {uji.contoh_kode.slice(0, 12).map((k) => <Chip key={k} nada="redup" mono>{k}</Chip>)}
          {uji.contoh_kode.length > 12 && <span>+{uji.contoh_kode.length - 12}</span>}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ catalogue

const SUMBER: Record<string, string> = { klaim: "Field klaim", turunan: "Turunan", peserta: "Peserta (registri)", fitur: "Fitur engine" };

/** the fields and functions a condition may use (GET /aturan/katalog); onPick inserts one into the condition being edited */
export function KatalogPanel({ katalog, onPick, ringkas }: { katalog: Katalog; onPick?: (s: string) => void; ringkas?: boolean }) {
  const [cari, setCari] = useState("");
  const q = cari.trim().toLowerCase();
  const cocok = (s: string, d?: string) => !q || s.toLowerCase().includes(q) || (d ?? "").toLowerCase().includes(q);
  const grup = Object.entries((katalog.fields ?? []).reduce<Record<string, Katalog["fields"]>>((g, f) => ((g[f.sumber] ??= []).push(f), g), {}));
  const fungsi = (katalog.fungsi ?? []).filter((f) => cocok(f.nama, f.deskripsi));
  return (
    <div className="space-y-2 text-[11px]">
      <input value={cari} onChange={(e) => setCari(e.target.value)} placeholder="Cari field atau fungsi" className={`${masukan} w-full`} />
      {grup.map(([s, fs]) => {
        const ada = fs.filter((f) => cocok(f.nama, f.deskripsi));
        if (!ada.length) return null;
        return (
          <div key={s}>
            <p className="mb-1 text-[10.5px] uppercase tracking-wide text-[#8f99a8]">{SUMBER[s] ?? s}</p>
            <div className="flex flex-wrap gap-1">
              {ada.map((f) => (
                <button key={f.nama} type="button" onClick={onPick ? () => onPick(f.nama) : undefined} title={`${f.deskripsi} (${f.jenis})`}
                  className={`rounded border border-white/10 px-1.5 py-[1px] font-mono text-[10.5px] text-[#d3d8de] ${onPick ? "hover:border-[#3987e5]/60 hover:bg-[#3987e5]/10" : "cursor-default"}`}>{f.nama}</button>
              ))}
            </div>
          </div>
        );
      })}
      {!!fungsi.length && (
        <div>
          <p className="mb-1 text-[10.5px] uppercase tracking-wide text-[#8f99a8]">Fungsi</p>
          <ul className="space-y-0.5">
            {fungsi.map((f) => (
              <li key={f.nama} className="flex items-start gap-1.5">
                <button type="button" onClick={onPick ? () => onPick(`${f.nama}()`) : undefined}
                  className={`shrink-0 rounded border border-white/10 px-1.5 py-[1px] font-mono text-[10.5px] text-[#d3d8de] ${onPick ? "hover:border-[#3987e5]/60 hover:bg-[#3987e5]/10" : "cursor-default"}`}>
                  {f.nama}({Array.isArray(f.argumen) ? f.argumen.join(", ") : f.argumen ?? ""})</button>
                {!ringkas && <span className="leading-snug text-[#abb3bf]">{f.deskripsi}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!ringkas && !q && !!katalog.contoh?.length && (
        <div>
          <p className="mb-1 text-[10.5px] uppercase tracking-wide text-[#8f99a8]">Contoh</p>
          <ul className="space-y-1">{(katalog.contoh ?? []).map((c) => <li key={c} className="break-words rounded bg-[#111418] px-1.5 py-1 font-mono text-[10.5px] text-[#c5cbd3]">{c}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ draft editor

export type ModeEditor = { jenis: "baru" } | { jenis: "versi"; aturan: Aturan } | { jenis: "bawaan"; bawaan: Bawaan };
export type Tersimpan = { aturan?: Aturan; perubahan?: Perubahan };

const keIn = (d: Draf | Aturan, menggantikan?: string | null): AturanIn => ({
  kode: d.kode ?? "", label: d.label ?? "", deskripsi: d.deskripsi ?? "", kondisi: d.kondisi ?? "", modus: d.modus ?? [],
  bobot: typeof d.bobot === "number" ? d.bobot : 1, menggantikan: menggantikan ?? d.menggantikan ?? null,
});

/** an AI draft (or a rule as it is) to read, edit and save as a draft; a parameter change of a built-in rule saves as its pending change */
export function DrafEditor({ draf, mode, katalog, onTersimpan, onBatal, judul }: {
  draf: Draf | Aturan; mode: ModeEditor; katalog: Katalog | null; onTersimpan: (x: Tersimpan) => void; onBatal: () => void; judul?: string;
}) {
  const d = draf as Draf;
  const param = mode.jenis === "bawaan" && d.aksi === "ubah_parameter";
  const [f, setF] = useState<AturanIn>(() => keIn(draf, mode.jenis === "bawaan" && !param ? d.menggantikan ?? mode.bawaan.kode : undefined));
  const [p, setP] = useState(() => ({
    aktif: d.parameter?.aktif ?? (mode.jenis === "bawaan" ? mode.bawaan.aktif : true),
    bobot: d.parameter?.bobot ?? (mode.jenis === "bawaan" ? mode.bawaan.bobot : 1),
  }));
  const [catatan, setCatatan] = useState(d.perubahan ?? "");
  const [val, setVal] = useState<Validasi | null>(typeof d.valid === "boolean" ? { ok: d.valid, error: d.error ?? null, field: d.field_dipakai } : null);
  const [cek, setCek] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [bantu, setBantu] = useState(false);
  const seq = useRef(0);
  const ref = useRef<HTMLTextAreaElement>(null);

  // the condition is checked by the backend's parser as it is typed (the AI's output too: the parser decides, not the AI)
  useEffect(() => {
    if (param || !f.kondisi.trim()) return;
    const n = ++seq.current;
    const t = setTimeout(() => {
      setCek(true);
      aturanApi.validasi(f.kondisi)
        .then((v) => { if (n === seq.current) setVal(v); })
        .catch((x) => { if (n === seq.current) setVal({ ok: false, error: pesan(x) }); })
        .finally(() => { if (n === seq.current) setCek(false); });
    }, 450);
    return () => clearTimeout(t);
  }, [f.kondisi, param]);

  const sisip = (s: string) => {
    const el = ref.current;
    const a = el?.selectionStart ?? f.kondisi.length, b = el?.selectionEnd ?? a;
    const sep = a > 0 && !/\s$/.test(f.kondisi.slice(0, a)) ? " " : "";
    const k = f.kondisi.slice(0, a) + sep + s + f.kondisi.slice(b);
    setF({ ...f, kondisi: k });
    requestAnimationFrame(() => { el?.focus(); const c = a + sep.length + s.length; el?.setSelectionRange(c, c); });
  };
  const kosong = !f.kondisi.trim() || !f.kode.trim() || !f.label.trim();
  const simpan = async () => {
    setBusy(true); setErr("");
    try {
      if (param && mode.jenis === "bawaan") {
        const perubahan = await aturanApi.bawaanUbah(mode.bawaan.kode, { aktif: p.aktif, bobot: p.bobot, ...(catatan.trim() ? { catatan: catatan.trim() } : {}) });
        onTersimpan({ perubahan });
      } else if (mode.jenis === "versi") {
        onTersimpan({ aturan: await aturanApi.ubah(mode.aturan.id, f) });
      } else {
        onTersimpan({ aturan: await aturanApi.buat(f) });
      }
    } catch (x) { setErr(pesan(x)); } finally { setBusy(false); }
  };

  const modus = katalog?.modus ?? [];
  const aktifModus = new Set(f.modus);
  return (
    <div className="space-y-2.5 rounded-md border border-[#9d8cff]/30 bg-[#5b5fd6]/[.06] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="edit" className="h-4 w-4 text-[#c7c9ff]" />
        <p className="text-[12.5px] font-semibold text-white">{judul ?? (param ? "Usulan perubahan parameter" : "Draf rule")}</p>
        {mode.jenis === "versi" && <Chip nada="redup">versi baru dari {mode.aturan.kode} v{mode.aturan.versi}</Chip>}
        {mode.jenis === "bawaan" && !param && <Chip nada="ungu" ikon="restore">menggantikan {f.menggantikan ?? mode.bawaan.kode}</Chip>}
        {d.biaya_usd != null && <span className="text-[10.5px] text-[#8f99a8]">biaya AI {usd(d.biaya_usd)}</span>}
        <button onClick={onBatal} className="ml-auto rounded p-1 text-[#8f99a8] hover:bg-white/10 hover:text-white" title="Tutup draf"><Icon name="x" className="h-3.5 w-3.5" /></button>
      </div>

      {d.penjelasan && <p className="text-[11.5px] leading-snug text-[#d3d8de]"><span className="text-[#8f99a8]">Penjelasan AI: </span>{d.penjelasan}</p>}
      {d.perubahan && <p className="text-[11.5px] leading-snug text-[#d3d8de]"><span className="text-[#8f99a8]">Yang diubah: </span>{d.perubahan}</p>}
      {!!d.peringatan?.length && (
        <ul className="space-y-0.5">{d.peringatan.map((w) => <li key={w} className="flex items-start gap-1.5 text-[11px] text-[#fbd38d]"><Icon name="alert" className="mt-px h-3 w-3 shrink-0" />{w}</li>)}</ul>
      )}

      {param && mode.jenis === "bawaan" ? (
        <div className="space-y-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded border border-white/[.08] p-2">
              <p className="text-[10.5px] text-[#8f99a8]">Aktif</p>
              <p className="mt-0.5 flex items-center gap-2 text-[12px] text-white">
                <span className="text-[#8f99a8]">{mode.bawaan.aktif ? "ya" : "tidak"}</span><Icon name="right" className="h-3 w-3 text-[#8f99a8]" />
                <label className="flex items-center gap-1.5"><input type="checkbox" checked={p.aktif} onChange={(e) => setP({ ...p, aktif: e.target.checked })} />{p.aktif ? "ya" : "tidak"}</label>
              </p>
            </div>
            <div className="rounded border border-white/[.08] p-2">
              <p className="text-[10.5px] text-[#8f99a8]">Bobot (default {idn(mode.bawaan.bobot_default, 2)})</p>
              <p className="mt-0.5 flex items-center gap-2 text-[12px] text-white">
                <span className="tabular-nums text-[#8f99a8]">{idn(mode.bawaan.bobot, 2)}</span><Icon name="right" className="h-3 w-3 text-[#8f99a8]" />
                <input type="number" step={0.05} min={0} max={5} value={p.bobot} onChange={(e) => setP({ ...p, bobot: Number(e.target.value) })} className={`${masukan} w-24 tabular-nums`} />
              </p>
            </div>
          </div>
          <input value={catatan} onChange={(e) => setCatatan(e.target.value)} placeholder="Catatan (opsional)" className={`${masukan} w-full`} />
        </div>
      ) : (
        <div className="space-y-2">
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_110px]">
            <label className="min-w-0"><span className="text-[10.5px] text-[#8f99a8]">Kode</span>
              <input value={f.kode} onChange={(e) => setF({ ...f, kode: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_") })} className={`${masukan} w-full font-mono`} /></label>
            <label className="min-w-0"><span className="text-[10.5px] text-[#8f99a8]">Label</span>
              <input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} className={`${masukan} w-full`} /></label>
            <label className="min-w-0"><span className="text-[10.5px] text-[#8f99a8]">Bobot</span>
              <input type="number" step={0.05} min={0} max={5} value={f.bobot} onChange={(e) => setF({ ...f, bobot: Number(e.target.value) })} className={`${masukan} w-full tabular-nums`} /></label>
          </div>
          <label className="block"><span className="text-[10.5px] text-[#8f99a8]">Deskripsi</span>
            <textarea value={f.deskripsi} onChange={(e) => setF({ ...f, deskripsi: e.target.value })} rows={2} className={`${masukan} w-full resize-y`} /></label>
          {d.sebelum?.kondisi && (
            <div>
              <span className="text-[10.5px] text-[#8f99a8]">Kondisi sebelumnya</span>
              <pre className="whitespace-pre-wrap break-words rounded border border-white/[.06] bg-[#111418]/60 px-2 py-1.5 font-mono text-[11px] text-[#8f99a8]">{d.sebelum.kondisi}</pre>
            </div>
          )}
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[10.5px] text-[#8f99a8]">Kondisi (rule engine)</span>
              <span className="ml-auto flex items-center gap-1 text-[10.5px]">
                {cek ? <span className="text-[#8f99a8]">memeriksa…</span>
                  : val ? (val.ok ? <span className="flex items-center gap-1 text-[#7ee2c0]"><Icon name="check" className="h-3 w-3" />valid</span>
                    : <span className="flex items-center gap-1 text-[#ffb4b4]"><Icon name="alert" className="h-3 w-3" />tidak valid</span>) : null}
              </span>
              {katalog && <button type="button" onClick={() => setBantu(!bantu)} className="rounded px-1.5 py-0.5 text-[10.5px] text-[#8abbff] hover:bg-white/5">{bantu ? "Tutup field" : "Field & fungsi"}</button>}
            </div>
            <textarea ref={ref} value={f.kondisi} onChange={(e) => setF({ ...f, kondisi: e.target.value })} rows={3} spellCheck={false}
              className={`${masukan} w-full resize-y font-mono text-[11.5px] leading-relaxed ${val && !val.ok && !cek ? "border-[#d03b3b]/50" : ""}`} />
            {val && !val.ok && val.error && <p className="mt-0.5 font-mono text-[10.5px] text-[#ffb4b4]">{val.error}</p>}
            {val?.ok && (!!val.field?.length || !!val.fungsi?.length) && (
              <div className="mt-1 flex flex-wrap items-center gap-1">
                <span className="text-[10.5px] text-[#8f99a8]">Dipakai:</span>
                {(val.field ?? []).map((x) => <Chip key={`f-${x}`} nada="biru" mono>{x}</Chip>)}
                {(val.fungsi ?? []).map((x) => <Chip key={`g-${x}`} nada="ungu" mono>{x}()</Chip>)}
              </div>
            )}
            {!val?.field?.length && !!d.field_dipakai?.length && (
              <div className="mt-1 flex flex-wrap items-center gap-1"><span className="text-[10.5px] text-[#8f99a8]">Field dipakai:</span>
                {d.field_dipakai.map((x) => <Chip key={x} nada="biru" mono>{x}</Chip>)}</div>
            )}
            {bantu && katalog && <div className="mt-2 rounded border border-white/[.08] bg-[#151a1f] p-2"><KatalogPanel katalog={katalog} onPick={sisip} ringkas /></div>}
          </div>
          {!!modus.length && (
            <div>
              <span className="text-[10.5px] text-[#8f99a8]">Modus Permenkes 16/2019</span>
              <div className="mt-0.5 flex flex-wrap gap-1">
                {modus.map((m) => (
                  <button key={m.kode} type="button" title={m.nama} onClick={() => setF({ ...f, modus: aktifModus.has(m.kode) ? f.modus.filter((x) => x !== m.kode) : [...f.modus, m.kode] })}
                    className={`rounded border px-1.5 py-[1px] font-mono text-[10.5px] ${aktifModus.has(m.kode) ? "border-[#d95926]/60 bg-[#d95926]/15 text-[#ffc9b3]" : "border-white/10 text-[#8f99a8] hover:text-white"}`}>{m.kode}</button>
                ))}
              </div>
            </div>
          )}
          {!modus.length && !!f.modus.length && <div className="flex flex-wrap gap-1">{f.modus.map((m) => <Chip key={m} mono>{m}</Chip>)}</div>}
        </div>
      )}

      {err && <p className="text-[11px] text-[#ffb4b4]">{err}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={simpan} disabled={busy || (!param && (kosong || cek || (val !== null && !val.ok)))} className={tombolUtama}>
          <Icon name="save" className="h-3.5 w-3.5" />{busy ? "Menyimpan…" : param ? "Simpan perubahan (draf)" : mode.jenis === "versi" ? "Simpan sebagai versi baru (draf)" : "Simpan draf"}
        </button>
        <button onClick={onBatal} className={tombolNetral}>Batal</button>
        <span className="text-[10.5px] text-[#8f99a8]">Belum aktif: setelah disimpan, uji dulu, ajukan, lalu admin menyetujui.</span>
      </div>
    </div>
  );
}
