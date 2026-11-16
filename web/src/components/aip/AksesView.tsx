"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { PERMISSION_COLORS } from "@/components/lineage/coloring";
import { wib } from "@/components/aip/aipRun";
import { API_URL } from "@/lib/api";

/* Keamanan & Akses (AIP JKN tab): who may open which data of the BPJS sample, per role and per stage — computed by the
   platform's own access check (GET /api/aip/akses, api/aip/akses.py: the check behind Data Lineage → Permissions).
   A matrix role × stage whose cells are shaded by the share that can be read (one hue: more is stronger; closed is
   empty), a detail panel beside it with each data source and why, and the four layers the access rests on. */

type Status = "view" | "no_access" | "no_data" | "unknown";
// buka: the access roles that alone would open a closed item to this account (checked by the platform, not guessed)
type Item = { id: string; nama: string; status: Status; alasan: string; buka?: string[] };
type Sel = Record<Status, number> & { items: Item[] };
type Peran = { username: string; id: string; nama: string; judul: string; tugas: string; atribut: Record<string, string>; tahap: Record<string, Sel> };
// an access role: a group that carries an access past a marking or a row policy, given by membership
type PeranAkses = { key: string; id: string | null; nama: string; membuka: string; ada: boolean; penanda: string[]; semua_baris: boolean; anggota: string[] };
type Akses = {
  tahap: { id: string; nama: string; isi: string }[]; peran: Peran[]; graf: string | null; dibangun: string | null; bisa_bangun: boolean;
  lapisan: { id: string; nama: string; arti: string; aturan: string[] }[]; peran_akses?: PeranAkses[];
};

// the stages the data passes, then what is built on them (column groups)
const ALUR = ["arsip", "mentah", "bersih", "siap"];
const KELOMPOK: [string, string[]][] = [
  ["Tim data", ["demo.pengelola.data", "demo.pengembang"]],
  ["Investigasi & analisis", ["demo.kedeputian", "demo.analis"]],
  ["Kantor cabang", ["demo.kc.kota", "demo.kc.kabupaten", "demo.kc.raya"]],
];
const STATUS: Record<Status, string> = { view: "Bisa dibaca", no_data: "Boleh dibuka, belum berisi data", no_access: "Tertutup", unknown: "Tidak dinilai" };
const ORDER: Status[] = ["view", "no_data", "no_access", "unknown"];
const BLUE = "47, 127, 214"; // PERMISSION_COLORS.view, as rgb for the shading
// the share that can be opened → the cell's shade: one hue, a small share stays faint, all of it is strong
const shade = (share: number) => (0.1 + 0.72 * share).toFixed(2);
// each layer in one line (the API's full explanation is under "Aturan rinci")
const RINGKAS: Record<string, string> = {
  project: "Pengelola Data jadi Editor; peran lain hanya tahu datanya ada (Discoverer).",
  folder: "Tiap tahap adalah folder; peran pada folder membuka isinya untuk peran itu.",
  baris: "Portal restricted view: tiap auditor kantor cabang hanya melihat provinsinya.",
  penanda: "Syarat wajib yang ikut ke data turunan; tidak bisa dilewati peran apa pun.",
};

const idn = (n: number | string) => Number(n).toLocaleString("id-ID");
const pendek = (s: string) => s.replace(/ JKN \(demo\)$/, "").replace(/ \(demo\)$/, "").replace(/^Tim Investigasi Kedeputian — akses nasional$/, "Tim Investigasi Kedeputian");
const peranLabel = (r: string) => ({ viewer: "Viewer", editor: "Editor", owner: "Owner", discoverer: "Discoverer" })[r.trim()] ?? r;

