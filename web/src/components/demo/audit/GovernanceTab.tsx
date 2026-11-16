"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { AccessMatrix, ControlDetails, PostureScore, ProtectionFlow, PseudonymSample } from "@/components/governance/GovernanceView";
import { governance, type DemoGovernance } from "@/lib/governance";
import { AccessPerAccount } from "./AccessPerAccount";
import { API_URL } from "@/lib/api";

/* The audit workspace's "Keamanan & tata kelola" page: how the identity of JKN members and the investigation files are
   protected, told as one member's NIK going through the platform, with the live controls behind each step. */

export function GovernanceTab() {
  const [d, setD] = useState<DemoGovernance | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    governance.demo().then(setD, (e: Error) => setErr(e.message));
  }, []);

  // the audit queue export goes through fetch, so the checkpoint asks for its purpose first
  const exportQueue = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await fetch(`${API_URL}/api/demo/jkn/workbench/export.csv`, { credentials: "include" });
      if (!r.ok) throw new Error(r.status === 428 ? "Ekspor dibatalkan: tujuan tidak diisi." : `Ekspor gagal (${r.status})`);
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = "antrean-audit-faskes-jkn.csv";
      a.click();
      URL.revokeObjectURL(url);
      setNote("Antrean diunduh. Tujuan yang Anda pilih tercatat di log audit — lihat bagian 5 dan 7 di bawah.");
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (err) return <p className="rounded border border-bad/40 bg-bad/5 p-2 text-xs text-bad">{err}</p>;
  if (!d) return <p className="py-10 text-center text-xs text-muted">Memuat kontrol keamanan…</p>;
  if (!d.ready)
    return (
      <p className="rounded-lg border border-dashed border-line-2 p-6 text-center text-sm text-muted">
        Lapisan keamanan demo belum dibangun. Jalankan langkah “governance” pada build demo JKN.
      </p>
    );
  const it = d.demo.items;
  const story: [string, string][] = [
    ["Masuk", "Ekstrak kepesertaan per SEP mendarat di raw/ — NIK, nomor kartu, nama, tanggal lahir, HP."],
    ["Ditemukan", "Pemindai mengenali NIK, nomor BPJS dan nama, lalu memberi penanda PHI dan membuka isu."],
    ["Disamarkan", "Transform Cipher membuat pseudonim; penanda PHI tidak diturunkan ke hasilnya."],
    ["Dianalisis", "Analis, model ML dan dasbor memakai pseudonim — tanpa tahu siapa orangnya."],
    ["Dibuka bila sah", "Petugas berpenanda PHI dapat membuka satu identitas, dengan alasan, maks 20/jam."],
    ["Dihapus", "Ekstrak mentah terhapus otomatis pada tanggal retensinya."],
  ];
  const tries: { label: string; hint: string; href?: string; onClick?: () => void; icon: "download" | "lock" | "database" | "code" | "history" | "comment" }[] = [
    { label: "Ekspor antrean audit", hint: "checkpoint akan menanyakan tujuannya", onClick: exportQueue, icon: "download" },
    { label: "Buka data mentah", hint: "perlu penanda PHI", href: it.raw ? `/datasets/${it.raw}` : undefined, icon: "lock" },
    { label: "Buka data pseudonim", hint: "untuk semua analis", href: it.pseudo ? `/datasets/${it.pseudo}` : undefined, icon: "database" },
    { label: "Lihat transform Cipher", hint: "Python · stop_propagating PHI", href: it.repo ? `/code-repositories/${it.repo}` : undefined, icon: "code" },
    { label: "Buka satu identitas", hint: "Cipher → lisensi Operational, dengan alasan", href: "/cipher", icon: "lock" },
    { label: "Ambil keputusan", hint: "Eskalasi/Tutup audit meminta dasar keputusan", href: "/demo-jkn/audit?tab=antrian", icon: "comment" },
    { label: "Lihat log audit", hint: "semua akses & alasan", href: "/security-auditing", icon: "history" },
  ];
  return (
    <div className="space-y-4">
      <section className="flex flex-wrap items-center gap-4 rounded-xl border border-line bg-panel p-4">
        <PostureScore data={d} />
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold">Identitas peserta & berkas investigasi terlindungi dari hulu ke hilir</h3>
          <p className="mt-1 max-w-4xl text-xs leading-relaxed text-muted">
            Data klaim JKN memuat identitas peserta dan dugaan kecurangan yang belum final. Halaman ini menunjukkan perlindungannya dengan kontrol platform yang
            sebenarnya — pemindai data sensitif, penanda akses, Cipher, kebijakan objek, checkpoint, retensi dan log audit — semuanya hidup, bukan gambar.
          </p>
        </div>
        <Link href={`/security-governance/center?project=${d.project.id}`} className="rounded-md border border-line-2 px-3 py-1.5 text-xs text-soft hover:border-ocean hover:text-white">
          Buka di Governance Center →
        </Link>
      </section>

      <section>
        <h3 className="mb-2 text-[13px] font-semibold">Perjalanan satu NIK</h3>
        <ol className="grid gap-2 sm:grid-cols-3 xl:grid-cols-6">
          {story.map(([h, t], i) => (
            <li key={h} className="relative rounded-lg border border-line bg-panel p-3">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-ocean">{i + 1} · {h}</span>
              <p className="mt-1 text-[11.5px] leading-snug text-soft">{t}</p>
              {i < story.length - 1 && <span className="absolute -right-2 top-1/2 hidden -translate-y-1/2 text-muted xl:block">›</span>}
            </li>
          ))}
        </ol>
      </section>

      <section>
        <h3 className="mb-2 text-[13px] font-semibold">Tujuh kontrol, dalam urutan perjalanan data</h3>
        <ProtectionFlow data={d} />
      </section>

      <section>
        <h3 className="mb-1 text-[13px] font-semibold">Siapa bisa melihat apa</h3>
        <p className="mb-2 text-[11px] text-muted">Empat peran contoh, masing-masing dengan penanda yang berbeda.</p>
        <AccessMatrix data={d} />
      </section>

      <section>
        <h3 className="mb-1 text-[13px] font-semibold">Akses per akun — akun demo nyata, aturan yang hidup</h3>
        <p className="mb-2 text-[11px] text-muted">
          Tujuh akun demo, satu pipeline yang memberi tiap baris kantor cabang pemiliknya, empat restricted view dan kebijakan objek. Setiap sel dihitung dari aturan
          yang berlaku — sama dengan warna Data Lineage bila dilihat sebagai akun itu: biru dapat melihat data, merah tidak.
        </p>
        <AccessPerAccount />
      </section>

      <section>
        <h3 className="mb-2 text-[13px] font-semibold">Sebelum dan sesudah pseudonimisasi</h3>
        <PseudonymSample data={d} />
      </section>

      <section className="rounded-xl border border-line bg-panel p-4">
        <h3 className="text-[13px] font-semibold">Coba sendiri</h3>
        <p className="mb-3 text-[11px] text-muted">Setiap tombol membuka kontrol yang sebenarnya; yang sensitif akan meminta alasan atau menolak bila Anda tidak berwenang.</p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
          {tries.map((t) => {
            const inner = (
              <>
                <Icon name={t.icon} className="h-4 w-4 text-ocean" />
                <span className="text-xs font-medium">{t.label}</span>
                <span className="text-[10.5px] text-muted">{t.hint}</span>
              </>
            );
            const cls = "flex flex-col items-start gap-1 rounded-lg border border-line bg-ink p-3 text-left transition hover:border-ocean disabled:opacity-50";
            return t.onClick ? (
              <button key={t.label} type="button" onClick={t.onClick} disabled={busy} className={cls}>{inner}</button>
            ) : t.href ? (
              <Link key={t.label} href={t.href} className={cls}>{inner}</Link>
            ) : null;
          })}
        </div>
        {note && <p className="mt-2 rounded border border-line bg-ink p-2 text-xs text-soft">{note}</p>}
      </section>

      <section>
        <h3 className="mb-2 text-[13px] font-semibold">Rincian tiap kontrol</h3>
        <ControlDetails data={d} />
      </section>
    </div>
  );
}
