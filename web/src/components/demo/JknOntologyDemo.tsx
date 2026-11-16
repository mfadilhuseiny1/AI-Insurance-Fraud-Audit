"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { buttonClass } from "@/components/pipeline/Modal";
import { API_URL } from "@/lib/api";

type Status = {
  faskes_type_id: string | null;
  klaim_type_id: string | null;
  objects: { faskes: number; klaim: number };
  scenarios: { id: string; name: string }[];
  merge_action_id: string | null;
  secured: boolean;
  materialized_dataset_id?: string | null;
};

async function call(method = "GET"): Promise<Status> {
  const res = await fetch(`${API_URL}/api/demo/jkn/ontology`, { method, cache: "no-store", credentials: "include" });
  if (!res.ok) throw new Error((await res.json().catch(() => ({ detail: res.statusText }))).detail);
  return res.json();
}

/** The JKN facility risk demo on the Ontology (api/demo_jkn_ontology.py): object types, search, scenarios, security. */
export function JknOntologyDemo() {
  const [s, setS] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    call().then(setS, (e: Error) => setErr(e.message));
  }, []);
  const kl = s?.klaim_type_id;
  return (
    <section className="mb-5 rounded-xl border border-line bg-panel p-4">
      <div className="flex items-center gap-2">
        <Icon name="cube" className="h-4 w-4 text-ocean" />
        <h2 className="font-semibold">Demo di Nexus</h2>
        <span className="text-xs text-muted">
          {kl ? `${s?.objects.faskes} faskes · ${s?.objects.klaim} klaim · ${s?.scenarios.length} skenario` : "belum dibuat"}
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            call("POST")
              .then(setS, (e: Error) => setErr(e.message))
              .finally(() => setBusy(false));
          }}
          className={`${buttonClass.secondary} ml-auto`}
        >
          <Icon name="play" className="h-3.5 w-3.5" /> {kl ? "Lengkapi demo" : "Buat demo Nexus"}
        </button>
      </div>
      <p className="mt-1 text-xs text-muted">
        Object type Faskes JKN (demo) dan Klaim JKN (demo) dari data fiktif yang sama, dengan kategori risiko kasus tertanam. Tidak ada yang dihapus: demo tetap di aplikasi.
      </p>
      {err && <p className="mt-2 text-xs text-bad">{err}</p>}
      {kl && (
        <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <Link href={`/ontology/${kl}`} className="rounded-lg border border-line p-3 hover:bg-panel-2">
            <div className="font-medium text-ocean">Nexus Manager</div>
            <div className="text-muted">Klaim JKN (demo): properti, aksi verifikasi, tab Security</div>
          </Link>
          <Link href="/ontology/search" className="rounded-lg border border-line p-3 hover:bg-panel-2">
            <div className="font-medium text-ocean">Nexus Search</div>
            <div className="text-muted">Regex Kode INA-CBG .*-(II|III), derived property klaim berisiko per faskes</div>
          </Link>
          <Link href="/ontology/scenarios" className="rounded-lg border border-line p-3 hover:bg-panel-2">
            <div className="font-medium text-ocean">Nexus Scenarios</div>
            <div className="text-muted">{s?.scenarios.map((x) => x.name.replace("Demo: ", "")).join(" · ") || "—"}</div>
          </Link>
          <Link href={`/object-explorer?type=${kl}`} className="rounded-lg border border-line p-3 hover:bg-panel-2">
            <div className="font-medium text-ocean">Object Explorer</div>
            <div className="text-muted">{s?.secured ? "Klaim investigasi dan data peserta dilindungi kebijakan keamanan" : "Telusuri klaim"}</div>
          </Link>
          <Link href="/object-edits" className="rounded-lg border border-line p-3 hover:bg-panel-2">
            <div className="font-medium text-ocean">Object Edits</div>
            <div className="text-muted">Riwayat edit verifikasi dan dataset materialisasi Klaim JKN (demo)</div>
          </Link>
          <Link href="/ontology/semantic-search" className="rounded-lg border border-line p-3 hover:bg-panel-2">
            <div className="font-medium text-ocean">Semantic Search</div>
            <div className="text-muted">Cari klaim dari makna resume medis, mis. &quot;pasien sesak napas dirawat lama&quot;</div>
          </Link>
          <Link href="/vertex" className="rounded-lg border border-line p-3 hover:bg-panel-2">
            <div className="font-medium text-ocean">Vertex</div>
            <div className="text-muted">Graf klaim berisiko RSUD Contoh + peringatan; template investigasi faskes</div>
          </Link>
          <Link href="/machinery" className="rounded-lg border border-line p-3 hover:bg-panel-2">
            <div className="font-medium text-ocean">Device and Machinery</div>
            <div className="text-muted">Proses verifikasi klaim: log e-Klaim, process mining (loop &quot;perlu konfirmasi&quot;), durasi dan path</div>
          </Link>
          <Link href="/foundry-rules" className="rounded-lg border border-line p-3 hover:bg-panel-2">
            <div className="font-medium text-ocean">Foundry Rules</div>
            <div className="text-muted">Aturan skrining (LOS, tarif, readmisi, pola faskes) → Temuan Aturan JKN (demo); 1 usulan menunggu review</div>
          </Link>
          <Link href="/dynamic-scheduling" className="rounded-lg border border-line p-3 hover:bg-panel-2">
            <div className="font-medium text-ocean">Dynamic Scheduling</div>
            <div className="text-muted">Jadwal audit klaim berisiko ke verifikator: bentrok, jam kerja, auto-assign</div>
          </Link>
          <Link href="/object-views" className="rounded-lg border border-line p-3 hover:bg-panel-2">
            <div className="font-medium text-ocean">Object Views</div>
            <div className="text-muted">Tampilan klaim terkonfigurasi (2 versi), tab Detail risiko bersyarat, komentar</div>
          </Link>
          <Link href="/object-monitors" className="rounded-lg border border-line p-3 hover:bg-panel-2">
            <div className="font-medium text-ocean">Object Monitors</div>
            <div className="text-muted">Klaim baru bertarif tinggi (realtime) dan total klaim ditunda di atas Rp 40 juta</div>
          </Link>
          <Link href="/vulcan" className="rounded-lg border border-line p-3 hover:bg-panel-2">
            <div className="font-medium text-ocean">Vulcan</div>
            <div className="text-muted">Model 3D ruang rawat kelas III: anotasi tempat tidur yang ditagih kelas I</div>
          </Link>
          <Link href="/ontology-indexing" className="rounded-lg border border-line p-3 hover:bg-panel-2">
            <div className="font-medium text-ocean">Nexus Indexing</div>
            <div className="text-muted">Tarif INA-CBG (demo) dari dataset Files: run pipeline changelog → hydration</div>
          </Link>
          <Link href="/ontology/design?tab=drills" className="rounded-lg border border-line p-3 hover:bg-panel-2">
            <div className="font-medium text-ocean">Nexus design</div>
            <div className="text-muted">Drill validasi klaim JKN: team race dengan rekam jejak di Object Explorer, riwayat design review</div>
          </Link>
        </div>
      )}
    </section>
  );
}
