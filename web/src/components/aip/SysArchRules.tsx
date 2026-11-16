"use client";

// System Architecture · Rule engine (the user, 2026-11-12: "user bisa tambah rule pake bahasa manusia nanti AI analisis itu terus
// bisa integrasi ke rule engine, kalau ada yg diperbaiki bisa perbaiki pake bahasa manusia juga"): built-in and custom rules, a
// plain-language box that asks the AI for a draft, the draft editor with the parser's live check, the backtest, and the
// approval flow draf → diuji → menunggu → aktif (approve, reject, switch off and roll back are admin-only, enforced by the API).
// Contract: docs/RULE_ENGINE_KONTRAK.md. While the API has no rule endpoints (404) the section says so calmly.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/AuthGate";
import { Icon } from "@/components/Icon";
import { Catatan, Chip, Galat, Judul, Memuat, idn, kartu, masukan, pct, tombolAdmin, tombolAi, tombolBahaya, tombolNetral, tombolUtama } from "./SysArchShared";
import { aturanApi, pesan, RuleApiError, type Aturan, type Bawaan, type Daftar, type Draf, type Katalog, type LogBaris, type Uji } from "./SysArchRuleApi";
import { DrafEditor, KatalogPanel, StatusChip, UjiView, waktu, type ModeEditor, type Tersimpan } from "./SysArchRuleParts";

const URUT_STATUS = ["menunggu", "aktif", "diuji", "draf", "ditolak", "nonaktif"];
const KOSONG: Draf = { kode: "", label: "", deskripsi: "", kondisi: "", modus: [], bobot: 1, aksi: "aturan_baru" };

/** the flow every new or changed rule goes through */
function Alur({ hitung }: { hitung: Record<string, number> }) {
  const langkah: [string, string][] = [["draf", "AI atau manual"], ["diuji", "uji pada data sintetis"], ["menunggu", "diajukan ke admin"], ["aktif", "masuk rule engine"]];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {langkah.map(([k, s], i) => (
        <div key={k} className="flex items-center gap-1.5">
          {i > 0 && <Icon name="right" className="h-3.5 w-3.5 text-[#5f6b7a]" />}
          <div className="rounded-md border border-white/[.08] bg-[#151a1f] px-2 py-1">
            <p className="flex items-center gap-1.5 text-[11.5px] text-white"><StatusChip s={k} />{hitung[k] ? <span className="tabular-nums text-[#c5cbd3]">{hitung[k]}</span> : null}</p>
            <p className="text-[10px] text-[#8f99a8]">{s}</p>
          </div>
        </div>
      ))}
      <span className="ml-1 text-[10.5px] text-[#8f99a8]">Setiap edit membuat versi baru dan kembali ke draf. Admin bisa menolak, menonaktifkan, atau rollback.</span>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ plain-language box

function Komposer({ katalog, onTersimpan }: { katalog: Katalog | null; onTersimpan: (x: Tersimpan) => void }) {
  const [teks, setTeks] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [draf, setDraf] = useState<Draf | null>(null);
  const [n, setN] = useState(0);
  const analisis = async () => {
    if (!teks.trim()) return;
    setBusy(true); setErr("");
    try { setDraf(await aturanApi.aiDraf(teks.trim())); setN((x) => x + 1); } catch (x) { setErr(pesan(x)); } finally { setBusy(false); }
  };
  return (
    <section className={`${kartu} space-y-2.5 p-3.5`}>
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="sparkle" className="h-4 w-4 text-[#c7c9ff]" />
        <h3 className="text-[13px] font-semibold text-white">Buat rule dengan bahasa manusia</h3>
        <Chip nada="ungu">AI (DeepSeek)</Chip>
      </div>
      <textarea value={teks} onChange={(e) => setTeks(e.target.value)} rows={3}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) analisis(); }}
        placeholder="Contoh: tandai klaim rawat inap yang top-up obatnya lebih dari 3 kali p95 kodenya, padahal peserta tidak berobat 30 hari sebelumnya."
        className={`${masukan} w-full resize-y text-[12.5px] leading-relaxed`} />
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={analisis} disabled={busy || !teks.trim()} className={tombolAi}><Icon name="sparkle" className="h-3.5 w-3.5" />{busy ? "AI menganalisis…" : "Analisis jadi rule"}</button>
        <button onClick={() => { setDraf({ ...KOSONG }); setN((x) => x + 1); }} className={tombolNetral}><Icon name="code" className="h-3.5 w-3.5" />Tulis kondisi manual</button>
        <span className="text-[10.5px] leading-snug text-[#8f99a8]">AI hanya melihat daftar field, fungsi dan modus, tidak pernah baris klaim. Hasilnya diperiksa parser dan tidak bisa mengaktifkan apa pun.</span>
      </div>
      {err && <p className="text-[11px] text-[#ffb4b4]">{err}</p>}
      {draf && (
        <DrafEditor key={n} draf={draf} mode={{ jenis: "baru" }} katalog={katalog} judul={draf.penjelasan ? "Draf dari AI" : "Draf rule baru"}
          onBatal={() => setDraf(null)} onTersimpan={(x) => { setDraf(null); setTeks(""); onTersimpan(x); }} />
      )}
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ one custom rule