/** the platform's reasons (Data Lineage speaks English) in plain Indonesian */
const ALASAN: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^(\d+) of (\d+) rows$/, (m) => `${idn(m[1])} dari ${idn(m[2])} baris, menurut kebijakan baris`],
  [/^the row policy leaves 0 of (\d+) rows$/, (m) => `kebijakan baris tidak memberi satu pun dari ${idn(m[1])} baris`],
  [/^(\d+) of (\d+) objects$/, (m) => `${idn(m[1])} dari ${idn(m[2])} objek, menurut kebijakan objek`],
  [/^the object policy leaves 0 of (\d+) objects$/, (m) => `kebijakan objek tidak memberi satu pun dari ${idn(m[1])} objek`],
  [/^(\d+) objects$/, (m) => `${idn(m[1])} objek`],
  [/^(Viewer|Editor|Owner|Discoverer) on (.+)$/, (m) => `${m[1]} pada ${m[2]}`],
  [/^missing marking (.+)$/, (m) => `butuh penanda ${m[1]}`],
  [/^missing a marking of its backing data$/, () => "butuh penanda pada datanya"],
  [/^missing a marking or a role$/, () => "butuh peran atau penanda"],
  [/^no role with this permission on its Project( or folder)?$/, () => "tidak punya peran di Project atau foldernya"],
  [/^no role on the view's Project, or a marking it carries$/, () => "tidak punya peran di Project portal"],
  [/^the dataset has no data(?: \((.+)\))?$/, (m) => "belum berisi data" + (m[1] ? ` · ${m[1].replace(/ on /, " pada ")}` : "")],
  [/^the dataset was deleted$/, () => "dataset sudah dihapus"],
  [/^no data permission for this kind of resource$/, () => "jenis ini tidak punya izin data"],
];
function alasan(it: Item): string {
  if (!it.alasan) return it.status === "view" ? "lewat peran di Project" : "";
  for (const [re, f] of ALASAN) {
    const m = it.alasan.match(re);
    if (m) return f(m);
  }
  return it.alasan;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, { cache: "no-store", ...init });
  if (!r.ok) {
    const d = (await r.json().catch(() => ({}))).detail;
    throw new Error(typeof d === "string" ? d : `${r.status} ${r.statusText}`);
  }
  return r.json();
}

const bisa = (s?: Sel) => (s ? s.view + s.no_data : 0);

/** one cell: shaded by the share that can be opened (one hue, more is stronger); closed is an empty cell */
function Cell({ s, on, onPick, onHover }: { s?: Sel; on: boolean; onPick: () => void; onHover: (el: HTMLElement | null) => void }) {
  const total = s?.items.length ?? 0;
  if (!s || !total) return <div className="flex h-11 items-center justify-center text-[#5f6b7c]">·</div>;
  const open = bisa(s);
  const share = open / total;
  return (
    <button type="button" onClick={onPick} onMouseEnter={(e) => onHover(e.currentTarget)} onMouseLeave={() => onHover(null)}
      onFocus={(e) => onHover(e.currentTarget)} onBlur={() => onHover(null)}
      aria-label={`${idn(open)} dari ${idn(total)} bisa dibuka`}
      style={{ background: open ? `rgba(${BLUE}, ${shade(share)})` : undefined }}
      className={`flex h-11 w-full flex-col items-center justify-center rounded transition-[box-shadow,filter] hover:brightness-125 focus:outline-none ${
        on ? "ring-2 ring-white" : open ? "" : "ring-1 ring-inset ring-white/[0.06] hover:ring-white/20"}`}>
      {open ? (
        <>
          <span className="text-[12.5px] font-medium tabular-nums text-white">{open === total ? `${idn(total)}` : `${idn(open)}/${idn(total)}`}</span>
          <span className="text-[9.5px] leading-none text-white/75">{open === total ? (s.view ? "semua" : "tanpa data") : "sebagian"}</span>
        </>
      ) : (
        <Icon name="lock" className="h-3 w-3 text-[#5f6b7c]" />
      )}
    </button>
  );
}

