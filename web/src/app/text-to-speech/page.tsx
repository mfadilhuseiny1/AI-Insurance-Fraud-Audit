"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Icon } from "@/components/Icon";
import { AppHeader, Card, ErrorBox, Field } from "@/components/ontology/parts";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { tts, type TtsEstimate, type TtsJob, type TtsStatus, type TtsVoice } from "@/lib/tts";

const DRAFT_KEY = "bluesandai.text-to-speech.draft";
const STARTER = `# Text to Speech

Tempel atau unggah teks (boleh **markdown**) di sini, pilih suara di panel kanan, lalu tekan *Buat audio*.

- Judul, daftar dan tabel dibacakan sebagai kalimat.
- Blok kode, gambar dan alamat tautan dilewati.
`;
const STYLES = [
  { label: "Natural", value: "" },
  { label: "Tenang", value: "Read aloud in a calm, clear and warm tone" },
  { label: "Berita", value: "Read like a professional news anchor" },
  { label: "Antusias", value: "Read aloud with energy and enthusiasm" },
  { label: "Pelan", value: "Read slowly and clearly, with short pauses between sentences" },
];

export default function MarkdownToSpeechPage() {
  const [status, setStatus] = useState<TtsStatus | null>(null);
  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const [markdown, setMarkdown] = useState(STARTER);
  const [title, setTitle] = useState("");
  const [voice, setVoice] = useState("marin");
  const [model, setModel] = useState("");
  const [style, setStyle] = useState("");
  const [gender, setGender] = useState<"all" | "female" | "male">("all");
  const [view, setView] = useState<"markdown" | "spoken">("markdown");
  const [spoken, setSpoken] = useState<{ text: string; characters: number; chunks: number; estimate: TtsEstimate | Record<string, never> } | null>(null);
  const [jobs, setJobs] = useState<TtsJob[]>([]);
  const [audio, setAudio] = useState<Record<string, string>>({});
  const [sampling, setSampling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  const fetched = useRef(new Set<string>());

  useEffect(() => {
    // the draft is restored after mount, so the server render and the first client render match
    Promise.resolve().then(() => {
      try {
        const draft = JSON.parse(window.localStorage.getItem(DRAFT_KEY) ?? "null");
        if (draft?.markdown) {
          setMarkdown(draft.markdown);
          setTitle(draft.title ?? "");
        }
      } catch {}
    });
    tts.status().then((s) => { setStatus(s); setModel(s.default ?? s.models[0] ?? ""); }).catch((e) => setError(e.message));
    tts.jobs().then(setJobs).catch(() => {});
  }, []);

  // each model has its own voices; keep the chosen one when the new model has it
  useEffect(() => {
    if (!model) return;
    tts.voices(model).then((vs) => {
      setVoices(vs);
      setVoice((v) => (vs.some((x) => x.name === v) ? v : vs[0]?.name ?? v));
    }).catch((e) => setError(e.message));
  }, [model]);

  useEffect(() => {
    const t = setTimeout(() => { try { window.localStorage.setItem(DRAFT_KEY, JSON.stringify({ markdown, title })); } catch {} }, 400);
    return () => clearTimeout(t);
  }, [markdown, title]);

  // the spoken text, its chunks and the price before reading
  useEffect(() => {
    if (!model) return;
    const t = setTimeout(() => tts.prepare(markdown, model).then(setSpoken).catch((e) => setError(e.message)), 400);
    return () => clearTimeout(t);
  }, [markdown, model]);

  const running = jobs.some((j) => j.status === "running");
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => tts.jobs().then(setJobs).catch(() => {}), 1500);
    return () => clearInterval(t);
  }, [running]);

  useEffect(() => {
    for (const job of jobs) {
      if (job.status === "completed" && !fetched.current.has(job.id)) {
        fetched.current.add(job.id);
        tts.audio(job.id).then((url) => setAudio((a) => ({ ...a, [job.id]: url }))).catch((e) => setError(e.message));
      }
    }
  }, [jobs]);

  const shown = useMemo(() => voices.filter((v) => gender === "all" || v.gender === gender), [voices, gender]);

  const loadFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setMarkdown(await file.text());
    setTitle(file.name.replace(/\.(md|markdown|txt)$/i, ""));
  };

  const playSample = async (name: string) => {
    setError(null);
    setSampling(name);
    try {
      const url = await tts.sample(name, model);
      player.current?.pause();
      player.current = new Audio(url);
      await player.current.play();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSampling(null);
    }
  };

  const generate = async () => {
    setError(null);
    try {
      const job = await tts.create({ markdown, voice, model, style, title: title || firstHeading(markdown) });
      setJobs((list) => [job, ...list]);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const retry = async (id: string) => {
    setError(null);
    try {
      const job = await tts.retry(id);
      setJobs((list) => list.map((j) => (j.id === id ? job : j)));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const cancel = async (id: string) => {
    const job = await tts.cancel(id);
    setJobs((list) => list.map((j) => (j.id === id ? job : j)));
  };

  return (
    <div className="foundry-light flex flex-1 flex-col overflow-hidden">
      <AppHeader app="Text to Speech" icon="play" href="/text-to-speech">
        <span className="text-xs text-muted">Bacakan teks atau markdown dengan suara OpenAI</span>
        <span title={status?.spend ? `Biaya audio OpenAI bulan ${status.spend.month}: ${usd(status.spend.usd)}${status.spend.cap_usd != null ? ` dari batas ${usd(status.spend.cap_usd)} (BLUESANDAI_OPENAI_AUDIO_MONTHLY_USD)` : " (tanpa batas)"}` : undefined}
          className={`ml-auto rounded-full px-2 py-1 text-[10px] ${status?.configured ? "bg-ok/15 text-ok" : "bg-warn/15 text-warn"}`}>
          {status ? (status.configured ? `OpenAI terhubung${status.spend ? ` · bulan ini ${usd(status.spend.usd)}${status.spend.cap_usd != null ? ` / ${usd(status.spend.cap_usd)}` : ""}` : ""}` : "API key belum diatur") : "Memeriksa…"}
        </span>
      </AppHeader>

      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-5">
          {status && !status.configured && <ErrorBox message={status.error ?? "Isi OPENAI_API_KEY di .env.local lalu restart API."} />}
          <ErrorBox message={error} />
          <div className="flex flex-wrap items-center gap-2">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Judul (opsional)" className={`${inputClass} max-w-sm`} />
            <input ref={fileInput} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" onChange={loadFile} className="hidden" />
            <button type="button" onClick={() => fileInput.current?.click()} className={buttonClass.secondary}><Icon name="upload" /> Unggah file</button>
            <button type="button" onClick={() => { setMarkdown(""); setTitle(""); }} className={buttonClass.ghost}><Icon name="trash" /> Kosongkan</button>
            <div className="ml-auto flex rounded-md border border-line-2 p-0.5 text-xs">
              {(["markdown", "spoken"] as const).map((v) => (
                <button key={v} type="button" onClick={() => setView(v)} className={`rounded px-2.5 py-1 ${view === v ? "bg-ocean/15 font-medium text-ocean" : "text-muted hover:text-white"}`}>
                  {v === "markdown" ? "Markdown" : "Teks yang dibacakan"}
                </button>
              ))}
            </div>
          </div>
          {view === "markdown" ? (
            <textarea value={markdown} onChange={(e) => setMarkdown(e.target.value)} spellCheck={false} placeholder="# Judul…" className={`${inputClass} min-h-[420px] flex-1 resize-none font-mono text-[13px] leading-6`} />
          ) : (
            <div className="min-h-[420px] flex-1 overflow-y-auto rounded-md border border-line-2 bg-ink p-4 text-sm leading-7">
              {spoken ? spoken.text.split("\n").map((p, i) => <p key={i} className="mb-2">{p}</p>) : <span className="text-muted">Menyiapkan…</span>}
            </div>
          )}
          <p className="text-xs text-muted">
            {markdown.length.toLocaleString()} karakter markdown
            {spoken && <> · {spoken.characters.toLocaleString()} karakter dibacakan dalam {spoken.chunks} bagian</>}
            {spoken && "usd" in spoken.estimate && <> · ±{formatSeconds(spoken.estimate.seconds)} audio, perkiraan {usd(spoken.estimate.usd)}</>}
          </p>

          <Card title="Hasil audio" count={jobs.length}>
            {jobs.length === 0 && <p className="px-4 py-6 text-center text-sm text-muted">Belum ada audio. Pilih suara lalu tekan Buat audio.</p>}
            <ul className="divide-y divide-line">
              {jobs.map((job) => (
                <li key={job.id} className="px-4 py-3">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium">{job.title}</span>
                    <span className="text-xs text-muted">{job.voice} · {job.model}{job.seconds ? ` · ${formatSeconds(job.seconds)}` : ""}{job.usd ? ` · ${usd(job.usd)}` : ""}</span>
                    <span className={`ml-auto rounded-full px-2 py-0.5 text-[11px] ${STATUS[job.status]}`}>{LABEL[job.status]}</span>
                    {job.status === "running" && <button type="button" onClick={() => cancel(job.id)} className={buttonClass.ghost}><Icon name="stop" /> Batal</button>}
                    {(job.status === "failed" || job.status === "cancelled") && <button type="button" onClick={() => retry(job.id)} title="Lanjutkan dari bagian yang belum dibaca" className={buttonClass.ghost}><Icon name="refresh" /> Lanjutkan{job.done ? ` (${job.done}/${job.chunks})` : ""}</button>}
                  </div>
                  {job.status === "running" && (
                    <div className="mt-2 flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-panel-2"><div className="h-full bg-ocean transition-all" style={{ width: `${Math.max(4, (job.done / job.chunks) * 100)}%` }} /></div>
                      <span className="text-[11px] tabular-nums text-muted">{job.done}/{job.chunks} bagian</span>
                    </div>
                  )}
                  {job.error && <p className="mt-1 text-xs text-bad">{job.error}</p>}
                  {!!job.drift?.length && (
                    <p className="mt-1 text-xs text-warn" title="Model membaca ulang bagian yang transkripnya berbeda dari teks; yang tercantum tetap berbeda setelah dibaca ulang.">
                      Tidak dibaca persis: {job.drift.map((d) => `bagian ${d.chunk} (kemiripan ${Math.round(d.similarity * 100)}%)`).join(", ")}
                    </p>
                  )}
                  {audio[job.id] && (
                    <div className="mt-2 flex items-center gap-2">
                      <audio controls src={audio[job.id]} className="h-9 flex-1" />
                      <a href={audio[job.id]} download={`${job.title}.wav`} className={buttonClass.secondary}><Icon name="download" /> WAV</a>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </main>

        <aside className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l border-line bg-panel p-4">
          <Field label="Model">
            <select value={model} onChange={(e) => setModel(e.target.value)} className={inputClass}>
              {(status?.models ?? []).map((m) => <option key={m} value={m}>{m}{m === status?.default ? " (default)" : ""}</option>)}
            </select>
          </Field>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-soft">Suara · <span className="text-ocean">{voice}</span></span>
              <div className="flex gap-1 text-[11px]">
                {(["all", "female", "male"] as const).map((g) => (
                  <button key={g} type="button" onClick={() => setGender(g)} className={`rounded px-1.5 py-0.5 ${gender === g ? "bg-ocean/15 text-ocean" : "text-muted hover:text-white"}`}>
                    {g === "all" ? "Semua" : g === "female" ? "Perempuan" : "Laki-laki"}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid max-h-[340px] grid-cols-2 gap-1.5 overflow-y-auto pr-1">
              {shown.map((v) => (
                <div key={v.name} className={`flex items-center gap-1 rounded-md border px-2 py-1.5 ${voice === v.name ? "border-ocean bg-ocean/10" : "border-line hover:border-line-2"}`}>
                  <button type="button" onClick={() => setVoice(v.name)} className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-xs font-medium">{v.name}</span>
                    <span className="block truncate text-[10px] text-muted">{v.style}</span>
                  </button>
                  <button type="button" onClick={() => playSample(v.name)} disabled={!status?.configured || sampling !== null} title={`Dengarkan contoh ${v.name}`} className="shrink-0 rounded p-1 text-muted hover:text-ocean disabled:opacity-40">
                    <Icon name={sampling === v.name ? "refresh" : "play"} className={`h-3.5 w-3.5 ${sampling === v.name ? "animate-spin" : ""}`} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <Field label="Gaya membaca" hint="Instruksi bebas untuk model, mis. “Read in a cheerful tone”.">
            <div className="mb-1.5 flex flex-wrap gap-1">
              {STYLES.map((s) => (
                <button key={s.label} type="button" onClick={() => setStyle(s.value)} className={`rounded-full px-2 py-0.5 text-[11px] ring-1 ${style === s.value ? "bg-ocean/15 text-ocean ring-ocean/30" : "text-soft ring-line-2 hover:text-white"}`}>{s.label}</button>
              ))}
            </div>
            <textarea value={style} onChange={(e) => setStyle(e.target.value)} rows={2} placeholder="(natural)" className={`${inputClass} resize-none text-xs`} />
          </Field>

          <button type="button" onClick={generate} disabled={!status?.configured || !markdown.trim() || !model} className={`${buttonClass.primary} justify-center py-2`}>
            <Icon name="play" /> Buat audio
          </button>
          <p className="text-[11px] leading-4 text-muted">Dokumen panjang dipecah per bagian (±1.200 karakter, ±1,5 menit suara) lalu dibaca 4 bagian sekaligus dan digabung jadi satu file WAV. Tiap bagian dicek kata per kata terhadap transkrip model dan dibaca ulang bila berbeda. Tiap bagian disimpan: kalau API di-restart, pekerjaan lanjut sendiri dari bagian yang belum dibaca.</p>
        </aside>
      </div>
    </div>
  );
}

const STATUS: Record<TtsJob["status"], string> = {
  running: "bg-ocean/15 text-ocean",
  completed: "bg-ok/15 text-ok",
  failed: "bg-bad/15 text-bad",
  cancelled: "bg-panel-2 text-muted",
};
const LABEL: Record<TtsJob["status"], string> = { running: "Memproses", completed: "Selesai", failed: "Gagal", cancelled: "Dibatalkan" };

function firstHeading(markdown: string) {
  return markdown.match(/^#{1,6}\s+(.+)$/m)?.[1].replace(/[*_`]/g, "").trim() ?? "";
}

const usd = (v: number) => (v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);

function formatSeconds(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}
