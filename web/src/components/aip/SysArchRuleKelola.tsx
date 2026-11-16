"use client";

// System Architecture · rule manager (the user, 2026-11-15: "rule engine nya bisa dipencet, bisa diliat rule nya apa aja yg udah ada,
// rule nya bisa di edit, delete atau add new rule, nanti ada form nya buat create new rule"): a drawer opened from the rule engine
// node of the ML v7 flow (SysArchMl). It lists every rule (the custom ones and the built-in ones, 45 of which ML v7 reads as
// features), with edit and delete, and a form that creates or edits a custom rule. Saving goes through the same governed path as
// the full Rule engine page: save → backtest on synthetic data → submit → approve, each step written to the API's log; an admin
// does it in one click ("Simpan & aktifkan"). Built-in rules are code: they are switched off or re-weighted, never deleted (the 45
// model inputs stay frozen until the model is retrained). A deleted custom rule is archived by the API, not lost.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/Icon";
import { Chip, idn, masukan, pct, tombolAi, tombolBahaya, tombolNetral, tombolUtama } from "./SysArchShared";
import { aturanApi, pesan, type Aturan, type AturanIn, type Bawaan, type Daftar, type Katalog, type Validasi } from "./SysArchRuleApi";
import { KatalogPanel, StatusChip } from "./SysArchRuleParts";

type Saring = "semua" | "kustom" | "bawaan" | "model";
type Form = { jenis: "baru" } | { jenis: "ubah"; a: Aturan } | { jenis: "bawaan"; b: Bawaan; matikan?: boolean };
type Langkah = { label: string; st: "tunggu" | "jalan" | "ok" | "gagal"; ket?: string };
type Baris = { key: string; jenis: "kustom" | "bawaan"; kode: string; label: string; modus: string[]; bobot: number; a?: Aturan; b?: Bawaan; teks: string };

const PER_HALAMAN = 25;
const ikonTombol = "rounded p-1.5 text-[#abb3bf] transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-35";
const label = "text-[11px] font-medium text-[#c5cbd3]";
const bantuan = "text-[10.5px] leading-snug text-[#8f99a8]";

/** "Top-up obat > 3x p95" -> "TOP_UP_OBAT_3X_P95": the code suggested from the name until the code is typed by hand */
const kodeDari = (s: string) => {
  const k = s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return /^[0-9]/.test(k) ? `R_${k}`.slice(0, 40) : k;
};
const KOSONG: AturanIn = { kode: "", label: "", deskripsi: "", kondisi: "", modus: [], bobot: 1, menggantikan: null };
const dariAturan = (a: Aturan): AturanIn => ({ kode: a.kode, label: a.label, deskripsi: a.deskripsi ?? "", kondisi: a.kondisi, modus: a.modus ?? [], bobot: a.bobot,
  menggantikan: a.menggantikan ?? null });

// ------------------------------------------------------------------------------------------------ small pieces