export function AksesView() {
  const [a, setA] = useState<Akses | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState("");
  const [chosen, setPilih] = useState<{ u: string; t: string | null } | null>(null);
  const [hover, setHover] = useState<{ u: string; t: string; el: HTMLElement } | null>(null);
  const fetchAkses = useCallback((segar: boolean) => req<Akses>(`/api/aip/akses${segar ? "?segar=true" : ""}`)
    .then((x) => (setA(x), setErr("")), (e: Error) => setErr(e.message)), []);
  // a refresh keeps the matrix on screen, dimmed, until the new one is in
  const load = (segar = false) => { setLoading(true); return fetchAkses(segar).finally(() => setLoading(false)); };
  useEffect(() => { fetchAkses(false); }, [fetchAkses]);
  // the panel opens on something: the first role's Siap Analisis
  const pilih = chosen ?? (a?.peran.length ? { u: a.peran[0].username, t: "siap" } : null);
  const groups = useMemo(() => {
    if (!a) return [];
    const named = new Set(KELOMPOK.flatMap(([, us]) => us));
    const out = KELOMPOK.map(([label, us]) => [label, a.peran.filter((p) => us.includes(p.username))] as const);
    return [...out, ["Lainnya", a.peran.filter((p) => !named.has(p.username))] as const].filter(([, ps]) => ps.length);
  }, [a]);

  // join or leave an access role: the access it carries follows at once; the matrix is computed anew
  const anggota = async (key: string, username: string, ikut: boolean) => {
    const role = a?.peran_akses?.find((r) => r.key === key);
    const who = a?.peran.find((p) => p.username === username)?.judul ?? username;
    setBusy(true); setNote("");
    try {
      await req("/api/aip/akses/peran/" + key + "/anggota", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, ikut }) });
      setNote(`${who} ${ikut ? "masuk ke" : "keluar dari"} ${role?.nama ?? key}. Matriks dihitung ulang…`);
      await load(true);
      setNote(`${who} ${ikut ? "masuk ke" : "keluar dari"} ${role?.nama ?? key}.`);
    } catch (e) { setNote((e as Error).message); } finally { setBusy(false); }
  };

  const terapkan = async () => {
    if (!window.confirm("Terapkan skema akses? Peran, grant folder, portal per wilayah dan penanda ditambahkan (tidak ada yang dicabut).")) return;
    setBusy(true); setNote("");
    try {
      const r = await req<Record<string, unknown>>("/api/aip/akses/bangun", { method: "POST" });
      setNote(`Skema diterapkan: ${(r.project as string[] | undefined)?.length ?? 0} peran Project, ${Object.keys((r.grants as object) ?? {}).length} grant folder/berkas, ${r.views ?? 0} restricted view, ${(r.nexus as string[] | undefined)?.length ?? 0} tipe Nexus baru bertanda.`);
      await load(true);
    } catch (e) { setNote((e as Error).message); } finally { setBusy(false); }
  };

  if (err && !a) return <div className="flex flex-1 items-center justify-center text-[12px] text-red-300">Skema akses tidak terbaca: {err}</div>;
  if (!a) return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-[12px] text-[#8f99a8]">
      <Icon name="refresh" className="h-4 w-4 animate-spin" />Menghitung apa yang bisa dibuka tiap peran…
    </div>
  );
  const stage = (id: string | null) => a.tahap.find((t) => t.id === id);
  const sel = pilih ? a.peran.find((p) => p.username === pilih.u) ?? null : null;
  const lineage = (id: string) => `/lineage?graph=${a.graf ?? ""}&viewAs=${id}`;
  const tip = hover ? { p: a.peran.find((p) => p.username === hover.u), t: stage(hover.t), r: hover.el.getBoundingClientRect() } : null;
  const nama = (p: Peran) => p.nama.split(" — ")[0];

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden text-[12px]" data-akses>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-white/5 bg-[#1c2127] px-4 py-2">
        <span className="font-semibold text-white">Keamanan &amp; Akses</span>
        <span className="text-[#abb3bf]">Siapa boleh membuka data apa, per peran dan per tahap</span>
        <span className="ml-auto flex items-center gap-2 text-[11px] text-[#8f99a8]">
          {a.dibangun && <span title="Waktu skema terakhir diterapkan">Diterapkan {wib(a.dibangun)}</span>}
          <button onClick={() => load(true)} disabled={loading} title="Hitung ulang dari aturan platform saat ini"
            className="flex items-center gap-1 rounded border border-white/10 px-2 py-0.5 text-[#d3d8de] hover:bg-white/5 disabled:opacity-50">
            <Icon name="refresh" className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />Hitung ulang
          </button>
          {a.bisa_bangun && (
            <button onClick={terapkan} disabled={busy} title="Tambahkan peran, grant folder, portal dan penanda (tidak mencabut apa pun)"
              className="flex items-center gap-1 rounded border border-white/10 px-2 py-0.5 text-[#d3d8de] hover:bg-white/5 disabled:opacity-50">
              <Icon name="lock" className="h-3 w-3" />{busy ? "Menerapkan…" : "Terapkan skema"}
            </button>
          )}
        </span>
      </div>
      {(note || err) && <p className="border-b border-white/5 bg-[#1c2127] px-4 py-1.5 text-[11.5px] text-[#c5cbd3]">{note || `Gagal menghitung ulang: ${err}`}</p>}

      <div className="flex min-h-0 flex-1">
        <div className={`min-w-0 flex-1 space-y-3 overflow-y-auto p-3 transition-opacity ${loading ? "opacity-60" : ""}`}>
          {/* the four layers, in the order they are checked */}
          <ol className="grid gap-2 md:grid-cols-4">
            {a.lapisan.map((l, i) => (
              <li key={l.id} className="rounded border border-white/10 bg-[#1c2127] px-3 py-2">
                <div className="flex items-center gap-2 font-medium text-white">
                  <span className="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full bg-white/10 text-[10.5px]">{i + 1}</span>{l.nama}
                </div>
                <p className="mt-1 text-[11px] leading-snug text-[#abb3bf]">{RINGKAS[l.id] ?? l.arti}</p>
              </li>
            ))}
          </ol>

          <div className="overflow-x-auto rounded border border-white/10 bg-[#1c2127]">
            <table className="w-full min-w-[900px] border-separate border-spacing-0.5 p-1.5">
              <thead>
                <tr className="text-[10.5px] uppercase tracking-wide text-[#8f99a8]">
                  <th />
                  <th colSpan={ALUR.length} className="border-b border-white/10 pb-1 text-left font-medium">Alur data</th>
                  <th colSpan={a.tahap.length - ALUR.length} className="border-b border-white/10 pb-1 pl-2 text-left font-medium">Dibangun di atasnya</th>
                </tr>
                <tr className="text-left align-bottom text-[11px]">
                  <th className="sticky left-0 z-10 w-[210px] bg-[#1c2127] px-2 pb-1.5 pt-2 font-medium text-[#abb3bf]">Peran</th>
                  {a.tahap.map((t, i) => (
                    <th key={t.id} title={t.isi} className={`px-1 pb-1.5 pt-2 font-medium text-[#e5e8eb] ${i === ALUR.length ? "pl-2" : ""}`}>
                      <span className="flex items-center gap-1">{t.nama}{i < ALUR.length - 1 && <span className="text-[#5f6b7c]">→</span>}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              {groups.map(([label, ps]) => (
                <tbody key={label}>
                  <tr><td colSpan={a.tahap.length + 1} className="sticky left-0 px-2 pb-0.5 pt-2.5 text-[10.5px] uppercase tracking-wide text-[#8f99a8]">{label}</td></tr>
                  {ps.map((p) => (
                    <tr key={p.username}>
                      <th scope="row" className="sticky left-0 z-10 bg-[#1c2127] px-1 text-left font-normal">
                        <button type="button" onClick={() => setPilih({ u: p.username, t: null })} title={p.tugas}
                          className={`w-full rounded px-1.5 py-1 text-left hover:bg-white/5 ${pilih?.u === p.username && !pilih.t ? "bg-white/10" : ""}`}>
                          <span className="block truncate font-medium text-white">{p.judul}</span>
                          <span className="block truncate text-[10.5px] text-[#8f99a8]">{p.nama.includes(" — ") ? `${nama(p)} · ` : ""}{p.username}</span>
                        </button>
                      </th>
                      {a.tahap.map((t, i) => (
                        <td key={t.id} className={`min-w-[86px] ${i === ALUR.length ? "pl-2" : ""}`}>
                          <Cell s={p.tahap[t.id]} on={pilih?.u === p.username && pilih?.t === t.id} onPick={() => setPilih({ u: p.username, t: t.id })}
                            onHover={(el) => setHover(el ? { u: p.username, t: t.id, el } : null)} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
            <div className="flex flex-wrap items-center gap-4 border-t border-white/10 px-3 py-1.5 text-[10.5px] text-[#abb3bf]">
              <span className="flex items-center gap-1.5">Bisa dibuka
                <span className="flex overflow-hidden rounded-sm">{[0.25, 0.5, 0.75, 1].map((s) => <span key={s} className="h-2.5 w-5" style={{ background: `rgba(${BLUE}, ${shade(s)})` }} />)}</span>
                sebagian → semua
              </span>
              <span className="flex items-center gap-1"><Icon name="lock" className="h-3 w-3 text-[#5f6b7c]" />tertutup</span>
              <span>angka = sumber data yang bisa dibuka; pilih sel untuk rincian dan alasannya</span>
            </div>
          </div>

          {/* the access roles: past a marking or a row policy only through a role, given and taken back by membership */}
          {(a.peran_akses ?? []).length > 0 && (
            <section className="rounded border border-white/10 bg-[#1c2127] p-3" data-peran-akses>
              <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium text-white">Peran akses</span>
                <span className="text-[11px] text-[#abb3bf]">Penanda dan kebijakan baris tidak dilewati per akun: aksesnya dipegang peran (grup), dan akun mendapatkannya dengan menjadi anggota.</span>
              </div>
              <div className="grid gap-2 lg:grid-cols-3">
                {a.peran_akses!.map((r) => {
                  const others = a.peran.filter((p) => !r.anggota.includes(p.username));
                  return (
                    <div key={r.key} className="flex flex-col rounded border border-white/10 bg-white/[0.02] px-2.5 py-2">
                      <div className="font-medium text-[#e5e8eb]">{r.nama.replace(/^Peran · /, "").replace(/ \(demo\)$/, "")}</div>
                      <p className="mt-0.5 text-[11px] leading-snug text-[#abb3bf]">{r.membuka}</p>
                      <div className="mt-1.5 flex flex-wrap gap-1 text-[10.5px]">
                        {r.penanda.map((m) => <span key={m} className="flex items-center gap-1 rounded bg-white/[0.06] px-1.5 py-0.5 text-[#c5cbd3]"><Icon name="lock" className="h-2.5 w-2.5" />{m}</span>)}
                        {r.semua_baris && <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[#c5cbd3]">semua baris di kebijakan baris portal</span>}
                      </div>
                      <div className="mt-2 text-[10.5px] uppercase tracking-wide text-[#8f99a8]">Anggota {r.anggota.length ? `(${r.anggota.length})` : ""}</div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {!r.anggota.length && <span className="text-[11px] text-[#8f99a8]">belum ada</span>}
                        {r.anggota.map((un) => {
                          const p = a.peran.find((x) => x.username === un);
                          return (
                            <span key={un} title={un} className="flex items-center gap-1 rounded bg-[rgba(47,127,214,0.25)] px-1.5 py-0.5 text-[11px] text-white">
                              {p?.judul ?? un}
                              {a.bisa_bangun && <button type="button" disabled={busy} onClick={() => anggota(r.key, un, false)} aria-label={`Keluarkan ${p?.judul ?? un}`} className="text-white/60 hover:text-white disabled:opacity-40"><Icon name="x" className="h-2.5 w-2.5" /></button>}
                            </span>
                          );
                        })}
                      </div>
                      {a.bisa_bangun && others.length > 0 && (
                        <select value="" disabled={busy || !r.ada} onChange={(e) => e.target.value && anggota(r.key, e.target.value, true)}
                          className="mt-2 rounded border border-white/10 bg-[#111418] px-1.5 py-1 text-[11px] text-[#d3d8de] disabled:opacity-50">
                          <option value="">+ Tambahkan akun ke peran ini…</option>
                          {others.map((p) => <option key={p.username} value={p.username}>{p.judul}</option>)}
                        </select>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <details className="rounded border border-white/10 bg-[#1c2127] px-3 py-2 text-[11.5px]">
            <summary className="cursor-pointer select-none font-medium text-white">Aturan rinci tiap lapis</summary>
            <div className="mt-2 grid gap-3 md:grid-cols-2">
              {a.lapisan.map((l, i) => (
                <div key={l.id}>
                  <div className="font-medium text-[#e5e8eb]">{i + 1}. {l.nama}</div>
                  <p className="mb-1 text-[11px] leading-snug text-[#abb3bf]">{l.arti}</p>
                  <ul className="space-y-0.5 text-[11px] text-[#c5cbd3]">
                    {l.aturan.map((x) => {
                      const [kiri, kanan] = x.includes(" → ") ? x.split(" → ") : [x, ""];
                      return <li key={x} className="break-words">· {pendek(kiri)}{kanan && <span className="text-[#8abbff]"> → {peranLabel(kanan)}</span>}</li>;
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </details>
        </div>

        {/* the detail panel: a cell (one role, one stage) or a whole role */}
        <aside className="hidden w-[360px] shrink-0 flex-col border-l border-white/10 bg-[#1c2127] lg:flex" data-akses-rinci>
          {sel ? (
            <>
              <div className="border-b border-white/10 px-3 py-2.5">
                <div className="font-medium text-white">{sel.judul}</div>
                <div className="text-[11px] text-[#8f99a8]">{sel.nama}</div>
                <p className="mt-1 text-[11px] leading-snug text-[#c5cbd3]">{sel.tugas}</p>
                {a.graf && (
                  <a href={lineage(sel.id)} target="_blank" rel="noreferrer" className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-[#8abbff] hover:underline">
                    <Icon name="split" className="h-3 w-3" />Lihat sebagai akun ini di Data Lineage
                  </a>
                )}
              </div>
              <div className="flex flex-wrap gap-1 border-b border-white/10 px-2 py-1.5">
                <button onClick={() => setPilih({ u: sel.username, t: null })}
                  className={`shrink-0 rounded px-2 py-0.5 text-[11px] ${!pilih?.t ? "bg-white/10 text-white" : "text-[#abb3bf] hover:bg-white/5"}`}>Ringkasan</button>
                {a.tahap.map((t) => (
                  <button key={t.id} onClick={() => setPilih({ u: sel.username, t: t.id })}
                    className={`shrink-0 rounded px-2 py-0.5 text-[11px] ${pilih?.t === t.id ? "bg-white/10 text-white" : "text-[#abb3bf] hover:bg-white/5"}`}>{t.nama}</button>
                ))}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
                {pilih?.t ? <Rinci s={sel.tahap[pilih.t]} t={stage(pilih.t)} roles={a.peran_akses ?? []} admin={a.bisa_bangun} busy={busy}
                  onJoin={(key) => anggota(key, sel.username, true)} /> : (
                  <ul className="space-y-1.5">
                    {a.tahap.map((t) => {
                      const s = sel.tahap[t.id];
                      const total = s?.items.length ?? 0;
                      return (
                        <li key={t.id}>
                          <button onClick={() => setPilih({ u: sel.username, t: t.id })} className="w-full rounded px-1.5 py-1 text-left hover:bg-white/5">
                            <span className="flex items-baseline justify-between gap-2">
                              <span className="text-[#e5e8eb]">{t.nama}</span>
                              <span className="tabular-nums text-[11px] text-[#abb3bf]">{total ? `${idn(bisa(s))} dari ${idn(total)}` : "—"}</span>
                            </span>
                            <span className="mt-1 flex h-1.5 overflow-hidden rounded-sm bg-white/[0.06]">
                              {total > 0 && <span style={{ width: `${(100 * bisa(s)) / total}%`, background: PERMISSION_COLORS.view.color }} />}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </>
          ) : (
            <p className="p-3 text-[11.5px] text-[#8f99a8]">Pilih peran atau sel untuk melihat apa yang bisa dibuka dan alasannya.</p>
          )}
        </aside>
      </div>

      {tip?.p && tip.t && (
        <div role="tooltip" className="pointer-events-none fixed z-50 w-64 rounded border border-white/10 bg-[#111418] px-2.5 py-2 text-[11px] shadow-2xl"
          style={{ left: Math.min(tip.r.left + tip.r.width / 2 - 128, window.innerWidth - 272), top: tip.r.bottom + 6 }}>
          {(() => {
            const s = tip.p.tahap[tip.t.id];
            const total = s?.items.length ?? 0;
            const shut = s?.items.filter((x) => x.status === "no_access") ?? [];
            return (
              <>
                <div className="text-[12.5px] font-semibold tabular-nums text-white">{total ? `${idn(bisa(s))} dari ${idn(total)} bisa dibuka` : "tidak ada sumber"}</div>
                <div className="text-[#abb3bf]">{tip.p.judul} · {tip.t.nama}</div>
                {shut.length > 0 && <div className="mt-1 text-[#c5cbd3]">Tertutup: {alasan(shut[0])}{shut.length > 1 ? ` (+${shut.length - 1})` : ""}</div>}
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}

/** a cell's data sources, grouped by what the account can do with them; sources that share a reason are listed under
 *  it once (eighteen "through a role on the Project" said once), a reason of its own stays beside its source. A closed
 *  source that an access role would open says which, and an administrator adds the account to it from here. */
function Rinci({ s, t, roles, admin, busy, onJoin }: {
  s?: Sel; t?: { nama: string; isi: string }; roles: PeranAkses[]; admin: boolean; busy: boolean; onJoin: (key: string) => void;
}) {
  if (!s || !s.items.length) return <p className="text-[11.5px] text-[#8f99a8]">Tidak ada sumber data di tahap ini.</p>;
  const label = (k: string) => (roles.find((r) => r.key === k)?.nama ?? k).replace(/^Peran · /, "").replace(/ \(demo\)$/, "");
  const solve = (keys?: string[]) => keys?.length ? (
    <div className="mt-1 flex flex-wrap items-center gap-1 text-[10.5px]">
      <span className="text-[#abb3bf]">Dibuka oleh peran</span>
      {keys.map((k) => admin ? (
        <button key={k} type="button" disabled={busy} onClick={() => onJoin(k)} title="Tambahkan akun ini ke peran itu"
          className="flex items-center gap-1 rounded border border-[#2f7fd6]/60 px-1.5 py-0.5 text-[#8abbff] hover:bg-[#2f7fd6]/20 disabled:opacity-50">
          <Icon name="plus" className="h-2.5 w-2.5" />{label(k)}
        </button>
      ) : <span key={k} className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[#c5cbd3]">{label(k)}</span>)}
    </div>
  ) : null;
  return (
    <div className="space-y-3">
      {t && <p className="text-[11px] text-[#8f99a8]">{t.nama}: {t.isi}</p>}
      {ORDER.map((st) => {
        const its = s.items.filter((x) => x.status === st).sort((x, y) => x.nama.localeCompare(y.nama));
        if (!its.length) return null;
        // grouped by reason and by the roles that would open them: one "join" for all the sources it opens
        const by = new Map<string, Item[]>();
        for (const it of its) {
          const k = `${alasan(it)}|${(it.buka ?? []).join(",")}`;
          by.set(k, [...(by.get(k) ?? []), it]);
        }
        const shared = [...by].filter(([, xs]) => xs.length > 1);
        const own = [...by].filter(([, xs]) => xs.length === 1).map(([, xs]) => xs[0]);
        return (
          <div key={st}>
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-[#e5e8eb]">
              <span className="h-2 w-2 rounded-sm" style={{ background: PERMISSION_COLORS[st].color }} />{STATUS[st]} <span className="font-normal text-[#8f99a8]">{its.length}</span>
            </div>
            <div className="space-y-1">
              {shared.map(([k, xs]) => (
                <div key={k} className="rounded bg-white/[0.03] px-2 py-1.5">
                  {alasan(xs[0]) && <div className="mb-1 text-[10.5px] text-[#abb3bf]">{alasan(xs[0])} · {xs.length} sumber</div>}
                  <div className="flex flex-wrap gap-1">
                    {xs.map((it) => <span key={it.id} title={it.nama} className="max-w-full truncate rounded bg-white/[0.06] px-1.5 py-0.5 text-[11px] text-[#e5e8eb]">{it.nama}</span>)}
                  </div>
                  {solve(xs[0].buka)}
                </div>
              ))}
              {own.map((it) => (
                <div key={it.id} className="rounded bg-white/[0.03] px-2 py-1">
                  <div className="truncate text-[#e5e8eb]" title={it.nama}>{it.nama}</div>
                  {alasan(it) && <div className="text-[10.5px] text-[#abb3bf]">{alasan(it)}</div>}
                  {solve(it.buka)}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
