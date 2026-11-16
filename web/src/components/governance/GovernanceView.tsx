"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Icon, type IconName } from "@/components/Icon";
import type { DemoGovernance, GovernanceOverview } from "@/lib/governance";

/* One Project's data protection as the path its data takes — discover, classify, protect, restrict, justify, retain,
   account — each step with what is in place, in plain words, and the application that manages it. Shared by the
   Governance Center (any Project) and the JKN demo's audit workspace (with its access matrix and a before / after). */

export const STEPS: { key: string; title: string; verb: string; icon: IconName; app: string; href: string; plain: string }[] = [
  { key: "discover", title: "Temukan", verb: "Data sensitif dipindai", icon: "search", app: "Sensitive Data Scanner", href: "/sensitive-data-scanner", plain: "Pemindai membaca isi dataset dan menemukan NIK, nomor kartu BPJS, nama, telepon." },
  { key: "classify", title: "Tandai", verb: "Diberi penanda akses", icon: "layers", app: "Markings", href: "/files", plain: "Dataset sensitif diberi penanda (marking). Hanya pemegang penanda yang bisa membukanya — dan penanda ikut ke data turunan." },
  { key: "protect", title: "Samarkan", verb: "Identitas dipseudonimkan", icon: "lock", app: "Cipher", href: "/cipher", plain: "Cipher mengganti identitas dengan pseudonim (enkripsi) atau hash, jadi analis bekerja tanpa tahu siapa orangnya." },
  { key: "restrict", title: "Batasi", verb: "Properti disembunyikan", icon: "eye", app: "Object Permissioning", href: "/object-permissioning", plain: "Kebijakan keamanan objek & properti menyembunyikan kolom tertentu bagi yang tidak berwenang — terlihat kosong." },
  { key: "justify", title: "Minta alasan", verb: "Alasan sebelum aksi sensitif", icon: "comment", app: "Checkpoints", href: "/checkpoints", plain: "Sebelum mengunduh, memutuskan, atau membuka identitas, pengguna wajib menulis tujuannya." },
  { key: "retain", title: "Simpan seperlunya", verb: "Retensi & penghapusan", icon: "clock", app: "Data Lifetime", href: "/data-lifetime", plain: "Data mentah dihapus otomatis pada tanggal retensinya, termasuk turunannya (mengikuti lineage)." },
  { key: "account", title: "Catat", verb: "Jejak audit", icon: "history", app: "Security auditing", href: "/security-auditing", plain: "Setiap akses, ekspor, keputusan, alasan dan dekripsi tercatat di log audit.3." },
];