function DetailAturan({ a, admin, katalog, onBerubah }: { a: Aturan; admin: boolean; katalog: Katalog | null; onBerubah: () => void }) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [catatan, setCatatan] = useState("");
  const [ujiBaru, setUjiBaru] = useState<Uji | null>(null);
  const [editor, setEditor] = useState<{ draf: Draf | Aturan; judul: string; n: number } | null>(null);
  const [aiBuka, setAiBuka] = useState(false);
  const [aiTeks, setAiTeks] = useState("");
  const [rb, setRb] = useState<number | "">("");
  const uji = ujiBaru ?? a.uji ?? null;
  const versiLain = useMemo(() => {
    const v = new Set((a.riwayat ?? []).map((r) => r.versi).filter((x) => typeof x === "number" && x !== a.versi));
    if (!v.size) for (let i = 1; i < a.versi; i++) v.add(i);
    return [...v].sort((x, y) => y - x);
  }, [a.riwayat, a.versi]);
  const pernahAktif = new Set((a.riwayat ?? []).filter((r) => r.status === "aktif").map((r) => r.versi));

  const jalan = async (nama: string, f: () => Promise<unknown>) => {
    setBusy(nama); setErr("");
    try { await f(); onBerubah(); } catch (x) { setErr(pesan(x)); } finally { setBusy(""); }
  };
  const buka = (draf: Draf | Aturan, judul: string) => setEditor((e) => ({ draf, judul, n: (e?.n ?? 0) + 1 }));
  const aiEdit = () => jalan("ai", async () => { buka(await aturanApi.aiEdit({ id: a.id }, aiTeks.trim()), "Perbaikan dari AI"); setAiBuka(false); setAiTeks(""); });
  const aiPerbaiki = () => jalan("perbaiki", async () => buka(await aturanApi.aiPerbaiki(a.id), "Perbaikan AI dari hasil uji"));

  const s = a.status;
  const bisaUji = ["draf", "diuji", "ditolak", "nonaktif"].includes(s);
  return (
    <div className="space-y-3 border-t border-white/[.06] bg-[#151a1f] p-3">
      {a.deskripsi && <p className="text-[11.5px] leading-snug text-[#d3d8de]">{a.deskripsi}</p>}
      <div>
        <p className="mb-0.5 text-[10.5px] text-[#8f99a8]">Kondisi · versi {a.versi}</p>
        <pre className="whitespace-pre-wrap break-words rounded border border-white/[.08] bg-[#111418] px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-[#e5e8eb]">{a.kondisi}</pre>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10.5px] text-[#8f99a8]">
        {a.dibuat_oleh && <span>dibuat {a.dibuat_oleh}{a.dibuat ? ` · ${waktu(a.dibuat)}` : ""}</span>}
        {a.diubah_oleh && <span>diubah {a.diubah_oleh}{a.diubah ? ` · ${waktu(a.diubah)}` : ""}</span>}
        {a.menggantikan && <span>menggantikan rule bawaan <span className="font-mono text-[#c7c9ff]">{a.menggantikan}</span> (dimatikan saat disetujui)</span>}
      </div>

      {/* actions by status; the API refuses what the status or the role does not allow */}
      <div className="flex flex-wrap items-center gap-1.5">
        {bisaUji && <button disabled={!!busy} onClick={() => jalan("uji", async () => setUjiBaru(await aturanApi.uji(a.id)))} className={tombolUtama}>
          <Icon name="play" className="h-3.5 w-3.5" />{busy === "uji" ? "Menguji…" : uji ? "Uji ulang" : "Uji"}</button>}
        {s === "diuji" && <button disabled={!!busy} onClick={() => jalan("ajukan", () => aturanApi.ajukan(a.id, catatan.trim() || undefined))} className={tombolUtama}>
          <Icon name="upload" className="h-3.5 w-3.5" />{busy === "ajukan" ? "Mengajukan…" : "Ajukan ke admin"}</button>}
        {admin && s === "menunggu" && <>
          <button disabled={!!busy} onClick={() => jalan("setujui", () => aturanApi.setujui(a.id, catatan.trim() || undefined))} className={tombolAdmin}>
            <Icon name="check" className="h-3.5 w-3.5" />{busy === "setujui" ? "Menyetujui…" : "Setujui"}</button>
          <button disabled={!!busy || !catatan.trim()} title={catatan.trim() ? "" : "Tulis alasan penolakan di catatan"} onClick={() => jalan("tolak", () => aturanApi.tolak(a.id, catatan.trim()))} className={tombolBahaya}>
            <Icon name="x" className="h-3.5 w-3.5" />Tolak</button>
        </>}
        {admin && s === "aktif" && <button disabled={!!busy} onClick={() => jalan("nonaktif", () => aturanApi.nonaktifkan(a.id))} className={tombolBahaya}>
          <Icon name="stop" className="h-3.5 w-3.5" />{busy === "nonaktif" ? "Menonaktifkan…" : "Nonaktifkan"}</button>}
        <span className="mx-1 h-4 w-px bg-white/10" />
        <button disabled={!!busy} onClick={() => setAiBuka(!aiBuka)} className={tombolAi}><Icon name="sparkle" className="h-3.5 w-3.5" />Perbaiki dengan bahasa manusia</button>
        {uji && <button disabled={!!busy} onClick={aiPerbaiki} className={tombolAi}><Icon name="restore" className="h-3.5 w-3.5" />{busy === "perbaiki" ? "AI membaca hasil uji…" : "Perbaiki dari hasil uji"}</button>}
        <button disabled={!!busy} onClick={() => buka(a, "Edit manual")} className={tombolNetral}><Icon name="edit" className="h-3.5 w-3.5" />Edit manual</button>
      </div>
      {(s === "diuji" || (admin && s === "menunggu")) && (
        <input value={catatan} onChange={(e) => setCatatan(e.target.value)} placeholder={admin && s === "menunggu" ? "Catatan persetujuan / alasan penolakan" : "Catatan pengajuan (opsional)"}
          className={`${masukan} w-full max-w-xl`} />
      )}
      {admin && !!versiLain.length && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[#abb3bf]">
          <span>Rollback:</span>
          <select value={rb} onChange={(e) => setRb(e.target.value ? Number(e.target.value) : "")} className={`${masukan} py-0.5 text-[11.5px]`}>
            <option value="">pilih versi</option>
            {versiLain.map((v) => <option key={v} value={v}>versi {v}{pernahAktif.has(v) ? " (pernah aktif)" : ""}</option>)}
          </select>
          <button disabled={!!busy || rb === ""} onClick={() => rb !== "" && jalan("rollback", () => aturanApi.rollback(a.id, rb))} className={tombolAdmin}>
            <Icon name="restore" className="h-3.5 w-3.5" />{rb === "" ? "Rollback" : `Rollback ke versi ${rb}`}</button>
        </div>
      )}
      {err && <p className="text-[11px] text-[#ffb4b4]">{err}</p>}
      {aiBuka && (
        <div className="space-y-1.5 rounded-md border border-[#9d8cff]/30 p-2.5">
          <textarea value={aiTeks} onChange={(e) => setAiTeks(e.target.value)} rows={2} autoFocus
            placeholder="Apa yang perlu diperbaiki? Contoh: terlalu banyak klaim normal kena, batasi ke rawat inap kelas 1 saja."
            className={`${masukan} w-full resize-y`} />
          <button disabled={!!busy || !aiTeks.trim()} onClick={aiEdit} className={tombolAi}><Icon name="sparkle" className="h-3.5 w-3.5" />{busy === "ai" ? "AI menyusun perbaikan…" : "Minta perbaikan ke AI"}</button>
        </div>
      )}
      {editor && (
        <DrafEditor key={editor.n} draf={editor.draf} mode={{ jenis: "versi", aturan: a }} katalog={katalog} judul={editor.judul}
          onBatal={() => setEditor(null)} onTersimpan={() => { setEditor(null); onBerubah(); }} />
      )}

      {uji ? <UjiView uji={uji} versiAturan={a.versi} /> : <Catatan>Belum diuji. Uji menjalankan kondisi pada klaim sintetis berlabel yang sudah dinilai engine.</Catatan>}

      {!!a.riwayat?.length && (
        <div>
          <p className="mb-1 text-[11px] font-semibold text-white">Riwayat</p>
          <ol className="space-y-1 border-l border-white/10 pl-3">
            {[...a.riwayat].reverse().map((r, i) => (
              <li key={i} className="relative text-[11px] text-[#c5cbd3]">
                <span className="absolute -left-[15.5px] top-[5px] h-[7px] w-[7px] rounded-full bg-[#5f6b7a]" />
                <span className="font-mono text-[10.5px] text-[#8f99a8]">v{r.versi}</span> <StatusChip s={r.status} /> {r.oleh && <span>{r.oleh}</span>}
                {r.waktu && <span className="text-[#8f99a8]"> · {waktu(r.waktu)}</span>}{r.catatan && <span className="text-[#abb3bf]"> · {r.catatan}</span>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function DaftarKustom({ rows, admin, katalog, buka, setBuka, onBerubah }: { rows: Aturan[]; admin: boolean; katalog: Katalog | null; buka: string | null; setBuka: (id: string | null) => void; onBerubah: () => void }) {
  const [filter, setFilter] = useState("semua");
  const hitung = rows.reduce<Record<string, number>>((c, r) => ((c[r.status] = (c[r.status] ?? 0) + 1), c), {});
  const urut = [...rows].filter((r) => filter === "semua" || r.status === filter)
    .sort((x, y) => (URUT_STATUS.indexOf(x.status) - URUT_STATUS.indexOf(y.status)) || (y.diubah ?? y.dibuat ?? "").localeCompare(x.diubah ?? x.dibuat ?? ""));
  return (
    <section className={`${kartu} overflow-hidden`}>
      <div className="flex flex-wrap items-center gap-2 p-3.5 pb-2.5">
        <h3 className="text-[13px] font-semibold text-white">Rule kustom</h3>
        <span className="text-[11px] text-[#8f99a8]">{rows.length} rule</span>
        <div className="ml-auto flex flex-wrap gap-1">
          {["semua", ...URUT_STATUS.filter((s) => hitung[s])].map((s) => (
            <button key={s} onClick={() => setFilter(s)} className={`rounded px-1.5 py-0.5 text-[10.5px] ${filter === s ? "bg-white/10 text-white" : "text-[#8f99a8] hover:text-white"}`}>
              {s === "semua" ? `Semua · ${rows.length}` : `${s} · ${hitung[s]}`}</button>
          ))}
        </div>
      </div>
      {!rows.length ? <div className="px-3.5 pb-3.5"><Catatan>Belum ada rule kustom. Tulis satu dengan bahasa manusia di atas.</Catatan></div> : (
        <ul>
          {urut.map((r) => {
            const on = buka === r.id;
            return (
              <li key={r.id} className="border-t border-white/[.05]">
                <button onClick={() => setBuka(on ? null : r.id)} className={`flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-3.5 py-2 text-left hover:bg-white/[.03] ${on ? "bg-white/[.04]" : ""}`}>
                  <Icon name={on ? "down" : "right"} className="h-3 w-3 shrink-0 text-[#8f99a8]" />
                  <StatusChip s={r.status} />
                  <span className="font-mono text-[11.5px] text-[#e5e8eb]">{r.kode}</span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-white">{r.label}</span>
                  {r.menggantikan && <Chip nada="ungu" ikon="restore" title={`menggantikan ${r.menggantikan}`}>{r.menggantikan}</Chip>}
                  {(r.modus ?? []).slice(0, 3).map((m) => <Chip key={m} nada="redup" mono>{m}</Chip>)}
                  <span className="text-[10.5px] tabular-nums text-[#8f99a8]">v{r.versi} · bobot {idn(r.bobot, 2)}</span>
                  {r.uji && <span className="text-[10.5px] tabular-nums text-[#abb3bf]">recall {pct(r.uji.recall, 0)} · normal {pct(r.uji.laju_normal, 2)}</span>}
                </button>
                {on && <DetailAturan key={`${r.id}-${r.versi}-${r.status}`} a={r} admin={admin} katalog={katalog} onBerubah={onBerubah} />}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ built-in rules

function DetailBawaan({ b, admin, katalog, onBerubah }: { b: Bawaan; admin: boolean; katalog: Katalog | null; onBerubah: () => void }) {
  const p = b.perubahan_menunggu ?? null;
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [catatan, setCatatan] = useState("");
  const [manual, setManual] = useState(false);
  const [m, setM] = useState({ aktif: b.aktif, bobot: b.bobot, catatan: "" });
  const [aiBuka, setAiBuka] = useState(false);
  const [aiTeks, setAiTeks] = useState("");
  const [editor, setEditor] = useState<{ draf: Draf; n: number } | null>(null);
  const [ujiBaru, setUjiBaru] = useState<Uji | null>(null);
  const uji = ujiBaru ?? p?.uji ?? null;
  const jalan = async (nama: string, f: () => Promise<unknown>) => {
    setBusy(nama); setErr("");
    try { await f(); onBerubah(); } catch (x) { setErr(pesan(x)); } finally { setBusy(""); }
  };
  const mode: ModeEditor = { jenis: "bawaan", bawaan: b };
  const ps = p?.status ?? "draf";
  return (
    <div className="space-y-3 bg-[#151a1f] p-3">
      <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
        {b.deskripsi && <span className="text-[#d3d8de]">{b.deskripsi}</span>}
        {b.tag && <Chip nada="redup" mono>{b.tag}</Chip>}
        <span className="text-[10.5px] text-[#8f99a8]">Logikanya tetap di Python (modus.py); yang bisa diubah: aktif dan bobot, atau diganti rule kustom.</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button disabled={!!busy} onClick={() => setManual(!manual)} className={tombolNetral}><Icon name="sliders" className="h-3.5 w-3.5" />Ubah aktif / bobot</button>
        <button disabled={!!busy} onClick={() => setAiBuka(!aiBuka)} className={tombolAi}><Icon name="sparkle" className="h-3.5 w-3.5" />Perbaiki dengan bahasa manusia</button>
      </div>
      {manual && (
        <div className="flex flex-wrap items-end gap-2 rounded-md border border-white/[.08] p-2.5">
          <label className="flex items-center gap-1.5 text-[11.5px] text-[#d3d8de]"><input type="checkbox" checked={m.aktif} onChange={(e) => setM({ ...m, aktif: e.target.checked })} />Aktif</label>
          <label className="text-[11.5px] text-[#d3d8de]"><span className="block text-[10.5px] text-[#8f99a8]">Bobot (default {idn(b.bobot_default, 2)})</span>
            <input type="number" step={0.05} min={0} max={5} value={m.bobot} onChange={(e) => setM({ ...m, bobot: Number(e.target.value) })} className={`${masukan} w-24 tabular-nums`} /></label>
          <input value={m.catatan} onChange={(e) => setM({ ...m, catatan: e.target.value })} placeholder="Catatan (opsional)" className={`${masukan} min-w-[200px] flex-1`} />
          <button disabled={!!busy || (m.aktif === b.aktif && m.bobot === b.bobot)}
            onClick={() => jalan("manual", async () => { await aturanApi.bawaanUbah(b.kode, { aktif: m.aktif, bobot: m.bobot, ...(m.catatan.trim() ? { catatan: m.catatan.trim() } : {}) }); setManual(false); })}
            className={tombolUtama}><Icon name="save" className="h-3.5 w-3.5" />{busy === "manual" ? "Menyimpan…" : "Simpan perubahan (draf)"}</button>
        </div>
      )}
      {aiBuka && (
        <div className="space-y-1.5 rounded-md border border-[#9d8cff]/30 p-2.5">
          <textarea value={aiTeks} onChange={(e) => setAiTeks(e.target.value)} rows={2} autoFocus
            placeholder="Contoh: rule ini terlalu sering kena di RS kelas D, turunkan bobotnya; atau: hanya untuk rawat inap dengan LOS di atas p90."
            className={`${masukan} w-full resize-y`} />
          <button disabled={!!busy || !aiTeks.trim()} className={tombolAi}
            onClick={() => jalan("ai", async () => { const d = await aturanApi.aiEdit({ kode_bawaan: b.kode }, aiTeks.trim()); setEditor((e) => ({ draf: d, n: (e?.n ?? 0) + 1 })); setAiBuka(false); setAiTeks(""); })}>
            <Icon name="sparkle" className="h-3.5 w-3.5" />{busy === "ai" ? "AI menyusun perbaikan…" : "Minta perbaikan ke AI"}</button>
          <p className="text-[10.5px] text-[#8f99a8]">AI memilih: ubah parameter (aktif/bobot), atau rule kustom yang menggantikan rule ini (rule bawaan dimatikan saat penggantinya disetujui).</p>
        </div>
      )}
      {editor && (
        <DrafEditor key={editor.n} draf={editor.draf} mode={mode} katalog={katalog}
          judul={editor.draf.aksi === "ubah_parameter" ? "Usulan AI: ubah parameter" : "Usulan AI: rule kustom pengganti"}
          onBatal={() => setEditor(null)} onTersimpan={() => { setEditor(null); onBerubah(); }} />
      )}
      {err && <p className="text-[11px] text-[#ffb4b4]">{err}</p>}

      {p && (
        <div className="space-y-2 rounded-md border border-white/[.08] p-2.5">
          <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
            <span className="font-semibold text-white">Perubahan tertunda</span><StatusChip s={ps} />
            {p.aktif != null && p.aktif !== b.aktif && <span className="text-[#d3d8de]">aktif: {b.aktif ? "ya" : "tidak"} → <b>{p.aktif ? "ya" : "tidak"}</b></span>}
            {p.bobot != null && p.bobot !== b.bobot && <span className="tabular-nums text-[#d3d8de]">bobot: {idn(b.bobot, 2)} → <b>{idn(p.bobot, 2)}</b></span>}
            {(p.dibuat_oleh || p.oleh) && <span className="text-[10.5px] text-[#8f99a8]">oleh {p.dibuat_oleh ?? p.oleh}{p.dibuat || p.waktu ? ` · ${waktu(p.dibuat ?? p.waktu)}` : ""}</span>}
            {p.catatan && <span className="text-[10.5px] text-[#abb3bf]">· {p.catatan}</span>}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {["draf", "diuji", "ditolak"].includes(ps) && <button disabled={!!busy} onClick={() => jalan("uji", async () => setUjiBaru(await aturanApi.bawaanUji(b.kode)))} className={tombolUtama}>
              <Icon name="play" className="h-3.5 w-3.5" />{busy === "uji" ? "Menguji…" : uji ? "Uji ulang" : "Uji"}</button>}
            {ps === "diuji" && <button disabled={!!busy} onClick={() => jalan("ajukan", () => aturanApi.bawaanAjukan(b.kode, catatan.trim() || undefined))} className={tombolUtama}>
              <Icon name="upload" className="h-3.5 w-3.5" />Ajukan ke admin</button>}
            {admin && ps === "menunggu" && <>
              <button disabled={!!busy} onClick={() => jalan("setujui", () => aturanApi.bawaanSetujui(b.kode, catatan.trim() || undefined))} className={tombolAdmin}>
                <Icon name="check" className="h-3.5 w-3.5" />{busy === "setujui" ? "Menyetujui…" : "Setujui"}</button>
              <button disabled={!!busy || !catatan.trim()} title={catatan.trim() ? "" : "Tulis alasan penolakan di catatan"} onClick={() => jalan("tolak", () => aturanApi.bawaanTolak(b.kode, catatan.trim()))} className={tombolBahaya}>
                <Icon name="x" className="h-3.5 w-3.5" />Tolak</button>
            </>}
            {(ps === "diuji" || (admin && ps === "menunggu")) && <input value={catatan} onChange={(e) => setCatatan(e.target.value)} placeholder="Catatan" className={`${masukan} min-w-[200px] flex-1`} />}
          </div>
          {uji ? <UjiView uji={uji} /> : <p className="text-[10.5px] text-[#8f99a8]">Belum diuji.</p>}
        </div>
      )}
    </div>
  );
}

function TabelBawaan({ rows, admin, katalog, onBerubah }: { rows: Bawaan[]; admin: boolean; katalog: Katalog | null; onBerubah: () => void }) {
  const [cari, setCari] = useState("");
  const [buka, setBuka] = useState<string | null>(null);
  const [tertunda, setTertunda] = useState(false);
  const q = cari.trim().toLowerCase();
  const shown = rows.filter((b) => (!tertunda || b.perubahan_menunggu) && (!q || `${b.kode} ${b.label} ${(b.modus ?? []).join(" ")} ${b.tag ?? ""}`.toLowerCase().includes(q)));
  const nTunda = rows.filter((b) => b.perubahan_menunggu).length;
  return (
    <section className={`${kartu} overflow-hidden`}>
      <div className="flex flex-wrap items-center gap-2 p-3.5 pb-2.5">
        <h3 className="text-[13px] font-semibold text-white">Rule bawaan</h3>
        <span className="text-[11px] text-[#8f99a8]">{rows.length} sinyal engine · {rows.filter((b) => b.aktif).length} aktif</span>
        <label className="ml-auto flex items-center gap-1.5 text-[11px] text-[#abb3bf]"><input type="checkbox" checked={tertunda} onChange={(e) => setTertunda(e.target.checked)} />Ada perubahan ({nTunda})</label>
        <input value={cari} onChange={(e) => setCari(e.target.value)} placeholder="Cari kode, label, modus" className={`${masukan} w-48`} />
      </div>
      <div className="max-h-[560px] overflow-auto border-t border-white/[.05]">
        <table className="w-full text-left text-[11.5px]">
          <thead className="sticky top-0 z-10 bg-[#20262d] text-[#abb3bf]">
            <tr>
              <th className="px-2 py-1.5 font-medium">Kode</th><th className="px-2 py-1.5 font-medium">Label</th><th className="px-2 py-1.5 font-medium">Modus</th>
              <th className="px-2 py-1.5 text-right font-medium">Bobot</th><th className="px-2 py-1.5 font-medium">Aktif</th><th className="px-2 py-1.5 font-medium">Perubahan</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((b) => {
              const on = buka === b.kode;
              const p = b.perubahan_menunggu;
              return [
                <tr key={b.kode} onClick={() => setBuka(on ? null : b.kode)} className={`cursor-pointer border-t border-white/[.04] hover:bg-white/[.03] ${on ? "bg-white/[.04]" : ""}`}>
                  <td className="whitespace-nowrap px-2 py-1 font-mono text-[11px] text-[#e5e8eb]"><Icon name={on ? "down" : "right"} className="mr-1 inline h-3 w-3 text-[#8f99a8]" />{b.kode}</td>
                  <td className="max-w-[320px] truncate px-2 py-1 text-[#e5e8eb]" title={b.label}>{b.label}</td>
                  <td className="px-2 py-1"><span className="flex flex-wrap gap-1">{(b.modus ?? []).map((x) => <Chip key={x} nada="redup" mono>{x}</Chip>)}</span></td>
                  <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums text-[#e5e8eb]">{idn(b.bobot, 2)}
                    {b.bobot !== b.bobot_default && <span className="ml-1 text-[10px] text-[#8f99a8]">(default {idn(b.bobot_default, 2)})</span>}</td>
                  <td className="px-2 py-1">{b.aktif ? <Chip nada="hijau">aktif</Chip> : <Chip nada="redup">mati</Chip>}</td>
                  <td className="px-2 py-1">{p ? <StatusChip s={p.status ?? "draf"} /> : <span className="text-[#5f6b7a]">—</span>}</td>
                </tr>,
                on ? <tr key={`${b.kode}-d`}><td colSpan={6} className="p-0"><DetailBawaan key={`${b.kode}-${p?.status ?? ""}-${p?.versi ?? ""}`} b={b} admin={admin} katalog={katalog} onBerubah={onBerubah} /></td></tr> : null,
              ];
            })}
          </tbody>
        </table>
        {!shown.length && <p className="px-3.5 py-3 text-[11.5px] text-[#8f99a8]">Tidak ada rule yang cocok.</p>}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ log

function Log({ rows }: { rows: LogBaris[] | null }) {
  const [semua, setSemua] = useState(false);
  if (!rows) return <Memuat teks="Memuat log…" />;
  const urut = [...rows].sort((a, b) => (b.waktu ?? "").localeCompare(a.waktu ?? ""));
  const shown = semua ? urut : urut.slice(0, 40);
  return (
    <section className={`${kartu} p-3.5`}>
      <div className="flex items-center gap-2"><Icon name="history" className="h-4 w-4 text-[#8f99a8]" /><h3 className="text-[13px] font-semibold text-white">Log rule engine</h3>
        <span className="text-[11px] text-[#8f99a8]">{rows.length} entri</span></div>
      {!rows.length ? <p className="mt-2 text-[11.5px] text-[#8f99a8]">Belum ada aktivitas.</p> : (
        <ol className="mt-2 max-h-[420px] space-y-1.5 overflow-y-auto pr-1">
          {shown.map((r, i) => (
            <li key={i} className="text-[11px] leading-snug">
              <p className="flex flex-wrap items-center gap-1.5">
                <span className="tabular-nums text-[#8f99a8]">{waktu(r.waktu)}</span>
                {r.aksi && <Chip nada={r.aksi.includes("setuju") || r.aksi.includes("aktif") ? "hijau" : r.aksi.includes("tolak") ? "merah" : r.aksi.includes("rollback") ? "ungu" : "netral"}>{r.aksi}</Chip>}
                <span className="font-mono text-[10.5px] text-[#e5e8eb]">{r.kode ?? r.id}</span>{r.versi != null && <span className="text-[#8f99a8]">v{r.versi}</span>}
              </p>
              <p className="text-[#abb3bf]">{r.oleh}{r.catatan ? ` · ${r.catatan}` : ""}</p>
            </li>
          ))}
        </ol>
      )}
      {urut.length > shown.length && <button onClick={() => setSemua(true)} className="mt-1.5 text-[10.5px] text-[#8abbff] hover:underline">Lihat semua {urut.length}</button>}
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ section

export function SysArchRules() {
  const { me, enabled } = useAuth();
  const admin = !enabled || me?.role === "admin";
  const [daftar, setDaftar] = useState<Daftar | null>(null);
  const [katalog, setKatalog] = useState<Katalog | null>(null);
  const [log, setLog] = useState<LogBaris[] | null>(null);
  const [keadaan, setKeadaan] = useState<"memuat" | "ok" | "mati" | "galat">("memuat");
  const [galat, setGalat] = useState("");
  const [buka, setBuka] = useState<string | null>(null);
  const [katalogBuka, setKatalogBuka] = useState(false);

  // the list answers whether the rule engine API is live: 404 = its endpoints are not in the running API yet
  const ok = useCallback((d: Daftar) => {
    setDaftar(d); setKeadaan("ok"); setGalat("");
    aturanApi.log().then(setLog).catch(() => setLog([]));
    aturanApi.katalog().then(setKatalog).catch(() => {});
  }, []);
  const gagal = useCallback((x: unknown) => {
    if ((x as RuleApiError).status === 404) setKeadaan("mati");
    else { setKeadaan("galat"); setGalat(pesan(x)); }
  }, []);
  const muat = useCallback(() => { aturanApi.daftar().then(ok, gagal); }, [ok, gagal]);
  useEffect(() => { aturanApi.daftar().then(ok, gagal); }, [ok, gagal]);

  const hitung = useMemo(() => (daftar?.kustom ?? []).reduce<Record<string, number>>((c, r) => ((c[r.status] = (c[r.status] ?? 0) + 1), c), {}), [daftar]);
  const tersimpan = (x: Tersimpan) => { if (x.aturan) setBuka(x.aturan.id); muat(); };

  const kepala = (
    <Judul ikon="logic" judul="Rule engine · rule kustom dan bawaan"
      sub="Tambah atau perbaiki rule dengan bahasa manusia; setiap rule baru atau berubah diuji dulu, lalu disetujui admin, baru aktif. Data sintetis."
      kanan={<>
        <Chip nada={admin ? "hijau" : "redup"} ikon={admin ? "check" : "lock"}>{admin ? "Anda admin: bisa menyetujui" : "Persetujuan oleh admin"}</Chip>
        {keadaan === "ok" && <button onClick={muat} className={tombolNetral}><Icon name="refresh" className="h-3.5 w-3.5" />Muat ulang</button>}
      </>} />
  );

  if (keadaan === "memuat") return <section className={`${kartu} space-y-3 p-3.5`}>{kepala}<Memuat teks="Menghubungi rule engine…" /></section>;
  if (keadaan === "mati" || keadaan === "galat") {
    return (
      <section className={`${kartu} space-y-3 p-3.5`}>
        {kepala}
        <Alur hitung={{}} />
        {keadaan === "mati" ? (
          <Catatan ikon="clock">
            <p className="font-semibold text-white">API rule engine belum aktif (menunggu restart API)</p>
            <p className="mt-0.5">Endpoint <span className="font-mono">/api/aip/realtime/v1/aturan</span> belum ada di API yang sedang berjalan. Arsitektur ML dan konfigurasi AI Agent Swarm tetap bisa dibuka.</p>
            <button onClick={() => { setKeadaan("memuat"); muat(); }} className={`${tombolNetral} mt-2`}><Icon name="refresh" className="h-3.5 w-3.5" />Coba lagi</button>
          </Catatan>
        ) : (
          <>
            <Galat teks={`Rule engine tidak terbaca: ${galat}`} />
            <button onClick={() => { setKeadaan("memuat"); muat(); }} className={tombolNetral}><Icon name="refresh" className="h-3.5 w-3.5" />Coba lagi</button>
          </>
        )}
      </section>
    );
  }

  return (
    <div className="space-y-4">
      <section className={`${kartu} space-y-3 p-3.5`}>
        {kepala}
        <Alur hitung={hitung} />
        {daftar?.ringkas && (
          <div className="flex flex-wrap gap-1.5 text-[11px]">
            <Chip nada="hijau">{daftar.ringkas.aktif ?? 0} rule kustom aktif</Chip>
            <Chip nada="kuning">{daftar.ringkas.menunggu ?? 0} menunggu persetujuan</Chip>
            <Chip>{daftar.ringkas.draf ?? 0} draf</Chip>
          </div>
        )}
      </section>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-4">
          <Komposer katalog={katalog} onTersimpan={tersimpan} />
          <DaftarKustom rows={daftar?.kustom ?? []} admin={admin} katalog={katalog} buka={buka} setBuka={setBuka} onBerubah={muat} />
          <TabelBawaan rows={daftar?.bawaan ?? []} admin={admin} katalog={katalog} onBerubah={muat} />
        </div>
        <div className="min-w-0 space-y-4">
          <Log rows={log} />
          {katalog && (
            <section className={`${kartu} p-3.5`}>
              <button onClick={() => setKatalogBuka(!katalogBuka)} className="flex w-full items-center gap-2 text-left">
                <Icon name="list" className="h-4 w-4 text-[#8f99a8]" /><h3 className="flex-1 text-[13px] font-semibold text-white">Field & fungsi kondisi</h3>
                <span className="text-[10.5px] text-[#8f99a8]">{katalog.fields?.length ?? 0} field · {katalog.fungsi?.length ?? 0} fungsi</span>
                <Icon name={katalogBuka ? "down" : "right"} className="h-3.5 w-3.5 text-[#8f99a8]" />
              </button>
              {katalogBuka && <div className="mt-2.5"><KatalogPanel katalog={katalog} /></div>}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

