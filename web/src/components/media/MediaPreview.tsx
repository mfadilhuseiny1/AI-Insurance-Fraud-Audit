"use client";

/** Preview a media item by its schema: images, PDF pages (and their text), audio with its waveform, video,
 *  spreadsheets, email and DICOM (drag to change contrast and exposure). Uses the media set access patterns. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { accessJobNote, accessUrl, type AccessJob, hlsUrl, mediaContentUrl, mediaSets, type MediaSchema, type Transcription } from "@/lib/mediaSets";

type Meta = Record<string, unknown>;

export function MediaPreview({ id, schema, path, compact = false }: { id: string; schema: MediaSchema | null; path: string; compact?: boolean }) {
  const kind = mediaKind(schema, path);
  const [meta, setMeta] = useState<Meta | null>(null);
  useEffect(() => {
    let stale = false;
    mediaSets.metadata(id).then((m) => !stale && setMeta(m), () => !stale && setMeta({}));
    return () => {
      stale = true;
    };
  }, [id]);
  const box = compact ? "max-h-64" : "max-h-[60vh]";
  switch (kind) {
    case "image":
      /* eslint-disable-next-line @next/next/no-img-element */
      return <img src={mediaContentUrl(id)} alt={path} className={`${box} mx-auto rounded border border-line-2 bg-white object-contain`} />;
    case "document":
      return <PdfPreview id={id} pages={Number(meta?.pages ?? 0)} compact={compact} />;
    case "audio":
      return <AudioPreview id={id} channels={Number(meta?.channels ?? 0)} />;
    case "video":
      return <VideoPreview id={id} box={box} channels={Number(meta?.channels ?? 0)} />;
    case "spreadsheet":
      return <SheetPreview id={id} compact={compact} />;
    case "email":
      return <EmailPreview id={id} />;
    case "dicom":
      return <DicomPreview id={id} frames={Number(meta?.NumberOfFrames ?? 1)} compact={compact} />;
    default:
      return (
        <a href={mediaContentUrl(id, true)} className="inline-flex items-center gap-1 text-sm text-ocean hover:underline">
          <Icon name="download" className="h-4 w-4" /> Download {path}
        </a>
      );
  }
}

/** What a media item holds: its media set schema, else (multimodal or none) guessed from the extension. */
export const mediaKind = (schema: MediaSchema | null, path: string) => (schema === "multimodal" || !schema ? guess(path) : schema);

function guess(path: string): MediaSchema | null {
  const e = path.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "bmp", "tif", "tiff", "webp", "gif", "jp2"].includes(e)) return "image";
  if (e === "pdf") return "document";
  if (["wav", "flac", "mp3", "webm", "ogg", "m4a", "sph"].includes(e)) return "audio";
  if (["mp4", "mov", "ts", "mkv"].includes(e)) return "video";
  if (e === "xlsx") return "spreadsheet";
  if (e === "eml") return "email";
  if (e === "dcm") return "dicom";
  return null;
}

function PdfPreview({ id, pages, compact }: { id: string; pages: number; compact: boolean }) {
  const [page, setPage] = useState(0);
  const [mode, setMode] = useState<"page" | "text">("page");
  const [text, setText] = useState<string[] | null>(null);
  useEffect(() => {
    if (mode === "text" && text === null) mediaSets.access<{ pages: string[] }>(id, "text").then((t) => setText(t.pages), () => setText([]));
  }, [mode, id, text]);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs text-muted">
        <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)} className="rounded px-1.5 py-0.5 hover:bg-panel-2 disabled:opacity-40" aria-label="Previous page">
          <Icon name="left" className="h-3.5 w-3.5" />
        </button>
        <span>
          Page {page + 1}
          {pages ? ` of ${pages}` : ""}
        </span>
        <button type="button" disabled={!!pages && page >= pages - 1} onClick={() => setPage(page + 1)} className="rounded px-1.5 py-0.5 hover:bg-panel-2 disabled:opacity-40" aria-label="Next page">
          <Icon name="right" className="h-3.5 w-3.5" />
        </button>
        <span className="ml-auto flex gap-1">
          {(["page", "text"] as const).map((m) => (
            <button key={m} type="button" onClick={() => setMode(m)} className={`rounded px-1.5 py-0.5 ${mode === m ? "bg-ocean/15 text-white" : "hover:bg-panel-2"}`}>
              {m === "page" ? "Page" : "Text"}
            </button>
          ))}
        </span>
      </div>
      {mode === "page" ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img src={accessUrl(id, "page", { page, width: compact ? 500 : 900 })} alt={`Page ${page + 1}`} className={`${compact ? "max-h-64" : "max-h-[60vh]"} mx-auto rounded border border-line-2 bg-white`} />
      ) : (
        <pre className={`${compact ? "max-h-64" : "max-h-[60vh]"} overflow-auto whitespace-pre-wrap rounded bg-ink p-2 text-xs text-soft`}>
          {text === null ? "Extracting text…" : (text[page] ?? "").trim() || "(no text on this page — it may be a scan)"}
        </pre>
      )}
    </div>
  );
}

