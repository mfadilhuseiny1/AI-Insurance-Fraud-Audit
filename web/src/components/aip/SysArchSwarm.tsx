"use client";

// System Architecture · AI Agent Swarm config (read-only; the user, 2026-11-12: "... sama ai agent swarm config"): the
// orchestration versions (Blu 1.0 / 1.1 / 1.3 / 3.0), the model in every seat and the roster size by line. Read from the
// consultancy's own endpoints (api/aip/konsultan.py): GET /konfigurasi (versions, IT seats and their default models), GET /tim
// (the Blu 1.x roster), GET /tim?versi=3.0 (Blu 3.0, aip/blu3.py roster on blu3.seats()) and GET /v3 (Blu 3.0's data profile).
// The seat of each agent is derived from its roster entry (jenjang, peran_kode, lini); nothing here is typed by hand.

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { modelName } from "./aipRun";
import { fraud, type FirmAgent, type FirmConfig, type Team, type V3Status } from "./fraudApi";
import { LINI } from "./KonsultanView";
import { ChartCard, SERIES, SURFACE, Tooltip, useTip } from "./viz";
import { Angka, Catatan, Chip, Galat, Judul, Legenda, Memuat, Tabel, idn, kartu, pct } from "./SysArchShared";

type Tim = Team & { versi?: string; profil_data?: { aktif: string; paket: boolean } };
type Muat<T> = { data?: T; err?: string };

const URUT_LINI = ["pimpinan", "wilayah", "peer", "modus", "ml", "kasus", "qa", "laporan"];
const URUT_KURSI = ["Orkestrator · partner", "Agen pimpinan lini", "Validator", "Reviewer QA", "Red team (peran)", "Analis wilayah", "Analis peer kelas",
  "Spesialis modus", "Agen kelompok modus", "Sub-agen teknik ML", "Penyidik kasus (peran)", "Editor & analis exhibit", "Redaksi laporan"];
const KODE = "kode";
const nama = (m: string) => (m === KODE ? "kode (tanpa model)" : modelName(m));

/** the seat an agent of a roster sits in, from its roster entry */
function kursiDari(a: FirmAgent): string {
  if (a.jenjang === "partner") return "Orkestrator · partner";
  if (a.model === KODE || a.peran_kode === "redaksi") return "Redaksi laporan";
  if (a.peran_kode === "validator") return "Validator";
  if (a.jenjang === "manajer") return "Agen pimpinan lini";
  if (a.peran_kode === "qa") return "Reviewer QA";
  if (a.peran_kode === "red_team") return "Red team (peran)";
  if (a.peran_kode === "penyidik") return "Penyidik kasus (peran)";
  if (a.peran_kode === "editor" || a.peran_kode === "analis_exhibit") return "Editor & analis exhibit";
  if (a.lini === "wilayah") return "Analis wilayah";
  if (a.lini === "peer") return "Analis peer kelas";
  if (a.lini === "modus") return a.key.startsWith("famili_") ? "Agen kelompok modus" : "Spesialis modus";
  if (a.lini === "ml") return "Sub-agen teknik ML";
  return a.name;
}

/** seat -> model -> agents */
function kursiTim(t?: Tim): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const a of t?.tim ?? []) {
    const k = kursiDari(a);
    const m = out.get(k) ?? new Map<string, number>();
    m.set(a.model, (m.get(a.model) ?? 0) + 1);
    out.set(k, m);
  }
  return out;
}

const perLini = (t?: Tim) => {
  const c: Record<string, number> = {};
  for (const a of t?.tim ?? []) c[a.lini] = (c[a.lini] ?? 0) + 1;
  return c;
};

function ModelSel({ m }: { m?: Map<string, number> }) {
  if (!m || !m.size) return <span className="text-[11px] text-[#5f6b7a]">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {[...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => <Chip key={k} nada={k === KODE ? "redup" : "netral"} mono>{nama(k)} ×{n}</Chip>)}
    </span>
  );
}