const fmtDate = (s?: string | null) => (s ? new Date(s).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" }) : "—");
const fmtTime = (s?: string | null) => (s ? new Date(s).toLocaleString("id-ID", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const LICENSE: Record<string, [string, string]> = {
  admin: ["Admin", "kunci diberikan ke transform Python (mis. pseudonimisasi)"],
  data_manager: ["Data Manager", "enkripsi / hash seluruh kolom di Pipeline Builder & Contour"],
  operational: ["Operational", "membuka satu nilai di aplikasi, dengan alasan & batas"],
  legacy: ["Lama", "lisensi media lama"],
};
const ALGO: Record<string, string> = { AES_SIV: "AES-256-SIV · deterministik", AES_GCM_SIV: "AES-GCM-SIV", SHA256: "SHA-256 + pepper", SHA512: "SHA-512 + pepper", VISUAL: "obfuskasi visual" };
const JUST: Record<string, string> = { dropdown: "pilih tujuan", response: "tulis alasan", acknowledgment: "centang persetujuan", reauthentication: "masukkan ulang sandi" };

function Card({ id, title, icon, ok, app, href, children, caption }: { id: string; title: string; icon: IconName; ok: boolean; app: string; href: string; caption: string; children: ReactNode }) {
  return (
    <section id={`gov-${id}`} className="scroll-mt-4 rounded-xl border border-line bg-panel">
      <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <span className={`flex h-7 w-7 items-center justify-center rounded-lg ${ok ? "bg-ok/15 text-ok" : "bg-warn/15 text-warn"}`}>
          <Icon name={icon} className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold">{title}</h3>
          <p className="truncate text-[11px] text-muted">{caption}</p>
        </div>
        <Link href={href} className="ml-auto shrink-0 rounded-md border border-line-2 px-2 py-1 text-[11px] text-soft hover:border-ocean hover:text-white">
          Buka {app} →
        </Link>
      </header>
      <div className="p-4 text-xs">{children}</div>
    </section>
  );
}

function Chip({ children, color }: { children: ReactNode; color?: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px]" style={{ borderColor: color ? `${color}66` : undefined, color, background: color ? `${color}14` : undefined }}>
      {children}
    </span>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-md border border-dashed border-line-2 p-3 text-center text-muted">{children}</p>;
}

/** The seven steps as a path, with what each has and whether it is in place. */
export function ProtectionFlow({ data }: { data: GovernanceOverview }) {
  const p = Object.fromEntries(data.posture.map((x) => [x.key, x]));
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
      {STEPS.map((s, i) => {
        const st = p[s.key];
        return (
          <a key={s.key} href={`#gov-${s.key}`} className="group relative flex flex-col rounded-xl border border-line bg-panel p-3 transition hover:border-ocean">
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-ink text-[10px] font-semibold text-muted">{i + 1}</span>
              <Icon name={s.icon} className={`h-4 w-4 ${st?.ok ? "text-ok" : "text-warn"}`} />
              <span className={`ml-auto h-2 w-2 rounded-full ${st?.ok ? "bg-ok" : "bg-warn"}`} title={st?.ok ? "aktif" : "belum"} />
            </div>
            <div className="mt-2 text-[13px] font-semibold">{s.title}</div>
            <div className="text-[11px] text-soft">{st?.detail}</div>
            <p className="mt-1.5 text-[10.5px] leading-snug text-muted">{s.plain}</p>
            {!st?.ok && st?.todo && <p className="mt-1.5 rounded bg-warn/10 px-1.5 py-1 text-[10.5px] text-warn">{st.todo}</p>}
            <span className="mt-auto pt-2 text-[10.5px] text-ocean opacity-0 transition group-hover:opacity-100">lihat rincian ↓</span>
          </a>
        );
      })}
    </div>
  );
}

/** Each control in detail. */
export function ControlDetails({ data }: { data: GovernanceOverview }) {
  const ok = Object.fromEntries(data.posture.map((x) => [x.key, x.ok]));
  const S = Object.fromEntries(STEPS.map((s) => [s.key, s]));
  const maxCat = Math.max(1, ...Object.values(data.account.by_category));
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      <Card id="discover" title={`1 · ${S.discover.verb}`} icon="search" ok={ok.discover} app={S.discover.app} href={S.discover.href} caption="apa yang ditemukan pemindai di dataset Project">
        {data.discover.findings.length ? (
          <div className="space-y-2">
            {data.discover.findings.map((f) => (
              <div key={f.id} className="rounded-md bg-ink p-2.5">
                <Link href={`/datasets/${f.id}`} className="font-medium hover:text-ocean">{f.name.replace(/\.parquet$/, "")}</Link>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {f.conditions.map((c) => (
                    <Chip key={c.name} color="#f87171">
                      {c.name} · kolom <b className="font-mono">{c.columns.join(", ")}</b> · {c.count.toLocaleString("id-ID")} sel
                    </Chip>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty>Belum ada data sensitif yang ditemukan.</Empty>
        )}
        {data.discover.scans.map((s) => (
          <div key={s.id} className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
            <span className="text-soft">Pemindaian “{s.name}”</span>
            <span>{s.schedule === "daily" ? "harian" : s.schedule}</span>
            <span>{s.scanned} dataset dipindai · {s.matched} cocok</span>
            <span>terakhir {fmtTime(s.last_run)}</span>
            {s.actions.length > 0 && <span>tindakan otomatis: {s.actions.map((a) => a.name).join(", ")}</span>}
          </div>
        ))}
      </Card>

      <Card id="classify" title={`2 · ${S.classify.verb}`} icon="layers" ok={ok.classify} app={S.classify.app} href={S.classify.href} caption={`${data.classify.marked_items} dari ${data.classify.items} item Project bertanda`}>
        {data.classify.markings.length ? (
          <div className="space-y-2">
            {data.classify.markings.map((m) => (
              <div key={m.id} className="rounded-md bg-ink p-2.5">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: m.color }} />
                  <b>{m.name}</b>
                  <span className="ml-auto text-muted">{m.members} pemegang</span>
                </div>
                {m.description && <p className="mt-1 text-[11px] text-muted">{m.description}</p>}
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {m.direct.map((d) => (
                    <Link key={d.id} href={`/datasets/${d.id}`}><Chip color={m.color}>{d.name.replace(/\.parquet$/, "")} · langsung</Chip></Link>
                  ))}
                  {m.inherited.slice(0, 6).map((d) => (
                    <Link key={d.id} href={`/datasets/${d.id}`}><Chip>{d.name.replace(/\.parquet$/, "")} · diwarisi</Chip></Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty>Belum ada penanda pada item Project.</Empty>
        )}
      </Card>

      <Card id="protect" title={`3 · ${S.protect.verb}`} icon="lock" ok={ok.protect} app={S.protect.app} href={S.protect.href} caption="kanal Cipher (kunci) dan lisensi (siapa boleh memakai)">
        {data.protect.channels.length ? (
          <div className="space-y-2">
            {data.protect.channels.map((c) => (
              <div key={c.id} className="rounded-md bg-ink p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Icon name="lock" className="h-3.5 w-3.5 text-ocean" />
                  <b>{c.name}</b>
                  <Chip>{ALGO[c.algorithm] ?? c.algorithm}</Chip>
                </div>
                {c.description && <p className="mt-1 text-[11px] text-muted">{c.description}</p>}
                <ul className="mt-1.5 space-y-1">
                  {data.protect.licenses.filter((l) => l.channel === c.name).map((l) => (
                    <li key={l.id} className="flex flex-wrap items-center gap-1.5 text-[11px]">
                      <Chip color={l.kind === "operational" ? "#f59e0b" : l.kind === "admin" ? "#ef4444" : "#38bdf8"}>{LICENSE[l.kind]?.[0] ?? l.kind}</Chip>
                      <span className="text-soft">{l.name}</span>
                      <span className="text-muted">— {LICENSE[l.kind]?.[1]}{l.rate_limit ? ` · maks ${l.rate_limit.count}/${l.rate_limit.minutes} mnt` : ""} · {l.operations.join(", ")}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : (
          <Empty>Belum ada kanal Cipher di Project ini.</Empty>
        )}
      </Card>

      <Card id="restrict" title={`4 · ${S.restrict.verb}`} icon="eye" ok={ok.restrict} app={S.restrict.app} href={S.restrict.href} caption="tipe objek yang didukung dataset Project, dengan kebijakannya">
        <div className="space-y-1.5">
          {data.restrict.object_types.map((t) => (
            <div key={t.id} className="rounded-md bg-ink p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/ontology/${t.id}`} className="font-medium hover:text-ocean">{t.name}</Link>
                {!t.object_policy && !t.property_policies.length && <span className="text-[11px] text-muted">tanpa kebijakan — semua yang bisa membuka dataset melihat semua properti</span>}
                {t.row_level && <Chip color="#a78bfa">kebijakan baris</Chip>}
              </div>
              {t.property_policies.map((pp) => (
                <div key={pp.name} className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                  <Icon name="eye" className="h-3 w-3 text-warn" />
                  <span className="text-soft">{pp.name}:</span>
                  <span className="text-muted">{pp.properties.join(", ")}</span>
                  <span className="text-muted">hanya untuk</span>
                  {pp.markings.map((m) => <Chip key={m.id} color={m.color}>{m.name}</Chip>)}
                </div>
              ))}
            </div>
          ))}
          {!data.restrict.object_types.length && <Empty>Tidak ada tipe objek yang didukung dataset Project ini.</Empty>}
        </div>
      </Card>

      <Card id="justify" title={`5 · ${S.justify.verb}`} icon="comment" ok={ok.justify} app={S.justify.app} href={S.justify.href} caption={`${data.justify.records_30d} alasan tercatat 30 hari terakhir`}>
        <div className="space-y-1.5">
          {data.justify.configs.map((c) => (
            <div key={c.id} className="rounded-md bg-ink p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <b>{c.name}</b>
                <Chip>{c.scope === "project" ? "Project ini" : "seluruh organisasi"}</Chip>
                <Chip color="#38bdf8">{JUST[c.justification] ?? c.justification}</Chip>
                {!c.enabled && <Chip color="#94a3b8">nonaktif</Chip>}
              </div>
              <p className="mt-1 text-[11px] text-muted">Diminta saat: {c.types.join(", ")} · “{c.title}”</p>
              {c.options.length > 0 && <p className="mt-0.5 text-[11px] text-muted">Pilihan: {c.options.join(" · ")}</p>}
            </div>
          ))}
          {!data.justify.configs.length && <Empty>Belum ada checkpoint.</Empty>}
          {data.justify.recent.length > 0 && (
            <div className="pt-1">
              <div className="mb-1 text-[11px] font-medium text-soft">Alasan terakhir</div>
              {data.justify.recent.map((r, i) => (
                <div key={i} className="flex gap-2 border-t border-line/50 py-1 text-[11px]">
                  <span className="w-28 shrink-0 text-muted">{fmtTime(r.at)}</span>
                  <span className="w-24 shrink-0 truncate">{r.user}</span>
                  <span className="text-muted">{r.type}:</span>
                  <span className="min-w-0 flex-1 truncate text-soft">{r.justification}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      <Card id="retain" title={`6 · ${S.retain.verb}`} icon="clock" ok={ok.retain} app={S.retain.app} href={S.retain.href} caption="kapan data dihapus otomatis">
        <div className="space-y-1.5">
          {data.retain.policies.map((p) => (
            <div key={p.id} className="flex items-start gap-3 rounded-md bg-ink p-2.5">
              <div className="rounded-md border border-line-2 px-2 py-1 text-center">
                <div className="text-[10px] text-muted">dihapus</div>
                <div className="text-[12px] font-semibold tabular-nums">{fmtDate(p.deletion_date)}</div>
              </div>
              <div className="min-w-0">
                <b>{p.name}</b>
                <p className="text-[11px] text-muted">{p.description}</p>
                <p className="text-[11px] text-muted">{p.datasets.length} dataset akar · turunannya ikut (lineage)</p>
              </div>
            </div>
          ))}
          {!data.retain.policies.length && <Empty>Belum ada kebijakan retensi.</Empty>}
        </div>
      </Card>

      <Card id="account" title={`7 · ${S.account.verb}`} icon="history" ok={ok.account} app={S.account.app} href={S.account.href} caption={`${data.account.events} peristiwa pada item Project, ${data.account.days} hari terakhir`}>
        <div className="grid gap-3 md:grid-cols-[200px_1fr]">
          <div className="space-y-1">
            {Object.entries(data.account.by_category).slice(0, 8).map(([k, v]) => (
              <div key={k} className="grid grid-cols-[1fr_auto] items-center gap-2 text-[11px]">
                <span className="truncate text-soft" title={k}>{k}</span>
                <span className="tabular-nums text-muted">{v}</span>
                <span className="col-span-2 h-1 rounded bg-line/40"><span className="block h-1 rounded bg-ocean" style={{ width: `${(v / maxCat) * 100}%` }} /></span>
              </div>
            ))}
          </div>
          <div className="max-h-56 overflow-y-auto">
            {data.account.latest.map((e, i) => (
              <div key={i} className="flex gap-2 border-b border-line/50 py-1 text-[11px] last:border-0">
                <span className="w-28 shrink-0 text-muted">{fmtTime(e.time)}</span>
                <span className="w-24 shrink-0 truncate">{e.user ?? "sistem"}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-soft" title={e.name}>{e.name}</span>
                <span className="text-muted">{e.product}</span>
              </div>
            ))}
            {!data.account.latest.length && <Empty>Belum ada peristiwa.</Empty>}
          </div>
        </div>
      </Card>
    </div>
  );
}

/** "Who can see what": personas × the demo's sensitive data, computed from the real markings and policies. */
export function AccessMatrix({ data }: { data: DemoGovernance }) {
  if (!data.matrix) return null;
  const { personas, rows } = data.matrix;
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-panel">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-line text-left">
            <th className="px-4 py-3 align-bottom font-medium text-muted">Data</th>
            {personas.map((p) => (
              <th key={p.id} className="px-3 py-3 text-center align-bottom">
                <div className="text-[12px] font-semibold">{p.name}</div>
                <div className="text-[10.5px] font-normal text-muted">{p.role}</div>
                <div className="mt-1 flex flex-wrap justify-center gap-1">
                  {p.markings.length ? p.markings.map((m) => <Chip key={m} color={m.startsWith("PHI") ? "#dc2626" : "#ea580c"}>{m.replace(" JKN (demo)", "")}</Chip>) : <Chip>tanpa penanda</Chip>}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-b border-line/50 last:border-0">
              <td className="px-4 py-2.5">
                <div className="font-medium">{r.label}</div>
                <div className="text-[11px] text-muted">{r.why}</div>
                {r.needs.length > 0 && <div className="mt-1 text-[10.5px] text-muted">perlu: {r.needs.join(" + ")}{r.checkpoint ? " · dengan alasan" : ""}</div>}
              </td>
              {personas.map((p) => (
                <td key={p.id} className="px-3 py-2.5 text-center">
                  {r.access[p.id] ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-ok/15 px-2 py-0.5 text-[11px] text-ok">✓ {r.kind === "cipher" ? "bisa, dengan alasan" : "terlihat"}</span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-line/40 px-2 py-0.5 text-[11px] text-muted">
                      <Icon name="lock" className="h-3 w-3" /> {r.kind === "property" ? "kosong" : "tertutup"}
                    </span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-line px-4 py-2 text-[11px] text-muted">
        Dihitung dari penanda dan kebijakan yang berlaku sekarang (bukan gambar statis): akses ke dataset mengikuti penanda efektifnya, properti mengikuti uji kebijakan
        keamanan objek untuk tiap peran. Akses diminta lewat <Link href="/approvals" className="text-ocean hover:underline">Approvals</Link> dan ditinjau pengelola penanda.
      </p>
    </div>
  );
}

/** The same members before and after pseudonymisation. */
export function PseudonymSample({ data }: { data: DemoGovernance }) {
  if (!data.sample?.length) return null;
  const short = (s: string) => (s.length > 28 ? `${s.slice(0, 14)}…${s.slice(-10)}` : s);
  return (
    <div className="grid gap-3 lg:grid-cols-[1fr_auto_1fr]">
      <div className="rounded-xl border border-bad/30 bg-bad/5 p-3">
        <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold text-red-300"><Icon name="lock" className="h-3.5 w-3.5" /> Mentah — hanya pemegang PHI</div>
        <table className="w-full text-[11px]">
          <thead className="text-left text-muted"><tr><th className="pb-1">SEP</th><th>Nama</th><th>No. kartu</th><th>NIK</th></tr></thead>
          <tbody>
            {data.sample.map((s) => (
              <tr key={s.no_sep} className="border-t border-line/40">
                <td className="py-1 font-mono">{s.no_sep.slice(-6)}</td>
                <td>{s.asli?.nama ?? "🔒"}</td>
                <td className="font-mono">{s.asli?.no_kartu ?? "🔒"}</td>
                <td className="font-mono">{s.asli?.nik ?? "🔒"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col items-center justify-center gap-1 px-2 text-center text-[10.5px] text-muted">
        <Icon name="lock" className="h-5 w-5 text-ocean" />
        <span>Cipher</span>
        <span>kartu → AES-SIV</span>
        <span>NIK → SHA-256</span>
        <span>nama, HP, tgl lahir → dibuang</span>
        <span className="text-xl text-ocean">→</span>
      </div>
      <div className="rounded-xl border border-ok/30 bg-ok/5 p-3">
        <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold text-emerald-300"><Icon name="check" className="h-3.5 w-3.5" /> Pseudonim — untuk analis</div>
        <table className="w-full text-[11px]">
          <thead className="text-left text-muted"><tr><th className="pb-1">SEP</th><th>ID peserta (pseudonim)</th><th>NIK (hash)</th><th>Umur</th></tr></thead>
          <tbody>
            {data.sample.map((s) => (
              <tr key={s.no_sep} className="border-t border-line/40">
                <td className="py-1 font-mono">{s.no_sep.slice(-6)}</td>
                <td className="font-mono text-[10px]" title={s.pseudonim}>{short(s.pseudonim.replace(/^CIPHER::[^:]+::/, "").replace(/::CIPHER$/, ""))}</td>
                <td className="font-mono text-[10px]" title={s.nik_hash}>{s.nik_hash.slice(0, 12)}…</td>
                <td>{s.kelompok_umur}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-[10.5px] text-muted">Peserta yang sama selalu mendapat pseudonim yang sama, jadi jumlah kunjungan per peserta tetap bisa dihitung tanpa tahu siapa orangnya.</p>
      </div>
    </div>
  );
}

export function PostureScore({ data }: { data: GovernanceOverview }) {
  const n = data.posture.filter((p) => p.ok).length;
  const pct = n / data.posture.length;
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <div className="flex items-center gap-3">
      <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90">
        <circle cx="32" cy="32" r={r} fill="none" stroke="var(--color-line)" strokeWidth="6" />
        <circle cx="32" cy="32" r={r} fill="none" stroke={pct === 1 ? "#22c55e" : pct >= 0.6 ? "#f59e0b" : "#ef4444"} strokeWidth="6" strokeDasharray={`${c * pct} ${c}`} strokeLinecap="round" />
      </svg>
      <div>
        <div className="text-xl font-semibold tabular-nums">{n}/{data.posture.length}</div>
        <div className="text-[11px] text-muted">kontrol aktif</div>
      </div>
    </div>
  );
}