const HLS_TYPE = "application/vnd.apple.mpegurl";

/** The HLS source of an item once its first segments are rendered. Renders run in the background on the server, so
 *  this polls the status every 1.5 s (showing progress) and hands the playlist to the player as soon as it is
 *  playable — a render still going serves a growing playlist the player reloads; polling goes on for the progress
 *  note until it is ready. Under a recompute policy the first status call starts this playback's own rendition (its
 *  token); switching HLS off before the render finished cancels it. cancel(): stops the render now (a shared rendition
 *  needs Editor on the media set; polling stops, since asking again would start a new render). */
function useHls(id: string, channel: string, on: boolean): { src: string | undefined; note: string | null; cancel: (() => void) | null } {
  const key = `${id}|${channel}`;
  const [res, setRes] = useState<{ key: string; src?: string; note: string | null; running?: boolean }>({ key: "", note: null });
  const cancelRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!on) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let token: string | null = null;
    let ready = false;
    let src: string | undefined;
    cancelRef.current = () => {
      stop = true;
      clearTimeout(timer);
      setRes({ key, src, note: "Cancelling the HLS render…" });
      mediaSets.cancelHls(id, channel, "hls", token).then(
        () => setRes({ key, note: "HLS render cancelled" }),
        (e: Error) => setRes({ key, note: `HLS render not cancelled: ${e.message}` }),
      );
    };
    const tick = async () => {
      try {
        const s = await mediaSets.hlsStatus(id, channel, "hls", token);
        if (stop) return;
        token = s.token;
        // the source URL stays the same once set: a new one would restart the player
        src = src ?? (s.state === "ready" || s.playable ? hlsUrl(id, channel, "hls", s.token) : undefined);
        if (s.state === "ready") {
          ready = true;
          setRes({ key, src, note: null });
        } else if (s.state === "failed" || s.state === "cancelled") {
          ready = true; // nothing left to cancel
          setRes({ key, note: s.state === "failed" ? `HLS render failed: ${s.error ?? "unknown error"}` : "HLS render cancelled" });
        } else {
          const eta = s.eta_seconds != null ? ` (about ${fmtTime(s.eta_seconds)} left)` : "";
          const note =
            s.phase === "fetching"
              ? `Fetching the source for HLS…${s.fetch_progress != null ? ` ${Math.round(s.fetch_progress * 100)}%` : ""}`
              : s.state === "queued"
                ? "HLS render queued…"
                : `Rendering HLS… ${Math.round(s.progress * 100)}%${eta}${src ? " — playing the rendered part" : ""}`;
          setRes({ key, src, note, running: true });
          timer = setTimeout(tick, src ? 3000 : 1500);
        }
      } catch (e) {
        if (!stop) setRes({ key, note: `HLS: ${(e as Error).message}` });
      }
    };
    void tick();
    return () => {
      const cancelled = stop; // cancel() already stopped it
      stop = true;
      cancelRef.current = null;
      clearTimeout(timer);
      if (token && !ready && !cancelled) void mediaSets.cancelHls(id, channel, "hls", token).catch(() => {});
    };
  }, [id, channel, on, key]);
  if (!on) return { src: undefined, note: null, cancel: null };
  return res.key === key ? { src: res.src, note: res.note, cancel: res.running ? () => cancelRef.current?.() : null } : { src: undefined, note: "Rendering HLS…", cancel: null };
}

/** The source of one channel (or the mix-down) of an item as wav. A long item's transcode is a background job on the
 *  server: its progress shows until the output is ready, then the player gets the URL (under recompute, this
 *  playback's own output by its token). Leaving the channel before it is ready cancels a recompute computation. */
function useChannelAudio(id: string, channel: string | null): { src: string | undefined; note: string | null } {
  const key = `${id}|${channel}`;
  const [res, setRes] = useState<{ key: string; src?: string; note: string | null }>({ key: "", note: null });
  useEffect(() => {
    if (channel === null) return;
    const ctl = new AbortController();
    mediaSets
      .accessReadyUrl(id, "audio", { channel, format: "wav" }, (s) => setRes({ key, note: accessJobNote(s, "Transcoding") }), ctl.signal)
      .then(
        (src) => setRes({ key, src, note: null }),
        (e: Error) => e.name !== "AbortError" && setRes({ key, note: e.message }),
      );
    return () => ctl.abort();
  }, [id, channel, key]);
  if (channel === null) return { src: undefined, note: null };
  return res.key === key ? { src: res.src, note: res.note } : { src: undefined, note: null };
}