/** agents per line, Blu 3.0 next to Blu 1.x */
function UkuranLini({ t3, t1 }: { t3?: Tim; t1?: Tim }) {
  const { box, tip, at, clear } = useTip();
  const a3 = perLini(t3), a1 = perLini(t1);
  const lini = [...URUT_LINI, ...Object.keys({ ...a3, ...a1 }).filter((k) => !URUT_LINI.includes(k))].filter((k) => a3[k] || a1[k]);
  const top = Math.max(1, ...lini.map((k) => Math.max(a3[k] ?? 0, a1[k] ?? 0)));
  const seri = [{ k: "3.0", nama: "Blu 3.0", warna: SERIES[0], d: a3 }, { k: "1.0", nama: "Blu 1.0 / 1.1 / 1.3", warna: SERIES[1], d: a1 }];
  const hilang = lini.filter((k) => !a3[k] && a1[k]).map((k) => LINI[k]?.label ?? k);
  return (
    <ChartCard title="Ukuran tim per lini"
      insight={`Blu 3.0: ${t3?.jumlah_agen ?? "—"} agen; Blu 1.x: ${t1?.jumlah_agen ?? "—"} agen.${hilang.length ? ` Tidak ada lagi di Blu 3.0: ${hilang.join(", ")}.` : ""}`}
      table={<Tabel kepala={["Lini", "Blu 3.0", "Blu 1.x"]} kanan={[1, 2]} baris={[...lini.map((k) => [LINI[k]?.label ?? k, a3[k] ?? 0, a1[k] ?? 0]),
        ["Jumlah", t3?.jumlah_agen ?? "—", t1?.jumlah_agen ?? "—"]]} />}
      source={<span>GET /api/aip/konsultan/tim · peran (penyidik, red team) dihitung satu; instansnya dibentuk saat penugasan</span>}>
      <div ref={box} className="relative" onPointerLeave={clear}>
        <div className="mb-2"><Legenda items={seri.map((s) => [s.warna, s.nama])} /></div>
        <div className="space-y-2">
          {lini.map((k) => (
            <div key={k} className="grid items-center gap-2" style={{ gridTemplateColumns: "minmax(0, 34%) 1fr" }}>
              <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-[#e5e8eb]">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: LINI[k]?.color ?? "#8f99a8" }} /><span className="truncate">{LINI[k]?.label ?? k}</span></span>
              <div className="space-y-[2px]">
                {seri.map((s) => (
                  <div key={s.k} tabIndex={0} className="flex items-center gap-1.5 outline-none"
                    onPointerMove={(e) => at(e, { title: LINI[k]?.label ?? k, lines: seri.map((x) => ({ key: x.warna, value: idn(x.d[k] ?? 0), label: x.nama })) })}
                    onFocus={(e) => at(e, { title: LINI[k]?.label ?? k, lines: [{ key: s.warna, value: idn(s.d[k] ?? 0), label: s.nama }] })} onBlur={clear}>
                    <span className="h-[9px] rounded-r-[4px]" style={{ width: `${Math.max((s.d[k] ?? 0) ? 1.5 : 0, (100 * (s.d[k] ?? 0)) / top) * 0.85}%`, background: s.warna }} />
                    <span className="text-[10.5px] tabular-nums text-[#c5cbd3]">{s.d[k] ?? 0}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <Tooltip tip={tip} />
      </div>
    </ChartCard>
  );
}

/** which model the agents of each version run on: one 100% bar per version, the colour following the model */
function CampuranModel({ t3, t1 }: { t3?: Tim; t1?: Tim }) {
  const { box, tip, at, clear } = useTip();
  const hitung = (t?: Tim) => {
    const c = new Map<string, number>();
    for (const a of t?.tim ?? []) c.set(a.model, (c.get(a.model) ?? 0) + 1);
    return c;
  };
  const c3 = hitung(t3), c1 = hitung(t1);
  const model = [...new Set([...c3.keys(), ...c1.keys()])].filter((m) => m !== KODE).sort((a, b) => nama(a).localeCompare(nama(b)));
  if ([...c3.keys(), ...c1.keys()].includes(KODE)) model.push(KODE);
  const warna = (m: string) => (m === KODE ? "#5f6b7a" : SERIES[model.indexOf(m) % SERIES.length]);
  const baris = [{ nama: "Blu 3.0", c: c3, n: t3?.jumlah_agen ?? 0 }, { nama: "Blu 1.x", c: c1, n: t1?.jumlah_agen ?? 0 }].filter((b) => b.n);
  return (
    <ChartCard title="Model per agen" insight="Tiap keluarga model memeriksa keluarga lain: QA dan validator tidak pernah dari keluarga yang pekerjaannya diperiksa."
      table={<Tabel kepala={["Model", "Blu 3.0", "Blu 1.x"]} kanan={[1, 2]} baris={model.map((m) => [nama(m), c3.get(m) ?? 0, c1.get(m) ?? 0])} />}>
      <div ref={box} className="relative" onPointerLeave={clear}>
        <div className="mb-2.5"><Legenda items={model.map((m) => [warna(m), nama(m)])} /></div>
        <div className="space-y-3">
          {baris.map((b) => (
            <div key={b.nama}>
              <p className="mb-1 text-[11.5px] text-[#e5e8eb]">{b.nama} <span className="text-[#8f99a8]">· {b.n} agen</span></p>
              <div className="flex h-3.5 w-full gap-[2px] overflow-hidden rounded-[4px]" style={{ background: SURFACE }}>
                {model.filter((m) => b.c.get(m)).map((m) => (
                  <span key={m} tabIndex={0} className="h-full min-w-[3px] outline-none hover:brightness-125 focus:brightness-125" style={{ flex: `${b.c.get(m) ?? 0} 1 0`, background: warna(m) }}
                    onPointerMove={(e) => at(e, { title: b.nama, lines: [{ key: warna(m), value: `${b.c.get(m)} agen`, label: `${nama(m)} · ${pct((b.c.get(m) ?? 0) / b.n, 0)}` }] })}
                    onFocus={(e) => at(e, { title: b.nama, lines: [{ key: warna(m), value: `${b.c.get(m)} agen`, label: nama(m) }] })} onBlur={clear} />
                ))}
              </div>
            </div>
          ))}
        </div>
        <Tooltip tip={tip} />
      </div>
    </ChartCard>
  );
}

export function SysArchSwarm() {
  const [cfg, setCfg] = useState<Muat<FirmConfig>>({});
  const [t3, setT3] = useState<Muat<Tim>>({});
  const [t1, setT1] = useState<Muat<Tim>>({});
  const [v3, setV3] = useState<Muat<V3Status>>({});
  useEffect(() => {
    const err = (e: unknown) => (e as Error).message || "gagal";
    fraud.config().then((data) => setCfg({ data }), (e) => setCfg({ err: err(e) }));
    fraud.team("3.0").then((data) => setT3({ data: data as Tim }), (e) => setT3({ err: err(e) }));
    fraud.team().then((data) => setT1({ data: data as Tim }), (e) => setT1({ err: err(e) }));
    fraud.v3Status().then((data) => setV3({ data }), (e) => setV3({ err: err(e) }));
  }, []);

  const k3 = useMemo(() => kursiTim(t3.data), [t3.data]);
  const k1 = useMemo(() => kursiTim(t1.data), [t1.data]);
  const kursi = useMemo(() => {
    const all = [...new Set([...k3.keys(), ...k1.keys()])];
    return all.sort((a, b) => (URUT_KURSI.indexOf(a) + 1 || 99) - (URUT_KURSI.indexOf(b) + 1 || 99));
  }, [k3, k1]);
  const versi = cfg.data?.versi ?? {};
  const kunci = Object.keys(versi).sort((a, b) => Number(a) - Number(b));
  const terbaru = kunci[kunci.length - 1];
  const rk = v3.data?.ringkasan;
  const prof = v3.data?.profil ?? t3.data?.profil_data;

  return (
    <div className="space-y-4">
      <section className={`${kartu} space-y-3 p-3.5`}>
        <Judul ikon="graph" judul="AI Agent Swarm · konfigurasi"
          sub="Versi orkestrasi, model di tiap kursi, dan ukuran tim. Hanya baca: proyek dan kursinya diatur di tab AI Agent Swarm."
          kanan={<a href="?tab=konsultan" className="inline-flex items-center gap-1.5 rounded border border-white/15 px-2 py-1 text-[11.5px] text-[#d3d8de] hover:bg-white/[.06]">
            <Icon name="external" className="h-3.5 w-3.5" />AI Agent Swarm</a>} />
        {cfg.err && <Galat teks={`Konfigurasi swarm tidak terbaca: ${cfg.err}`} />}
        {!cfg.data && !cfg.err && <Memuat teks="Memuat versi orkestrasi…" />}
        {!!kunci.length && (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {kunci.map((k) => {
              const v = versi[k];
              const t = k === "3.0" ? t3.data : t1.data;
              const mesin = t?.mesin ?? [];
              return (
                <div key={k} className={`min-w-0 rounded-md border p-2.5 ${k === terbaru ? "border-[#199e70]/40 bg-[#199e70]/[.06]" : "border-white/[.08] bg-[#151a1f]"}`}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[13px] font-semibold text-white">{v.nama}</span>
                    {k === terbaru && <Chip nada="hijau">terbaru</Chip>}
                    {t && <Chip nada="redup">{k === "3.0" ? `${t.jumlah_agen} agen` : `tim Blu 1.0 · ${t.jumlah_agen} agen`}</Chip>}
                  </div>
                  <p className="mt-1 text-[11.5px] leading-snug text-[#d3d8de]">{v.ringkas}</p>
                  {v.tambahan && <p className="mt-1 text-[10.5px] leading-snug text-[#8f99a8]">{v.tambahan}</p>}
                  {(k === "1.0" || k === "3.0") && !!mesin.length && (
                    <div className="mt-1.5 flex flex-wrap gap-1">{mesin.map((m) => <Chip key={m.key} nada="redup" ikon="cpu" title={m.peran}>{m.name}</Chip>)}</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className={`${kartu} p-3.5`}>
        <h3 className="text-[13px] font-semibold text-white">Model per kursi</h3>
        <p className="mt-0.5 text-[11.5px] text-[#abb3bf]">Dari roster tiap versi: kursi tiap agen menurut perannya, dan berapa agen di tiap model.</p>
        {(t3.err || t1.err) && <div className="mt-2"><Galat teks={`Roster tidak terbaca: ${t3.err ?? t1.err}`} /></div>}
        {(!t3.data && !t3.err) || (!t1.data && !t1.err) ? <Memuat teks="Memuat roster…" /> : (
          <div className="mt-2.5">
            <Tabel kepala={["Kursi", "Blu 3.0", "Blu 1.0 / 1.1 / 1.3"]}
              baris={kursi.map((k) => [<span key="k" className="whitespace-nowrap text-[#e5e8eb]">{k}</span>, <ModelSel key="3" m={k3.get(k)} />, <ModelSel key="1" m={k1.get(k)} />])} />
          </div>
        )}
        {!!cfg.data?.kursi?.length && (
          <div className="mt-3 border-t border-white/[.06] pt-2.5">
            <p className="mb-1.5 text-[11.5px] font-semibold text-white">Kursi yang diatur tim IT per proyek (Blu 1.x) · model default</p>
            <div className="grid gap-1.5 md:grid-cols-2">
              {cfg.data.kursi.map((s) => (
                <div key={s.kursi} className="flex min-w-0 items-start gap-2 rounded border border-white/[.06] px-2 py-1.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-[11.5px] text-[#e5e8eb]">{s.label}</p>
                    <p className="text-[10.5px] leading-snug text-[#8f99a8]">{s.dipakai}</p>
                  </div>
                  <Chip mono>{nama(s.default)}</Chip>
                </div>
              ))}
            </div>
            <p className="mt-1.5 text-[10.5px] text-[#8f99a8]">Blu 3.0 memakai kursinya sendiri: orkestrator saja di model pimpinan; model QA dan validator dari keluarga lain. Kursi pemeriksaan Blu 1.3 tetap, diatur server.</p>
          </div>
        )}
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        {t3.data || t1.data ? <UkuranLini t3={t3.data} t1={t1.data} /> : <div />}
        {t3.data || t1.data ? <CampuranModel t3={t3.data} t1={t1.data} /> : <div />}
      </div>

      <section className={`${kartu} p-3.5`}>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[13px] font-semibold text-white">Blu 3.0 · data dan alasan ukuran tim</h3>
          {prof && <Chip nada={prof.aktif === "v3" ? "hijau" : "kuning"}>{prof.aktif === "v3" ? "profil data v3 aktif" : `profil data: ${prof.aktif}`}</Chip>}
          {rk?.periode?.length ? <Chip nada="redup">periode {rk.periode.join("–")}</Chip> : null}
        </div>
        {v3.err && <div className="mt-2"><Galat teks={`Status Blu 3.0 tidak terbaca: ${v3.err}`} /></div>}
        {rk && (
          <div className="mt-2.5 grid grid-cols-2 gap-2 md:grid-cols-4">
            <Angka label="Klaim dinilai v3" nilai={idn(rk.klaim)} />
            <Angka label="Ditandai v3" nilai={idn(rk.ditandai)} sub={pct(rk.ditandai / Math.max(1, rk.klaim), 1)} />
            <Angka label="Klaim Berisiko (dibaca agen)" nilai={idn(rk.berisiko)} />
            <Angka label="Faskes" nilai={idn(rk.faskes)} />
          </div>
        )}
        {!rk && !v3.err && v3.data && <div className="mt-2"><Catatan>Paket data v3 belum ada (testing/blu3_data.py).</Catatan></div>}
        {!!t3.data?.ukuran?.length && (
          <ul className="mt-3 space-y-1.5">
            {t3.data.ukuran.map((u) => (
              <li key={u.lini} className="flex items-start gap-2 text-[11.5px]">
                <span className="mt-px flex h-5 min-w-[28px] shrink-0 items-center justify-center rounded bg-white/[.06] px-1 text-[11px] font-semibold tabular-nums text-white">{u.agen}</span>
                <span className="w-28 shrink-0 text-[#e5e8eb]">{LINI[u.lini]?.label ?? u.lini}</span>
                <span className="min-w-0 flex-1 leading-snug text-[#abb3bf]">{u.alasan}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