function Seksi({ judul, sub, children }: { judul: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2 rounded-lg border border-white/[.07] bg-[#1c2127] p-3.5">
      <div>
        <h4 className="text-[12.5px] font-semibold text-white">{judul}</h4>
        {sub && <p className={bantuan}>{sub}</p>}
      </div>
      {children}
    </section>
  );
}

/** the steps of a save, ticked off as the API answers each one */
function Proses({ langkah }: { langkah: Langkah[] }) {
  return (
    <ol className="space-y-1 rounded-lg border border-white/[.07] bg-[#151a1f] p-3" aria-label="Proses penyimpanan rule">
      {langkah.map((l, i) => (
        <li key={l.label} className="flex items-start gap-2 text-[11.5px]">
          <span className={`mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] ${
            l.st === "ok" ? "bg-[#199e70]/25 text-[#7ee2c0]" : l.st === "gagal" ? "bg-[#d03b3b]/25 text-[#ffb4b4]" : l.st === "jalan" ? "bg-[#3987e5]/25 text-[#a9cdff]" : "bg-white/[.06] text-[#8f99a8]"}`}>
            {l.st === "ok" ? <Icon name="check" className="h-2.5 w-2.5" /> : l.st === "gagal" ? <Icon name="x" className="h-2.5 w-2.5" /> : i + 1}
          </span>
          <span className="min-w-0">
            <span className={l.st === "tunggu" ? "text-[#8f99a8]" : "text-white"}>{l.label}{l.st === "jalan" ? "…" : ""}</span>
            {l.ket && <span className={`block text-[10.5px] ${l.st === "gagal" ? "text-[#ffb4b4]" : "text-[#abb3bf]"}`}>{l.ket}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** a run of API calls, one step after another; stops at the first refusal and says why */
function usePelari() {
  const [langkah, setLangkah] = useState<Langkah[] | null>(null);
  const jalankan = useCallback(async (steps: { label: string; f: () => Promise<string | void> }[]) => {
    setLangkah(steps.map((s) => ({ label: s.label, st: "tunggu" })));
    const set = (i: number, x: Partial<Langkah>) => setLangkah((l) => (l ? l.map((y, j) => (j === i ? { ...y, ...x } : y)) : l));
    for (let i = 0; i < steps.length; i++) {
      set(i, { st: "jalan" });
      try {
        const ket = await steps[i].f();
        set(i, { st: "ok", ket: ket || undefined });
      } catch (x) {
        set(i, { st: "gagal", ket: pesan(x) });
        return false;
      }
    }
    return true;
  }, []);
  return { langkah, setLangkah, jalankan };
}

const ringkasUji = (u: { kena?: { normal: number; fraud: number }; recall?: number; precision?: number | null; laju_normal?: number } | null | undefined) =>
  u?.kena ? `menandai ${idn(u.kena.fraud)} klaim fraud dan ${idn(u.kena.normal)} klaim normal · fraud tertangkap ${pct(u.recall)} · presisi ${u.precision == null ? "—" : pct(u.precision)}` : "";

// ------------------------------------------------------------------------------------------------ form: a custom rule

function FormKustom({ form, katalog, admin, onSelesai, onBatal }: {
  form: { jenis: "baru" } | { jenis: "ubah"; a: Aturan }; katalog: Katalog | null; admin: boolean; onSelesai: (pesan: string) => void; onBatal: () => void;
}) {
  const ubah = form.jenis === "ubah" ? form.a : null;
  const [f, setF] = useState<AturanIn>(() => (ubah ? dariAturan(ubah) : KOSONG));
  const [kodeManual, setKodeManual] = useState(!!ubah);
  const [val, setVal] = useState<Validasi | null>(null);
  const [cek, setCek] = useState(false);
  const [katalogBuka, setKatalogBuka] = useState(false);
  const [aiTeks, setAiTeks] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiInfo, setAiInfo] = useState<{ penjelasan?: string; peringatan?: string[]; galat?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [tersimpan, setTersimpan] = useState<{ a: Aturan; isi: string } | null>(null);
  const { langkah, jalankan } = usePelari();
  const seq = useRef(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const bmin = katalog?.batas?.bobot_min ?? 0.05, bmaks = katalog?.batas?.bobot_maks ?? 3;

  // the condition is checked by the rule engine's own parser while it is typed (the AI's draft too: the parser decides)
  useEffect(() => {
    if (!f.kondisi.trim()) return;
    const n = ++seq.current;
    const t = setTimeout(() => {
      setCek(true);
      aturanApi.validasi(f.kondisi)
        .then((v) => { if (n === seq.current) setVal(v); })
        .catch((x) => { if (n === seq.current) setVal({ ok: false, error: pesan(x) }); })
        .finally(() => { if (n === seq.current) setCek(false); });
    }, 400);
    return () => clearTimeout(t);
  }, [f.kondisi]);

  const setLabel = (v: string) => setF((x) => ({ ...x, label: v, kode: kodeManual ? x.kode : kodeDari(v) }));
  const sisip = (s: string) => {
    const el = ref.current;
    const a = el?.selectionStart ?? f.kondisi.length, b = el?.selectionEnd ?? a;
    const sep = a > 0 && !/\s$/.test(f.kondisi.slice(0, a)) ? " " : "";
    setF({ ...f, kondisi: f.kondisi.slice(0, a) + sep + s + f.kondisi.slice(b) });
    requestAnimationFrame(() => { el?.focus(); const c = a + sep.length + s.length; el?.setSelectionRange(c, c); });
  };
  const bantuAi = async () => {
    setAiBusy(true); setAiInfo(null);
    try {
      const d = await aturanApi.aiDraf(aiTeks.trim());
      setF((x) => ({ ...x, kode: d.kode || x.kode, label: d.label || x.label, deskripsi: d.deskripsi ?? x.deskripsi, kondisi: d.kondisi || x.kondisi,
        modus: d.modus?.length ? d.modus : x.modus, bobot: typeof d.bobot === "number" ? d.bobot : x.bobot }));
      if (d.kode) setKodeManual(true);
      setAiInfo({ penjelasan: d.penjelasan, peringatan: d.peringatan });
    } catch (x) { setAiInfo({ galat: pesan(x) }); } finally { setAiBusy(false); }
  };

  const kurang = [!f.label.trim() && "nama rule", !/^[A-Z][A-Z0-9_]{2,39}$/.test(f.kode) && "kode (huruf besar, 3–40 karakter)", !f.kondisi.trim() && "kondisi"].filter(Boolean) as string[];
  const tidakValid = !!val && !val.ok && !cek;
  const bisa = !busy && !kurang.length && !cek && !tidakValid && !(bmin > f.bobot || f.bobot > bmaks);

  const simpan = async (aktifkan: boolean) => {
    setBusy(true);
    const isi = JSON.stringify(f);
    let a: Aturan | null = tersimpan?.a ?? ubah;
    const steps: { label: string; f: () => Promise<string | void> }[] = [];
    // a failed run saved the rule already: the same content is not saved twice (a new version only when something changed)
    if (!(tersimpan && tersimpan.isi === isi)) {
      steps.push({ label: a ? `Simpan versi baru ${f.kode}` : `Simpan rule ${f.kode}`, f: async () => {
        a = a ? await aturanApi.ubah(a.id, f) : await aturanApi.buat(f);
        setTersimpan({ a, isi });
        return `versi ${a.versi} tersimpan sebagai draf`;
      } });
    }
    if (aktifkan) {
      steps.push({ label: "Uji pada data sintetis (sekitar 20 detik)", f: async () => ringkasUji(await aturanApi.uji(a!.id)) });
      steps.push({ label: "Ajukan untuk persetujuan", f: async () => { await aturanApi.ajukan(a!.id, "dari form kelola rule"); } });
      if (admin) steps.push({ label: "Setujui dan aktifkan", f: async () => { await aturanApi.setujui(a!.id, "disetujui dari form kelola rule"); return "rule berjalan di rule engine"; } });
    }
    const ok = await jalankan(steps);
    setBusy(false);
    if (ok) onSelesai(aktifkan ? (admin ? `Rule ${f.kode} aktif: rule engine langsung memakainya.` : `Rule ${f.kode} diuji dan diajukan: menunggu persetujuan admin.`)
      : `Rule ${f.kode} tersimpan sebagai draf (belum dipakai rule engine).`);
  };

  const modus = katalog?.modus ?? [];
  const dipilih = new Set(f.modus);
  const sinyal = (katalog as (Katalog & { sinyal?: { kode: string; label: string }[] }) | null)?.sinyal ?? [];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={onBatal} className={tombolNetral}><Icon name="left" className="h-3.5 w-3.5" />Kembali ke daftar</button>
        <h3 className="text-[14px] font-semibold text-white">{ubah ? `Edit rule ${ubah.kode}` : "Buat rule baru"}</h3>
        {ubah && <StatusChip s={ubah.status} />}
        {ubah && <span className="text-[10.5px] text-[#8f99a8]">versi {ubah.versi}</span>}
      </div>
      {ubah?.versi_aktif != null && (
        <p className="rounded border border-[#3987e5]/30 bg-[#3987e5]/10 px-2.5 py-1.5 text-[11px] text-[#cfe2ff]">
          Versi {ubah.versi_aktif} tetap berjalan sampai versi baru ini disetujui; kalau ditolak, versi {ubah.versi_aktif} yang tetap dipakai.
        </p>
      )}

      <Seksi judul="Bantu isi dengan AI (opsional)" sub="Tulis aturannya dengan kalimat biasa; AI mengisi form di bawah. Hasilnya tetap diperiksa parser rule engine dan bisa Anda ubah.">
        <textarea value={aiTeks} onChange={(e) => setAiTeks(e.target.value)} rows={2} placeholder="Contoh: tandai rawat inap yang top-up obatnya lebih dari 3 kali kelaziman untuk kode INA-CBG yang sama"
          className={`${masukan} w-full resize-y`} />
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={bantuAi} disabled={aiBusy || aiTeks.trim().length < 8} className={tombolAi}><Icon name="sparkle" className="h-3.5 w-3.5" />{aiBusy ? "AI menyusun…" : "Isi form dengan AI"}</button>
          {aiInfo?.galat && <span className="text-[11px] text-[#ffb4b4]">{aiInfo.galat}</span>}
        </div>
        {aiInfo?.penjelasan && <p className="text-[11px] leading-snug text-[#d3d8de]"><span className="text-[#8f99a8]">Penjelasan AI: </span>{aiInfo.penjelasan}</p>}
        {!!aiInfo?.peringatan?.length && <ul className="space-y-0.5">{aiInfo.peringatan.map((w) => <li key={w} className="flex items-start gap-1.5 text-[11px] text-[#fbd38d]"><Icon name="alert" className="mt-px h-3 w-3 shrink-0" />{w}</li>)}</ul>}
      </Seksi>

      <Seksi judul="Identitas rule">
        <div className="grid gap-2.5 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <label className="block min-w-0"><span className={label}>Nama rule *</span>
            <input value={f.label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder="Top-up obat jauh di atas kelaziman" className={`${masukan} mt-0.5 w-full`} /></label>
          <label className="block min-w-0"><span className={label}>Kode *</span>
            <input value={f.kode} disabled={!!ubah} onChange={(e) => { setKodeManual(true); setF({ ...f, kode: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 40) }); }}
              className={`${masukan} mt-0.5 w-full font-mono disabled:opacity-60`} />
            <span className={bantuan}>{ubah ? "Kode tidak bisa diubah; buat rule baru untuk kode lain." : "Terisi otomatis dari nama; huruf besar, angka, garis bawah."}</span></label>
        </div>
        <label className="block"><span className={label}>Deskripsi</span>
          <textarea value={f.deskripsi} onChange={(e) => setF({ ...f, deskripsi: e.target.value })} rows={2} maxLength={1000} placeholder="Apa yang dicari rule ini dan kenapa itu indikasi fraud"
            className={`${masukan} mt-0.5 w-full resize-y`} /></label>
      </Seksi>

      <Seksi judul="Kondisi *" sub="Klaim ditandai bila kondisi ini benar. Dinilai pada setiap klaim FKRTL; nilai yang tidak tercatat dianggap kosong (perbandingan dengan nilai kosong selalu salah).">
        <div className="flex items-center gap-2">
          <span className="ml-auto flex items-center gap-1 text-[10.5px]">
            {cek ? <span className="text-[#8f99a8]">memeriksa…</span>
              : val ? (val.ok ? <span className="flex items-center gap-1 text-[#7ee2c0]"><Icon name="check" className="h-3 w-3" />kondisi valid</span>
                : <span className="flex items-center gap-1 text-[#ffb4b4]"><Icon name="alert" className="h-3 w-3" />belum valid</span>) : null}
          </span>
          {katalog && <button type="button" onClick={() => setKatalogBuka(!katalogBuka)} className="rounded px-1.5 py-0.5 text-[10.5px] text-[#8abbff] hover:bg-white/5">{katalogBuka ? "Tutup daftar field" : "Daftar field & fungsi"}</button>}
        </div>
        <textarea ref={ref} value={f.kondisi} onChange={(e) => setF({ ...f, kondisi: e.target.value })} rows={3} spellCheck={false} aria-label="Kondisi rule"
          placeholder={katalog?.contoh?.[0] ?? 'tingkat_pelayanan == "RITL" and sd_tarif_rp > 3 * p95_topup("sd_tarif_rp")'}
          className={`${masukan} w-full resize-y font-mono text-[11.5px] leading-relaxed ${tidakValid ? "border-[#d03b3b]/50" : ""}`} />
        {tidakValid && val?.error && <p className="font-mono text-[10.5px] text-[#ffb4b4]">{val.error}</p>}
        {val?.ok && !!val.field?.length && (
          <div className="flex flex-wrap items-center gap-1"><span className={bantuan}>Membaca:</span>{val.field.map((x) => <Chip key={x} nada="biru" mono>{x}</Chip>)}
            {(val.fungsi ?? []).map((x) => <Chip key={`g-${x}`} nada="ungu" mono>{x}()</Chip>)}</div>
        )}
        {katalogBuka && katalog && <div className="rounded border border-white/[.08] bg-[#151a1f] p-2"><KatalogPanel katalog={katalog} onPick={sisip} /></div>}
      </Seksi>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Seksi judul="Jenis fraud" sub="Modus Permenkes 16/2019 yang ditunjuk rule ini (maksimal 5). Dipakai laporan audit untuk mengelompokkan temuan.">
          {modus.length ? (
            <div className="flex flex-wrap gap-1">
              {modus.map((m) => {
                const on = dipilih.has(m.kode);
                return (
                  <button key={m.kode} type="button" aria-pressed={on} disabled={!on && f.modus.length >= 5}
                    onClick={() => setF({ ...f, modus: on ? f.modus.filter((x) => x !== m.kode) : [...f.modus, m.kode] })}
                    className={`rounded border px-1.5 py-[2px] text-left text-[10.5px] disabled:opacity-35 ${on ? "border-[#d95926]/60 bg-[#d95926]/15 text-[#ffc9b3]" : "border-white/10 text-[#abb3bf] hover:text-white"}`}>
                    <span className="font-mono">{m.kode}</span> · {m.nama}
                  </button>
                );
              })}
            </div>
          ) : <p className={bantuan}>Daftar modus belum terbaca.</p>}
        </Seksi>
        <Seksi judul="Bobot" sub={`Seberapa besar rule ini menaikkan skor rule engine (${idn(bmin, 2)}–${idn(bmaks, 1)}). 1 = setara rule bawaan biasa.`}>
          <div className="flex items-center gap-2.5">
            <input type="range" min={bmin} max={bmaks} step={0.05} value={f.bobot} onChange={(e) => setF({ ...f, bobot: Number(e.target.value) })} aria-label="Bobot (geser)" className="flex-1 accent-[#3987e5]" />
            <input type="number" min={bmin} max={bmaks} step={0.05} value={f.bobot} onChange={(e) => setF({ ...f, bobot: Number(e.target.value) })} aria-label="Bobot" className={`${masukan} w-20 tabular-nums`} />
          </div>
          {!!sinyal.length && (
            <label className="block pt-1"><span className={label}>Menggantikan rule bawaan (opsional)</span>
              <select value={f.menggantikan ?? ""} onChange={(e) => setF({ ...f, menggantikan: e.target.value || null })} className={`${masukan} mt-0.5 w-full`}>
                <option value="">Tidak: rule tambahan</option>
                {sinyal.map((s) => <option key={s.kode} value={s.kode}>{s.label} ({s.kode})</option>)}
              </select>
              <span className={bantuan}>Saat rule ini aktif, rule bawaan yang dipilih berhenti dinilai.</span></label>
          )}
        </Seksi>
      </div>

      <div className="sticky bottom-0 -mx-5 flex flex-wrap items-center gap-2 border-t border-white/[.07] bg-[#171b20] px-5 py-3">
        {langkah && <div className="w-full"><Proses langkah={langkah} /></div>}
        <button onClick={() => simpan(true)} disabled={!bisa} className={tombolUtama}>
          <Icon name={admin ? "check" : "right"} className="h-3.5 w-3.5" />{busy ? "Memproses…" : admin ? "Simpan & aktifkan" : "Simpan, uji & ajukan ke admin"}
        </button>
        <button onClick={() => simpan(false)} disabled={!bisa} className={tombolNetral}><Icon name="save" className="h-3.5 w-3.5" />Simpan sebagai draf</button>
        <button onClick={onBatal} disabled={busy} className={tombolNetral}>Batal</button>
        <span className={`${bantuan} ml-auto max-w-[420px] text-right`}>
          {kurang.length ? `Lengkapi: ${kurang.join(", ")}.` : admin ? "Disimpan, diuji pada data sintetis, lalu langsung disetujui (Anda admin). Semua langkah tercatat di log." : "Disimpan, diuji pada data sintetis, lalu menunggu persetujuan admin."}
        </span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ form: a built-in rule

function FormBawaan({ b, matikan, admin, onSelesai, onBatal }: { b: Bawaan; matikan?: boolean; admin: boolean; onSelesai: (pesan: string) => void; onBatal: () => void }) {
  const [aktif, setAktif] = useState(matikan ? false : b.aktif);
  const [bobot, setBobot] = useState(b.bobot);
  const [catatan, setCatatan] = useState("");
  const [busy, setBusy] = useState(false);
  const { langkah, jalankan } = usePelari();
  const berubah = aktif !== b.aktif || Math.abs(bobot - b.bobot) > 1e-9;
  const bisa = !busy && berubah && bobot >= 0.05 && bobot <= 3;

  const simpan = async (terapkan: boolean) => {
    setBusy(true);
    const steps: { label: string; f: () => Promise<string | void> }[] = [
      { label: `Simpan perubahan ${b.kode}`, f: async () => { await aturanApi.bawaanUbah(b.kode, { aktif, bobot, ...(catatan.trim() ? { catatan: catatan.trim() } : {}) }); return "tersimpan sebagai draf"; } },
    ];
    if (terapkan) {
      steps.push({ label: "Uji pada data sintetis (sekitar 20 detik)", f: async () => ringkasUji(await aturanApi.bawaanUji(b.kode)) });
      steps.push({ label: "Ajukan untuk persetujuan", f: async () => { await aturanApi.bawaanAjukan(b.kode, catatan.trim() || undefined); } });
      if (admin) steps.push({ label: "Setujui dan terapkan", f: async () => { await aturanApi.bawaanSetujui(b.kode, catatan.trim() || "disetujui dari form kelola rule"); } });
    }
    const ok = await jalankan(steps);
    setBusy(false);
    const apa = aktif !== b.aktif ? (aktif ? "dinyalakan" : "dimatikan") : `bobotnya jadi ${idn(bobot, 2)}`;
    if (ok) onSelesai(terapkan ? (admin ? `Rule bawaan ${b.kode} ${apa}.` : `Perubahan ${b.kode} diajukan: menunggu persetujuan admin.`) : `Perubahan ${b.kode} tersimpan sebagai draf.`);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={onBatal} className={tombolNetral}><Icon name="left" className="h-3.5 w-3.5" />Kembali ke daftar</button>
        <h3 className="text-[14px] font-semibold text-white">Ubah rule bawaan {b.kode}</h3>
        <Chip nada="redup">bawaan</Chip>
        {b.masuk_model && <Chip nada="biru" ikon="cpu">masukan ML v7</Chip>}
      </div>
      <Seksi judul={b.label} sub={b.deskripsi && b.deskripsi !== b.label ? b.deskripsi : undefined}>
        <p className={bantuan}>Logika rule bawaan ada di kode program rule engine, jadi yang bisa diubah di sini: rule menyala atau mati, dan bobotnya.
          Rule bawaan tidak bisa dihapus{b.masuk_model ? "; rule ini juga salah satu dari 45 rule yang dibaca model ML v7 sebagai fitur" : ""}.</p>
      </Seksi>
      <div className="grid gap-3 md:grid-cols-2">
        <Seksi judul="Status">
          <div className="flex items-center gap-3">
            <button type="button" role="switch" aria-checked={aktif} aria-label="Rule menyala" onClick={() => setAktif(!aktif)}
              className={`relative h-5 w-9 shrink-0 rounded-full transition ${aktif ? "bg-[#199e70]" : "bg-white/15"}`}>
              <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${aktif ? "left-[18px]" : "left-0.5"}`} />
            </button>
            <span className="text-[12px] text-white">{aktif ? "Menyala: rule menilai setiap klaim" : "Mati: rule berhenti menilai klaim"}</span>
          </div>
          {!aktif && b.masuk_model && (
            <p className="flex items-start gap-1.5 text-[11px] text-[#fbd38d]"><Icon name="alert" className="mt-px h-3 w-3 shrink-0" />
              Rule ini masukan model ML v7: selama mati, model tidak menerima sinyal ini sampai dilatih ulang tanpa rule ini.</p>
          )}
        </Seksi>
        <Seksi judul="Bobot" sub={`Default ${idn(b.bobot_default, 2)}; sekarang ${idn(b.bobot, 2)}. Rentang 0,05–3.`}>
          <div className="flex items-center gap-2.5">
            <input type="range" min={0.05} max={3} step={0.05} value={bobot} onChange={(e) => setBobot(Number(e.target.value))} aria-label="Bobot (geser)" className="flex-1 accent-[#3987e5]" />
            <input type="number" min={0.05} max={3} step={0.05} value={bobot} onChange={(e) => setBobot(Number(e.target.value))} aria-label="Bobot" className={`${masukan} w-20 tabular-nums`} />
          </div>
        </Seksi>
      </div>
      <Seksi judul="Alasan perubahan">
        <textarea value={catatan} onChange={(e) => setCatatan(e.target.value)} rows={2} maxLength={1000} placeholder="Contoh: terlalu banyak menandai klaim normal di poli jantung" className={`${masukan} w-full resize-y`} />
      </Seksi>
      <div className="sticky bottom-0 -mx-5 flex flex-wrap items-center gap-2 border-t border-white/[.07] bg-[#171b20] px-5 py-3">
        {langkah && <div className="w-full"><Proses langkah={langkah} /></div>}
        <button onClick={() => simpan(true)} disabled={!bisa} className={tombolUtama}><Icon name="check" className="h-3.5 w-3.5" />{busy ? "Memproses…" : admin ? "Simpan & terapkan" : "Simpan, uji & ajukan ke admin"}</button>
        <button onClick={() => simpan(false)} disabled={!bisa} className={tombolNetral}><Icon name="save" className="h-3.5 w-3.5" />Simpan sebagai draf</button>
        <button onClick={onBatal} disabled={busy} className={tombolNetral}>Batal</button>
        {!berubah && <span className={`${bantuan} ml-auto`}>Belum ada yang diubah.</span>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ the list

function ModusSingkat({ kode, nama }: { kode: string[]; nama: Map<string, string> }) {
  if (!kode.length) return <span className="text-[11px] text-[#5f6b7a]">—</span>;
  const n0 = nama.get(kode[0]);
  return (
    <span className="flex min-w-0 items-center gap-1" title={kode.map((k) => `${k} · ${nama.get(k) ?? k}`).join("\n")}>
      <span className="min-w-0 truncate text-[11px] text-[#d3d8de]"><span className="font-mono text-[#ffc9b3]">{kode[0]}</span>{n0 ? ` · ${n0}` : ""}</span>
      {kode.length > 1 && <span className="shrink-0 text-[10.5px] text-[#8f99a8]">+{kode.length - 1}</span>}
    </span>
  );
}

function Detail({ r, nama }: { r: Baris; nama: Map<string, string> }) {
  const a = r.a, b = r.b;
  return (
    <div className="space-y-2 border-t border-white/[.04] bg-[#151a1f] px-3 py-2.5 pl-8 text-[11.5px]">
      {(a?.deskripsi || (b?.deskripsi && b.deskripsi !== b.label)) && <p className="text-justify leading-relaxed text-[#d3d8de]">{a?.deskripsi || b?.deskripsi}</p>}
      {a && (
        <div>
          <p className={bantuan}>Kondisi</p>
          <pre className="mt-0.5 whitespace-pre-wrap break-words rounded border border-white/[.06] bg-[#111418] px-2 py-1.5 font-mono text-[11px] text-[#c5cbd3]">{a.kondisi}</pre>
        </div>
      )}
      {b && <p className="text-[#abb3bf]">Logika di kode program rule engine{b.masuk_model ? " · salah satu dari 45 masukan model ML v7" : ""} · bobot default {idn(b.bobot_default, 2)}
        {b.digantikan_oleh?.length ? ` · sedang digantikan rule kustom ${b.digantikan_oleh.join(", ")}` : ""}.</p>}
      {r.modus.length > 0 && <div className="flex flex-wrap gap-1">{r.modus.map((m) => <Chip key={m} mono title={nama.get(m)}>{m} · {nama.get(m) ?? m}</Chip>)}</div>}
      {a?.uji && <p className="text-[#abb3bf]">Uji terakhir (versi {a.uji.versi ?? a.versi}): {ringkasUji(a.uji)}.</p>}
      {a && <p className={bantuan}>Versi {a.versi}{a.versi_aktif != null ? ` · versi ${a.versi_aktif} berjalan` : " · belum berjalan"} · dibuat {a.dibuat_oleh ?? "—"} · diubah {a.diubah_oleh ?? "—"}</p>}
      {b?.perubahan_menunggu && <p className="text-[#fbd38d]">Ada perubahan {b.perubahan_menunggu.status === "menunggu" ? "menunggu persetujuan admin" : "berstatus " + (b.perubahan_menunggu.status ?? "draf")}.</p>}
    </div>
  );
}

const SARING: [Saring, string][] = [["semua", "Semua"], ["kustom", "Kustom"], ["bawaan", "Bawaan"], ["model", "Masukan ML v7"]];
const KOLOM = "md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,230px)_52px_150px_96px]";

/** onBerubah: every fresh list (the node's counts); onDiubah: only after a rule was actually saved, switched or deleted */
export function KelolaRule({ buka, onTutup, admin, onBerubah, onDiubah, onHalamanLengkap }: {
  buka: boolean; onTutup: () => void; admin: boolean; onBerubah?: (d: Daftar) => void; onDiubah?: () => void; onHalamanLengkap?: () => void;
}) {
  const [daftar, setDaftar] = useState<Daftar | null>(null);
  const [katalog, setKatalog] = useState<Katalog | null>(null);
  const [keadaan, setKeadaan] = useState<"memuat" | "ok" | "mati" | "galat">("memuat");
  const [galat, setGalat] = useState("");
  const [saring, setSaring] = useState<Saring>("semua");
  const [cari, setCari] = useState("");
  const [form, setForm] = useState<Form | null>(null);
  const [hapus, setHapus] = useState<Aturan | null>(null);
  const [hapusBusy, setHapusBusy] = useState(false);
  const [hapusGalat, setHapusGalat] = useState("");
  const [bukaBaris, setBukaBaris] = useState<string | null>(null);
  const [info, setInfo] = useState("");
  const [n, setN] = useState(PER_HALAMAN);
  const badan = useRef<HTMLDivElement>(null);

  const muat = useCallback(() => aturanApi.daftar().then(
    (d) => { setDaftar(d); setKeadaan("ok"); setGalat(""); onBerubah?.(d); },
    (x) => { if ((x as { status?: number }).status === 404) setKeadaan("mati"); else { setKeadaan("galat"); setGalat(pesan(x)); } },
  ), [onBerubah]);
  useEffect(() => {
    if (!buka) return;
    muat();
    aturanApi.katalog().then(setKatalog).catch(() => {});
  }, [buka, muat]);
  // Esc closes the innermost layer: the delete question, then the form, then the drawer
  useEffect(() => {
    if (!buka) return;
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (hapus) setHapus(null); else if (form) setForm(null); else onTutup();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [buka, hapus, form, onTutup]);

  const nama = useMemo(() => new Map((katalog?.modus ?? []).map((m) => [m.kode, m.nama])), [katalog]);
  const semua = useMemo<Baris[]>(() => [
    ...(daftar?.kustom ?? []).map((a) => ({ key: a.id, jenis: "kustom" as const, kode: a.kode, label: a.label, modus: a.modus ?? [], bobot: a.bobot, a,
      teks: `${a.kode} ${a.label} ${a.deskripsi ?? ""} ${a.kondisi}`.toLowerCase() })),
    ...(daftar?.bawaan ?? []).map((b) => ({ key: `b:${b.kode}`, jenis: "bawaan" as const, kode: b.kode, label: b.label, modus: b.modus ?? [], bobot: b.bobot, b,
      teks: `${b.kode} ${b.label} ${b.deskripsi ?? ""} ${b.tag ?? ""}`.toLowerCase() })),
  ], [daftar]);
  const hitung = useMemo(() => ({
    semua: semua.length, kustom: semua.filter((r) => r.jenis === "kustom").length, bawaan: semua.filter((r) => r.jenis === "bawaan").length,
    model: semua.filter((r) => r.b?.masuk_model).length,
  }), [semua]);
  const q = cari.trim().toLowerCase();
  const tampil = semua.filter((r) => (saring === "semua" || (saring === "model" ? !!r.b?.masuk_model : r.jenis === saring)) && (!q || r.teks.includes(q)));
  const kustomBerjalan = (daftar?.kustom ?? []).filter((a) => a.versi_aktif != null).length;
  const bawaanMati = (daftar?.bawaan ?? []).filter((b) => !b.aktif).length;

  const selesai = (m: string) => {
    setForm(null); setInfo(m); muat(); onDiubah?.();
    badan.current?.scrollTo({ top: 0 });
    window.setTimeout(() => setInfo((x) => (x === m ? "" : x)), 8000);
  };
  const lakukanHapus = async () => {
    if (!hapus) return;
    setHapusBusy(true); setHapusGalat("");
    try {
      const r = await aturanApi.hapus(hapus.id);
      setHapus(null);
      selesai(`Rule ${r.kode} dihapus${r.berjalan_sebelumnya ? " dan langsung berhenti menilai klaim" : ""}. Riwayatnya tetap tersimpan di log.`);
    } catch (x) { setHapusGalat(pesan(x)); } finally { setHapusBusy(false); }
  };

  if (!buka) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Kelola rule engine">
      <button type="button" aria-label="Tutup kelola rule" className="absolute inset-0 cursor-default bg-black/55" onClick={onTutup} />
      <div className="relative flex h-full w-full max-w-[1100px] flex-col border-l border-white/10 bg-[#171b20] shadow-[0_0_60px_rgba(0,0,0,.5)]">
        <div className="flex shrink-0 items-start gap-3 border-b border-white/[.07] px-5 py-3.5">
          <span className="mt-0.5 rounded-md bg-[#3987e5]/15 p-1.5 text-[#8abbff]"><Icon name="logic" className="h-4 w-4" /></span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-white">Rule engine · kelola rule</h2>
            <p className="text-[11.5px] leading-snug text-[#abb3bf]">
              Tahap pertama arsitektur ML v7: setiap klaim dicek rule ini dulu, lalu skor rule-nya ikut menjadi masukan model.
              {daftar && <> {hitung.bawaan} rule bawaan ({hitung.model} dibaca model{bawaanMati ? `, ${bawaanMati} dimatikan` : ""}) · {hitung.kustom} rule kustom ({kustomBerjalan} berjalan).</>}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Chip nada={admin ? "hijau" : "redup"} ikon={admin ? "check" : "lock"}>{admin ? "Admin" : "Butuh persetujuan admin"}</Chip>
            {onHalamanLengkap && <button onClick={onHalamanLengkap} className={`${tombolNetral} hidden md:inline-flex`}><Icon name="external" className="h-3.5 w-3.5" />Uji, persetujuan & log</button>}
            <button onClick={onTutup} className="rounded p-1.5 text-[#8f99a8] hover:bg-white/10 hover:text-white" aria-label="Tutup" title="Tutup (Esc)"><Icon name="x" className="h-4 w-4" /></button>
          </div>
        </div>

        <div ref={badan} className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 text-[12px]">
          {keadaan === "memuat" && <p className="text-[12px] text-[#8f99a8]">Membaca daftar rule…</p>}
          {(keadaan === "mati" || keadaan === "galat") && (
            <div className="space-y-2 rounded-lg border border-white/[.07] bg-[#1c2127] p-3.5">
              <p className="font-semibold text-white">{keadaan === "mati" ? "API rule engine belum aktif (menunggu restart API)" : "Daftar rule tidak terbaca"}</p>
              <p className="text-[11.5px] text-[#abb3bf]">{keadaan === "mati" ? "Endpoint /api/aip/realtime/v1/aturan belum ada di API yang sedang berjalan." : galat}</p>
              <button onClick={() => { setKeadaan("memuat"); muat(); }} className={tombolNetral}><Icon name="refresh" className="h-3.5 w-3.5" />Coba lagi</button>
            </div>
          )}

          {keadaan === "ok" && form && (
            <div className="pb-0">
              {form.jenis === "bawaan"
                ? <FormBawaan key={form.b.kode} b={form.b} matikan={form.matikan} admin={admin} onSelesai={selesai} onBatal={() => setForm(null)} />
                : <FormKustom key={form.jenis === "ubah" ? form.a.id : "baru"} form={form} katalog={katalog} admin={admin} onSelesai={selesai} onBatal={() => setForm(null)} />}
            </div>
          )}

          {keadaan === "ok" && !form && (
            <div className="space-y-3 pb-5">
              {info && (
                <p role="status" className="flex items-start gap-2 rounded border border-[#199e70]/40 bg-[#199e70]/10 px-3 py-2 text-[12px] text-[#bdf3dc]">
                  <Icon name="check" className="mt-px h-3.5 w-3.5 shrink-0" />{info}
                  <button onClick={() => setInfo("")} className="ml-auto text-[#7ee2c0] hover:text-white" aria-label="Tutup pesan"><Icon name="x" className="h-3 w-3" /></button>
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-[220px] flex-1">
                  <Icon name="search" className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#5f6b7a]" />
                  <input value={cari} onChange={(e) => { setCari(e.target.value); setN(PER_HALAMAN); }} placeholder="Cari kode, nama, atau isi rule" aria-label="Cari rule" className={`${masukan} w-full py-1.5 pl-7`} />
                </div>
                <div role="tablist" aria-label="Saring rule" className="flex rounded border border-white/10 p-0.5">
                  {SARING.map(([k, t]) => (
                    <button key={k} role="tab" aria-selected={saring === k} onClick={() => { setSaring(k); setN(PER_HALAMAN); }}
                      className={`rounded-sm px-2 py-1 text-[11px] ${saring === k ? "bg-white/10 text-white" : "text-[#abb3bf] hover:text-white"}`}>
                      {t} <span className="tabular-nums text-[#8f99a8]">{hitung[k]}</span>
                    </button>
                  ))}
                </div>
                <button onClick={() => setForm({ jenis: "baru" })} className={`${tombolUtama} py-1.5`}><Icon name="plus" className="h-3.5 w-3.5" />Rule baru</button>
              </div>

              <div className="overflow-hidden rounded-lg border border-white/[.07] bg-[#1c2127]">
                <div className={`hidden gap-x-3 border-b border-white/[.07] px-3 py-1.5 text-[10.5px] uppercase tracking-wide text-[#8f99a8] ${KOLOM}`}>
                  <span className="pl-5">Rule</span><span>Jenis fraud</span><span className="text-right">Bobot</span><span>Status</span><span className="text-right">Aksi</span>
                </div>
                {!tampil.length && (
                  <div className="px-3 py-6 text-center text-[12px] text-[#8f99a8]">
                    {saring === "kustom" && !q ? <>Belum ada rule kustom. <button onClick={() => setForm({ jenis: "baru" })} className="text-[#8abbff] hover:underline">Buat rule pertama</button></> : "Tidak ada rule yang cocok."}
                  </div>
                )}
                {tampil.slice(0, n).map((r, i, arr) => {
                  const open = bukaBaris === r.key;
                  const grup = i === 0 || arr[i - 1].jenis !== r.jenis;
                  const a = r.a, b = r.b;
                  return (
                    <div key={r.key}>
                      {grup && saring === "semua" && (
                        <p className="border-b border-white/[.05] bg-white/[.02] px-3 py-1 text-[10.5px] font-medium uppercase tracking-wide text-[#8f99a8]">
                          {r.jenis === "kustom" ? `Rule kustom · ${hitung.kustom}` : `Rule bawaan · ${hitung.bawaan}`}
                        </p>
                      )}
                      <div className={`group items-center gap-x-3 gap-y-1 border-b border-white/[.05] px-3 py-2 hover:bg-white/[.025] ${KOLOM} ${open ? "bg-white/[.025]" : ""}`}>
                        <button onClick={() => setBukaBaris(open ? null : r.key)} aria-expanded={open} className="flex min-w-0 items-start gap-2 text-left">
                          <Icon name={open ? "down" : "right"} className="mt-1 h-3 w-3 shrink-0 text-[#5f6b7a]" />
                          <span className="min-w-0">
                            <span className={`block truncate text-[12.5px] ${b && !b.aktif ? "text-[#8f99a8] line-through decoration-white/25" : "text-white"}`}>{r.label}</span>
                            <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10.5px]">
                              <span className="font-mono text-[#8f99a8]">{r.kode}</span>
                              {a ? <Chip nada="ungu">kustom</Chip> : <Chip nada="redup">bawaan</Chip>}
                              {b?.masuk_model && <Chip nada="biru" ikon="cpu" title="Salah satu dari 45 rule yang dibaca model ML v7 sebagai fitur">masukan ML v7</Chip>}
                              {a?.menggantikan && <Chip nada="ungu" ikon="restore">menggantikan {a.menggantikan}</Chip>}
                            </span>
                          </span>
                        </button>
                        <div className="min-w-0 pl-5 md:pl-0"><ModusSingkat kode={r.modus} nama={nama} /></div>
                        <div className="pl-5 text-[12px] tabular-nums text-[#d3d8de] md:pl-0 md:text-right">{idn(r.bobot, 2)}</div>
                        <div className="flex flex-wrap items-center gap-1 pl-5 md:pl-0">
                          {a ? <>
                            <StatusChip s={a.status} />
                            {a.versi_aktif != null && a.status !== "aktif" && <Chip nada="hijau">v{a.versi_aktif} berjalan</Chip>}
                          </> : b ? <>
                            <Chip nada={b.aktif ? "hijau" : "redup"}>{b.aktif ? "aktif" : "dimatikan"}</Chip>
                            {b.perubahan_menunggu && <Chip nada="kuning">ada perubahan</Chip>}
                          </> : null}
                        </div>
                        <div className="flex justify-end gap-0.5">
                          <button onClick={() => setForm(a ? { jenis: "ubah", a } : { jenis: "bawaan", b: b! })} className={ikonTombol} title={`Edit ${r.kode}`} aria-label={`Edit rule ${r.kode}`}>
                            <Icon name="pencil" className="h-3.5 w-3.5" />
                          </button>
                          {a ? (
                            <button onClick={() => { setHapusGalat(""); setHapus(a); }} className={`${ikonTombol} hover:!text-[#ffb4b4]`} title={`Hapus ${r.kode}`} aria-label={`Hapus rule ${r.kode}`}>
                              <Icon name="trash" className="h-3.5 w-3.5" />
                            </button>
                          ) : b ? (
                            <button onClick={() => setForm({ jenis: "bawaan", b, matikan: b.aktif })}
                              className="rounded px-1.5 py-1 text-[10.5px] text-[#abb3bf] transition hover:bg-white/10 hover:text-white"
                              title={b.aktif ? `Matikan ${r.kode} (rule bawaan tidak bisa dihapus)` : `Nyalakan ${r.kode}`} aria-label={`${b.aktif ? "Matikan" : "Nyalakan"} rule ${r.kode}`}>
                              {b.aktif ? "Matikan" : "Nyalakan"}
                            </button>
                          ) : null}
                        </div>
                      </div>
                      {open && <Detail r={r} nama={nama} />}
                    </div>
                  );
                })}
                {tampil.length > n && (
                  <button onClick={() => setN(n + PER_HALAMAN)} className="w-full px-3 py-2 text-center text-[11.5px] text-[#8abbff] hover:bg-white/[.03]">
                    Tampilkan {Math.min(PER_HALAMAN, tampil.length - n)} lagi · {idn(n)} dari {idn(tampil.length)} rule
                  </button>
                )}
              </div>
              <p className={bantuan}>Rule bawaan tidak bisa dihapus karena logikanya ada di kode program dan 45 di antaranya dibaca model ML v7; yang bisa: dimatikan atau diubah bobotnya.
                Rule kustom bisa diedit (jadi versi baru) dan dihapus. Setiap perubahan diuji pada data sintetis dan tercatat di log.</p>
            </div>
          )}
        </div>

        {hapus && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/50 p-4">
            <div role="alertdialog" aria-modal="true" aria-labelledby="hapus-judul" className="w-full max-w-[460px] space-y-3 rounded-lg border border-white/10 bg-[#1c2127] p-4 shadow-2xl">
              <div className="flex items-start gap-2.5">
                <span className="rounded-md bg-[#d03b3b]/15 p-1.5 text-[#ffb4b4]"><Icon name="trash" className="h-4 w-4" /></span>
                <div className="min-w-0">
                  <h3 id="hapus-judul" className="text-[14px] font-semibold text-white">Hapus rule {hapus.kode}?</h3>
                  <p className="mt-0.5 text-[12px] text-[#d3d8de]">{hapus.label}</p>
                </div>
              </div>
              <ul className="space-y-1 text-[11.5px] text-[#abb3bf]">
                <li>{hapus.versi_aktif != null ? `Rule ini sedang berjalan (versi ${hapus.versi_aktif}) dan akan langsung berhenti menilai klaim.` : "Rule ini belum berjalan, jadi tidak ada klaim yang terpengaruh."}</li>
                <li>Riwayat versi dan log tetap disimpan untuk jejak audit; kodenya bisa dipakai lagi.</li>
                {hapus.versi_aktif != null && !admin && <li className="text-[#fbd38d]">Hanya admin yang bisa menghapus rule yang sedang berjalan.</li>}
              </ul>
              {hapusGalat && <p className="text-[11.5px] text-[#ffb4b4]">{hapusGalat}</p>}
              <div className="flex justify-end gap-2">
                <button onClick={() => setHapus(null)} disabled={hapusBusy} className={tombolNetral}>Batal</button>
                <button onClick={lakukanHapus} disabled={hapusBusy || (hapus.versi_aktif != null && !admin)} className={`${tombolBahaya} bg-[#d03b3b]/10`} autoFocus>
                  <Icon name="trash" className="h-3.5 w-3.5" />{hapusBusy ? "Menghapus…" : "Hapus rule"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