/** Channel choice (all / mix-down / one channel), transcription of that channel (segments, click to seek) and the
 *  HLS stream of the item. */
function AvTools({
  id,
  channels,
  channel,
  setChannel,
  allowAll,
  onSeek,
  hls,
  setHls,
  hlsNote,
  hlsCancel,
}: {
  id: string;
  channels: number;
  channel: string;
  setChannel: (c: string) => void;
  allowAll: boolean;
  onSeek: (t: number) => void;
  hls: boolean;
  setHls: (v: boolean) => void;
  /** the HLS render's progress (or failure) while the rendition is not ready */
  hlsNote: string | null;
  /** stops the HLS render while it runs (null: nothing to cancel) */
  hlsCancel: (() => void) | null;
}) {
  const [text, setText] = useState<Transcription | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // the parent keys this component by item and channel, so a new channel starts without a transcript
  const [native] = useState(() => typeof document !== "undefined" && !!document.createElement("video").canPlayType(HLS_TYPE));
  const abort = useRef<AbortController | null>(null);
  // the transcription job's last state (its token under recompute: aborting the wait cancels that one itself)
  const job = useRef<AccessJob | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const params = { channel: channel === "all" ? "mix" : channel, output_format: "segments" };
  const transcribe = async () => {
    setBusy(true);
    setError(null);
    job.current = null;
    abort.current = new AbortController();
    try {
      // a long item is transcribed by a background job: its progress shows until the transcript is ready
      setText(
        await mediaSets.access<Transcription>(id, "transcription", params, (s) => ((job.current = s), setProgress(accessJobNote(s, "Transcribing"))), abort.current.signal),
      );
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };
  /** Stops the transcription: this request's own computation (recompute) is cancelled by aborting the wait; a shared
   *  output's job (computed once for everyone) is cancelled on the server, which needs Editor on the media set. */
  const cancel = async () => {
    const shared = job.current && !job.current.token;
    abort.current?.abort();
    if (!shared) return;
    try {
      await mediaSets.cancelAccess(id, "transcription", params);
      setError("Transcription cancelled");
    } catch (e) {
      setError(`Transcription not cancelled: ${(e as Error).message}`);
    }
  };
  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-2 text-muted">
        <label className="flex items-center gap-1">
          Channel
          <select aria-label="Audio channel" value={channel} onChange={(e) => setChannel(e.target.value)} className="rounded border border-line-2 bg-ink px-1.5 py-0.5 text-xs text-soft">
            {allowAll && <option value="all">All channels</option>}
            <option value="mix">Mix down (mono)</option>
            {Array.from({ length: channels }, (_, i) => (
              <option key={i} value={String(i)}>
                Channel {i + 1}
                {channels === 2 ? (i === 0 ? " (left)" : " (right)") : ""}
              </option>
            ))}
          </select>
        </label>
        <button type="button" disabled={busy} onClick={transcribe} className="rounded px-1.5 py-0.5 text-ocean hover:bg-panel-2 disabled:opacity-50">
          {busy ? "Transcribing…" : "Transcribe"}
        </button>
        <span className="ml-auto flex items-center gap-2">
          {native && (
            <label className="flex items-center gap-1" title="Play through the HLS playlist (6-second segments)">
              <input type="checkbox" checked={hls} onChange={(e) => setHls(e.target.checked)} className="accent-[var(--color-ocean)]" /> HLS
            </label>
          )}
          <a href={hlsUrl(id, channel)} target="_blank" rel="noreferrer" className="text-ocean hover:underline" title="HLS playlist of 6-second MPEG-TS segments, for HLS players">
            .m3u8
          </a>
        </span>
      </div>
      {hls && hlsNote && (
        <p className="flex items-center gap-2 text-muted" role="status" data-hls-note>
          {hlsNote}
          {hlsCancel && (
            <button type="button" onClick={hlsCancel} className="rounded px-1.5 py-0.5 text-ocean hover:bg-panel-2" data-hls-cancel>
              Cancel
            </button>
          )}
        </p>
      )}
      {busy && progress && (
        <p className="flex items-center gap-2 text-muted" role="status" data-transcribe-note>
          {progress}
          <button type="button" onClick={cancel} className="rounded px-1.5 py-0.5 text-ocean hover:bg-panel-2" data-transcribe-cancel>
            Cancel
          </button>
        </p>
      )}
      {error && <p className="text-bad">{error}</p>}
      {text && (
        <ul className="max-h-48 space-y-0.5 overflow-y-auto rounded bg-ink p-1.5">
          {(text.segments ?? []).length === 0 && <li className="text-muted">(no speech found)</li>}
          {(text.segments ?? []).map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => onSeek(s.start)} className="flex w-full gap-2 rounded px-1 text-left hover:bg-panel-2">
                <span className="shrink-0 font-mono text-muted">{fmtTime(s.start)}</span>
                <span className="text-soft">{s.text}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function seekTo(el: HTMLMediaElement | null, t: number) {
  if (!el) return;
  el.currentTime = t;
  void el.play().catch(() => {});
}

const fmtTime = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

function VideoPreview({ id, box, channels }: { id: string; box: string; channels: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [channel, setChannel] = useState("all");
  const [hls, setHls] = useState(false);
  const stream = useHls(id, channel, hls);
  return (
    <div className="space-y-2">
      <video ref={ref} src={hls ? stream.src : mediaContentUrl(id)} controls className={`${box} mx-auto w-full rounded bg-black`} />
      {channels > 0 && (
        <AvTools key={`${id}|${channel}`} id={id} channels={channels} channel={channel} setChannel={setChannel} allowAll onSeek={(t) => seekTo(ref.current, t)} hls={hls} setHls={setHls} hlsNote={stream.note} hlsCancel={stream.cancel} />
      )}
    </div>
  );
}

function AudioPreview({ id, channels }: { id: string; channels: number }) {
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [channel, setChannel] = useState("all");
  const [hls, setHls] = useState(false);
  const ref = useRef<HTMLAudioElement>(null);
  const [waveNote, setWaveNote] = useState<string | null>(null);
  useEffect(() => {
    // a long item's waveform is computed by a background job: polled until ready
    const ctl = new AbortController();
    mediaSets
      .access<{ peaks: number[] }>(id, "waveform", channel === "all" ? {} : { channel }, (s) => setWaveNote(accessJobNote(s, "Reading the waveform")), ctl.signal)
      .then(
        (w) => {
          setPeaks(w.peaks);
          setWaveNote(null);
        },
        (e: Error) => {
          if (e.name === "AbortError") return;
          setPeaks([]);
          setWaveNote(null);
        },
      );
    return () => ctl.abort();
  }, [id, channel]);
  const stream = useHls(id, channel, hls);
  const channelAudio = useChannelAudio(id, hls || channel === "all" ? null : channel);
  const src = hls ? stream.src : channel === "all" ? mediaContentUrl(id) : channelAudio.src;
  const bars = useMemo(() => {
    if (!peaks?.length) return [];
    const n = 160;
    const step = Math.max(1, Math.floor(peaks.length / n));
    const out: number[] = [];
    for (let i = 0; i < peaks.length; i += step) out.push(Math.max(...peaks.slice(i, i + step)));
    return out;
  }, [peaks]);
  return (
    <div className="space-y-2">
      {bars.length > 0 && (
        <svg viewBox={`0 0 ${bars.length * 3} 40`} className="h-12 w-full" role="img" aria-label="Audio waveform">
          {bars.map((v, i) => (
            <rect key={i} x={i * 3} y={20 - Math.max(0.5, v * 19)} width={2} height={Math.max(1, v * 38)} rx={1} fill="var(--color-ocean)" />
          ))}
        </svg>
      )}
      {waveNote && (
        <p className="text-xs text-muted" role="status">
          Waveform: {waveNote}
        </p>
      )}
      <audio ref={ref} src={src} controls className="w-full" />
      {!hls && channel !== "all" && channelAudio.note && (
        <p className="text-xs text-muted" role="status">
          Channel audio: {channelAudio.note}
        </p>
      )}
      <AvTools key={`${id}|${channel}`} id={id} channels={channels} channel={channel} setChannel={setChannel} allowAll onSeek={(t) => seekTo(ref.current, t)} hls={hls} setHls={setHls} hlsNote={stream.note} hlsCancel={stream.cancel} />
    </div>
  );
}

type Sheets = Record<string, { table: (string | null)[][]; merged_cells: string[] }>;

function SheetPreview({ id, compact }: { id: string; compact: boolean }) {
  const [sheets, setSheets] = useState<Sheets | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState(0);
  useEffect(() => {
    mediaSets.access<Sheets>(id, "sheets").then(setSheets, (e: Error) => setError(e.message));
  }, [id]);
  if (error) return <p className="text-xs text-bad">{error}</p>;
  if (!sheets) return <p className="text-xs text-muted">Reading the spreadsheet…</p>;
  const names = Object.keys(sheets);
  const sheet = sheets[names[tab]];
  const cols = Math.max(0, ...(sheet?.table ?? []).map((r) => r.length));
  const letter = (i: number) => (i >= 26 ? String.fromCharCode(64 + Math.floor(i / 26)) : "") + String.fromCharCode(65 + (i % 26));
  return (
    <div className="space-y-1">
      <div className={`${compact ? "max-h-56" : "max-h-[55vh]"} overflow-auto rounded border border-line-2`}>
        <table className="text-xs">
          <thead className="sticky top-0 bg-panel-2 text-muted">
            <tr>
              <th className="px-1.5" />
              {Array.from({ length: cols }, (_, i) => (
                <th key={i} className="min-w-16 border-l border-line px-2 py-0.5 font-normal">
                  {letter(i)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(sheet?.table ?? []).slice(0, 500).map((r, i) => (
              <tr key={i} className="border-t border-line">
                <td className="bg-panel-2 px-1.5 text-right text-muted">{i + 1}</td>
                {Array.from({ length: cols }, (_, j) => (
                  <td key={j} className="max-w-48 truncate border-l border-line px-2 py-0.5 text-soft">
                    {r[j] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-1 text-[11px]">
        {names.map((n, i) => (
          <button key={n} type="button" onClick={() => setTab(i)} className={`rounded px-2 py-0.5 ${tab === i ? "bg-ocean/15 text-white" : "text-muted hover:bg-panel-2"}`}>
            {n}
          </button>
        ))}
        {sheet?.merged_cells.length ? <span className="ml-auto text-muted">merged: {sheet.merged_cells.slice(0, 6).join(", ")}</span> : null}
      </div>
    </div>
  );
}

function EmailPreview({ id }: { id: string }) {
  const [mail, setMail] = useState<{ from: string; to: string; subject: string; date: string; body: string; attachments: string[] } | null>(null);
  useEffect(() => {
    mediaSets.access<NonNullable<typeof mail>>(id, "email").then(setMail, () => setMail(null));
  }, [id]);
  if (!mail) return <p className="text-xs text-muted">Reading the email…</p>;
  return (
    <div className="space-y-2 text-xs">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {(["subject", "from", "to", "date"] as const).map((k) => (
          <div key={k} className="contents">
            <dt className="capitalize text-muted">{k}</dt>
            <dd className="text-soft">{mail[k]}</dd>
          </div>
        ))}
      </dl>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-ink p-2 text-soft">{mail.body}</pre>
      {mail.attachments.length > 0 && <p className="text-muted">Attachments: {mail.attachments.join(", ")}</p>}
    </div>
  );
}

function DicomPreview({ id, frames, compact }: { id: string; frames: number; compact: boolean }) {
  const [layer, setLayer] = useState<number | null>(null);
  const [adj, setAdj] = useState({ contrast: 1, brightness: 1 });
  const [drag, setDrag] = useState<{ x: number; y: number; c: number; b: number } | null>(null);
  const src = accessUrl(id, "dicom", { width: compact ? 400 : 800, ...(layer !== null ? { layer } : {}) });
  return (
    <div className="space-y-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt="DICOM layer"
        draggable={false}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          setDrag({ x: e.clientX, y: e.clientY, c: adj.contrast, b: adj.brightness });
        }}
        onPointerMove={(e) => {
          if (!drag) return;
          setAdj({ contrast: Math.max(0.1, drag.c + (e.clientX - drag.x) / 200), brightness: Math.max(0.1, drag.b - (e.clientY - drag.y) / 200) });
        }}
        onPointerUp={() => setDrag(null)}
        style={{ filter: `contrast(${adj.contrast}) brightness(${adj.brightness})` }}
        className={`${compact ? "max-h-64" : "max-h-[60vh]"} mx-auto cursor-crosshair select-none rounded bg-black`}
      />
      <div className="flex items-center gap-3 text-[11px] text-muted">
        <span>Drag left / right for contrast, up / down for exposure</span>
        <button type="button" onClick={() => setAdj({ contrast: 1, brightness: 1 })} className="text-ocean hover:underline">
          Reset
        </button>
        {frames > 1 && (
          <label className="ml-auto flex items-center gap-1">
            Layer
            <input type="range" min={0} max={frames - 1} value={layer ?? Math.floor(frames / 2)} onChange={(e) => setLayer(Number(e.target.value))} />
            <span className="w-8 text-soft">{(layer ?? Math.floor(frames / 2)) + 1}</span>
          </label>
        )}
      </div>
    </div>
  );
}
