"use client";
import { useEffect, useState } from "react";
import { Widget } from "@/components/demo/audit/Workspace";
import { fraudApi } from "./api";
import { PAGE_SIZE, rp, type AnyRec, type Pagination } from "./types";
import { DataTable, Pager, ScoreBar, StateMsg, ToneBadge } from "./ui";

function usePaged(fetcher: (limit: number, offset: number) => Promise<AnyRec>, key: string) {
  const [rows, setRows] = useState<AnyRec[] | null>(null);
  const [pg, setPg] = useState<Pagination | null>(null);
  const [off, setOff] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setRows(null);
    fetcher(PAGE_SIZE, off).then((x) => { setRows(x[key]); setPg(x.pagination); }, (e: Error) => setErr(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [off]);
  return { rows, pg, off, setOff, err };
}

export function BillingPanel({ onMsg }: { onMsg: (m: string) => void }) {
  const { rows, pg, off, setOff, err } = usePaged(fraudApi.billing, "checks");
  const [judged, setJudged] = useState<Record<string, string>>({});
  const judge = async (sep: string, verdict: string) => {
    try {
      const r = await fraudApi.feedback(sep, verdict);
      setJudged((j) => ({ ...j, [sep]: verdict }));
      onMsg(`Feedback ${sep}: ${verdict === "fraud" ? "terkonfirmasi fraud" : "sah (false positive)"}. FP rate aktual: ${r.metrics.false_positive_rate_aktual ?? "—"}.`);
    } catch (e) { onMsg((e as Error).message); }
  };
  if (err) return <StateMsg kind="error" text={err} />;
  return (
    <Widget title="Validasi billing sebelum bayar" caption="Klaim × rekam medis × diagnosis × prosedur × tarif kontrak × aturan manfaat — beri verdict untuk melatih FP rate" bodyClass="p-0">
      {!rows ? <div className="p-3"><StateMsg kind="loading" text="Memuat hasil validasi…" /></div> : (
        <DataTable head={["SEP", "Faskes", "Temuan", "Keputusan", "Nilai berisiko", "Verdict investigator"]}>
          {rows.map((c) => (
            <tr key={c.no_sep} className="border-b border-line/60 last:border-0 hover:bg-panel-2/60">
              <td className="px-3 py-2"><span className="font-mono">{c.no_sep}</span><div className="mt-0.5 text-muted">{c.diagnosa}/{c.prosedur} · {c.tanggal} · {c.status_bayar}</div></td>
              <td className="px-3 py-2 text-soft">{c.nama_faskes}</td>
              <td className="px-3 py-2">{c.issues.map((i: AnyRec) => <div key={i.jenis} className="mb-1 last:mb-0"><b>{i.label}</b><div className="text-muted">{i.detail}</div></div>)}</td>
              <td className="px-3 py-2"><ToneBadge text={c.verdict} /></td>
              <td className="px-3 py-2 text-right tabular-nums">{rp(c.nilai_risiko)}</td>
              <td className="px-3 py-2">
                {judged[c.no_sep] ? <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${judged[c.no_sep] === "fraud" ? "bg-bad/15 text-bad" : "bg-ok/15 text-ok"}`}>{judged[c.no_sep] === "fraud" ? "Fraud ✓" : "Sah ✓"}</span> : (
                  <span className="flex gap-1">
                    <button type="button" onClick={() => judge(c.no_sep, "fraud")} className="rounded bg-bad/15 px-2 py-1 text-[11px] font-semibold text-bad hover:bg-bad/25">Fraud</button>
                    <button type="button" onClick={() => judge(c.no_sep, "legit")} className="rounded bg-ok/15 px-2 py-1 text-[11px] font-semibold text-ok hover:bg-ok/25">Sah</button>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </DataTable>
      )}
      {pg && <Pager total={pg.total} limit={pg.limit} offset={off} onPage={setOff} />}
    </Widget>
  );
}

export function RiskPanel() {
  const { rows, pg, off, setOff, err } = usePaged(fraudApi.scores, "scores");
  if (err) return <StateMsg kind="error" text={err} />;
  return (
    <Widget title="Skor risiko explainable" caption="Setiap skor dipecah per faktor dengan peer benchmark — bukan skor hitam" bodyClass="p-0">
      {!rows ? <div className="p-3"><StateMsg kind="loading" text="Memuat skor risiko…" /></div> : (
        <DataTable head={["SEP", "Skor", "Faktor penjelas", "Peer benchmark"]}>
          {rows.map((s) => (
            <tr key={s.no_sep} className="border-b border-line/60 last:border-0 hover:bg-panel-2/60">
              <td className="px-3 py-2 font-mono">{s.no_sep}</td>
              <td className="px-3 py-2"><span className="flex items-center gap-2"><ScoreBar value={s.skor} /><ToneBadge text={s.tier} /></span></td>
              <td className="px-3 py-2">{s.factors.length ? s.factors.map((f: AnyRec) => <div key={f.faktor} className="mb-1 last:mb-0"><b>{f.faktor} +{f.kontribusi}</b><div className="text-muted">{f.penjelasan}</div></div>) : <span className="text-muted">Tidak ada faktor — profil normal terhadap peer.</span>}</td>
              <td className="px-3 py-2 text-muted">{s.peer.spesialisasi} / {s.peer.prosedur}<br />{s.peer.peer_n} peer · rata-rata {s.peer.peer_mean ? rp(s.peer.peer_mean) : "—"}</td>
            </tr>
          ))}
        </DataTable>
      )}
      {pg && <Pager total={pg.total} limit={pg.limit} offset={off} onPage={setOff} />}
    </Widget>
  );
}
