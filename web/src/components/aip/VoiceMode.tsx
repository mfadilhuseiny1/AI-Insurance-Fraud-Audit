"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { aip, usd, type AipEvent, type Run, type VoiceStatus } from "./aipRun";
import { useTampilBiaya } from "./biaya";
import { FILLERS, PROGRESS, echoesHint, narration, soundsUnfinished, speechChunks } from "./voice";

/* Voice mode of AIP JKN: a spoken conversation with the same orchestrator and domain agents as typed questions.

     listen ─► end of speech (silence) ─► /api/aip/voice/transcribe ─► /api/aip/ask {voice: true}
       ▲                                                                       │
       └── read aloud, sentence by sentence ◄── /api/aip/voice/speak ◄── run events: plan, draft, verdict

   The voice reads only what the run produced (the plan, the answer, the validator's verdict), so a spoken answer is
   as grounded and as checked as the written one; the screen beside it shows the receipts. While the agents work it
   says, at most once per stage, what stage they are in.

   Speech detection uses the microphone level (Web Audio), no model: the threshold is calibrated from the room's noise
   when the mode opens and keeps following it. Answers play through one AudioContext opened by the click that starts
   the mode, so autoplay rules do not block them. Interrupting by voice is off by default: browsers' echo cancellation
   does not cancel the page's own audio, so without a headset the answer itself would count as an interruption; tap
   the circle instead. Adapted from the voice mode of ai-muhammadiyah (components/knowledge-graph/VoiceMode.tsx). */

type Phase = "starting" | "listening" | "hearing" | "transcribing" | "thinking" | "speaking" | "paused" | "error";

const TICK_MS = 50;
const END_SILENCE_MS = 1600; // silence that ends an utterance
const CONTINUE_WAIT_MS = 2500; // an utterance that sounds unfinished waits this long for more
const MIN_SPEECH_MS = 350; // shorter sounds are noise
const MAX_SPEECH_MS = 30_000;
const IDLE_RESTART_MS = 25_000; // a recording with no speech is dropped and started again
const BARGE_FACTOR = 3;
const BARGE_OVER_ECHO = 2;
const BARGE_MS = 450;
const PROGRESS_AFTER_MS = 20_000; // silence while the agents work before the voice says what they are doing

const LABEL: Record<Phase, string> = {
  starting: "Menyiapkan mikrofon…",
  listening: "Silakan bicara",
  hearing: "Mendengarkan… ketuk untuk kirim",
  transcribing: "Memahami ucapan…",
  thinking: "Agen bekerja — ketuk lingkaran untuk menyela",
  speaking: "Menjawab — ketuk lingkaran untuk menyela",
  paused: "Mikrofon dijeda",
  error: "Mode suara berhenti",
};

type Turn = { q: string; prevRunId: string | null; runId: string | null; seen: Set<number>; stage: string; said: Set<string>; quietSince: number; answered: boolean; ended: boolean };

type Props = {
  run: Run | null;
  events: AipEvent[];
  /** ask the orchestrator with voice: true; the page follows the run and passes its events back */
  ask: (text: string) => Promise<void>;
  onClose: () => void;
};

function MicIcon({ off }: { off?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      {off && <path d="M4 4l16 16" />}
    </svg>
  );
}

export function VoiceMode({ run, events, ask, onClose }: Props) {
  const tampilBiaya = useTampilBiaya();
  const [phase, setPhaseState] = useState<Phase>("starting");
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [voice, setVoice] = useState("marin");
  const [level, setLevel] = useState(0);
  const [quiet, setQuiet] = useState(0);
  const [heard, setHeard] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [saying, setSaying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cost, setCost] = useState(0);
  const [micName, setMicName] = useState<string | null>(null);
  const [micSilent, setMicSilent] = useState(false);
  const [bargeByVoice, setBargeByVoice] = useState(false);
  const bargeRef = useRef(false);
  const voiceRef = useRef("marin");
  const hintRef = useRef("");
  useEffect(() => { bargeRef.current = bargeByVoice; }, [bargeByVoice]);
  useEffect(() => { voiceRef.current = voice; }, [voice]);

  const phaseRef = useRef<Phase>("starting");
  const setPhase = useCallback((p: Phase) => { phaseRef.current = p; setPhaseState(p); }, []);

  // audio in
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const thresholdRef = useRef(0.015);
  const calibRef = useRef<number[]>([]);
  const floorRef = useRef(0);
  const peakRef = useRef(0);
  const vadRef = useRef({ above: 0, silentMs: 0, speechStart: 0, listenStart: 0, barge: 0, echo: 0 });
  const pendingRef = useRef<string | null>(null);

  // audio out
  const queueRef = useRef<{ text: string; audio: Promise<AudioBuffer> }[]>([]);
  const playingRef = useRef<AudioBufferSourceNode | null>(null);
  const fetchingRef = useRef(false);
  const genRef = useRef(0); // raised whenever the voice is stopped: audio of an older turn is dropped
  const turnRef = useRef<Turn | null>(null);
  const runRef = useRef<Run | null>(run);
  useEffect(() => { runRef.current = run; }, [run]);

  const speech = useCallback(async (ctx: AudioContext, text: string): Promise<AudioBuffer> => {
    const r = await aip.speak(text, voiceRef.current);
    setCost((c) => c + r.usd);
    return ctx.decodeAudioData(r.audio);
  }, []);

  /* ------------------------------------------------------------ listening */

  const stopRecorder = () => {
    try {
      if (recorderRef.current?.state === "recording") {
        recorderRef.current.onstop = null;
        recorderRef.current.stop();
      }
    } catch { /* already stopped */ }
  };

  const startListening = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    stopRecorder();
    chunksRef.current = [];
    const rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
    rec.start();
    recorderRef.current = rec;
    vadRef.current = { above: 0, silentMs: 0, speechStart: 0, listenStart: Date.now(), barge: 0, echo: 0 };
    setPhase("listening");
  }, [setPhase]);

  /* ------------------------------------------------------------- speaking */

  const finishTurnIfDone = useCallback(() => {
    if (playingRef.current || fetchingRef.current || queueRef.current.length) return;
    const turn = turnRef.current;
    if (!turn) return;
    if (!turn.ended) {
      // said everything so far; the agents are still working
      if (phaseRef.current === "speaking") setPhase("thinking");
      turn.quietSince = Date.now();
      setSaying(null);
      return;
    }
    turnRef.current = null;
    setSaying(null);
    startListening();
  }, [setPhase, startListening]);

  const playNextRef = useRef<() => void>(() => {});
  const playNext = useCallback(async () => {
    if (playingRef.current || fetchingRef.current) return;
    const item = queueRef.current.shift();
    if (!item) { finishTurnIfDone(); return; }
    const ctx = ctxRef.current;
    const gen = genRef.current;
    fetchingRef.current = true;
    let buffer: AudioBuffer;
    try {
      buffer = await item.audio;
    } catch (e) {
      if (gen !== genRef.current) return;
      fetchingRef.current = false;
      setError(`Suara gagal dimuat: ${(e as Error).message}`);
      playNextRef.current();
      return;
    }
    if (gen !== genRef.current) return; // interrupted while the audio was fetched
    fetchingRef.current = false;
    if (!ctx || (phaseRef.current !== "thinking" && phaseRef.current !== "speaking")) return;
    if (ctx.state !== "running") await ctx.resume().catch(() => {});
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    playingRef.current = src;
    setSaying(item.text);
    setPhase("speaking");
    src.onended = () => {
      if (playingRef.current !== src) return;
      playingRef.current = null;
      if (turnRef.current) turnRef.current.quietSince = Date.now();
      playNextRef.current();
    };
    src.start();
  }, [finishTurnIfDone, setPhase]);
  useEffect(() => { playNextRef.current = playNext; }, [playNext]);

  const enqueue = useCallback((text: string) => {
    const ctx = ctxRef.current;
    if (!ctx || !text.trim()) return;
    const audio = speech(ctx, text);
    audio.catch(() => {}); // reported when its turn comes
    queueRef.current.push({ text, audio });
    playNext();
  }, [playNext, speech]);
  const enqueueRef = useRef(enqueue);
  useEffect(() => { enqueueRef.current = enqueue; }, [enqueue]);

  /** stop the voice (the run goes on, on screen) */
  const silence = useCallback(() => {
    const src = playingRef.current;
    playingRef.current = null;
    fetchingRef.current = false;
    genRef.current += 1;
    if (src) {
      src.onended = null;
      try { src.stop(); } catch { /* not started */ }
    }
    queueRef.current = [];
    turnRef.current = null;
    setSaying(null);
  }, []);

  /** a finished utterance becomes a question to the orchestrator */
  const submit = useCallback((text: string) => {
    pendingRef.current = null;
    setPending(null);
    setHeard(text);
    turnRef.current = { q: text, prevRunId: runRef.current?.id ?? null, runId: null, seen: new Set(), stage: "plan", said: new Set(), quietSince: Date.now(), answered: false, ended: false };
    setPhase("thinking");
    if (text.split(/\s+/).length > 3) enqueue(FILLERS[Math.floor(Math.random() * FILLERS.length)]);
    ask(text).catch((e) => {
      setError((e as Error).message);
      if (turnRef.current?.q === text) {
        turnRef.current.ended = true;
        enqueue("Maaf, pertanyaannya tidak bisa diteruskan ke agen. Silakan coba lagi.");
      }
    });
  }, [ask, enqueue, setPhase]);

  const transcribe = useCallback(async (blob: Blob, speechMs: number, forced: boolean) => {
    if (speechMs < MIN_SPEECH_MS || blob.size < 1500) {
      if (forced && pendingRef.current) submit(pendingRef.current);
      else startListening();
      return;
    }
    setPhase("transcribing");
    try {
      const r = await aip.transcribe(blob);
      setCost((c) => c + r.usd);
      const text = r.text.trim();
      if (phaseRef.current !== "transcribing") return; // paused or closed meanwhile
      if (!/[\p{L}]{2,}/u.test(text) || echoesHint(text, hintRef.current)) {
        if (forced && pendingRef.current) submit(pendingRef.current);
        else startListening();
        return;
      }
      const combined = pendingRef.current ? `${pendingRef.current} ${text}` : text;
      if (!forced && combined.length < 600 && soundsUnfinished(combined)) {
        pendingRef.current = combined;
        setPending(combined);
        startListening();
        return;
      }
      submit(combined);
    } catch (e) {
      setError(`Transkripsi gagal: ${(e as Error).message}`);
      startListening();
    }
  }, [setPhase, startListening, submit]);

  const endUtterance = useCallback((forced = false) => {
    const rec = recorderRef.current;
    const speechMs = Date.now() - vadRef.current.speechStart;
    setQuiet(0);
    setPhase("transcribing");
    if (!rec || rec.state !== "recording") { startListening(); return; }
    rec.onstop = () => transcribe(new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" }), speechMs, forced);
    rec.stop();
  }, [setPhase, startListening, transcribe]);

  /* ----------------------------------------------- the run's events, read aloud */

  useEffect(() => {
    const turn = turnRef.current;
    if (!turn || !run || run.q !== turn.q || run.id === turn.prevRunId) return;
    if (turn.runId && turn.runId !== run.id) return;
    turn.runId = run.id;
    for (const e of events) {
      if (turn.seen.has(e.seq)) continue;
      turn.seen.add(e.seq);
      if (e.type === "stage" && e.stage) turn.stage = String(e.stage);
      if (e.type === "draft") turn.answered = true;
      const say = narration(e);
      if (say) for (const c of speechChunks(say)) enqueue(c);
    }
    if (run.status !== "running" && !turn.ended) {
      turn.ended = true;
      if (!turn.answered) enqueue(run.status === "cancelled" ? "Pertanyaan dibatalkan." : "Maaf, agen tidak menyelesaikan jawabannya. Silakan ulangi pertanyaannya.");
      finishTurnIfDone();
    }
  }, [run, events, enqueue, finishTurnIfDone]);

  /* ------------------------------------------------ start, and the listening loop */

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    const buf = new Float32Array(2048);
    aip.voiceStatus().then((s) => {
      setStatus(s);
      hintRef.current = s.vocabulary;
      setVoice(s.default_voice);
      if (!s.configured) setError("Suara belum diatur: isi OPENAI_API_KEY di .env.local lalu restart API.");
    }).catch((e) => setError((e as Error).message));

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        setMicName(stream.getAudioTracks()[0]?.label || null);
        const ctx = new AudioContext();
        await ctx.resume().catch(() => {});
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        ctx.createMediaStreamSource(stream).connect(analyser);
        ctxRef.current = ctx;
        analyserRef.current = analyser;
      } catch (e) {
        setError(e instanceof DOMException && e.name === "NotAllowedError"
          ? "Izin mikrofon ditolak. Izinkan mikrofon untuk situs ini, lalu buka lagi mode suara."
          : `Mikrofon tidak bisa dibuka: ${(e as Error).message}`);
        setPhase("error");
        return;
      }

      timer = setInterval(() => {
        const analyser = analyserRef.current;
        const ctx = ctxRef.current;
        if (!analyser || !ctx) return;
        if (ctx.state === "suspended") ctx.resume().catch(() => {});
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const x of buf) sum += x * x;
        const rms = Math.sqrt(sum / buf.length);
        const thr = thresholdRef.current;
        setLevel(Math.min(1, rms / (thr * 4)));
        const v = vadRef.current;
        const p = phaseRef.current;
        // threshold = 3× the room's noise (0.006–0.03), the noise estimate kept up to date from quiet moments
        const retune = () => { thresholdRef.current = Math.min(0.03, Math.max(0.006, floorRef.current * 3)); };

        if (p === "starting") {
          calibRef.current.push(rms);
          if (calibRef.current.length >= 10) {
            floorRef.current = [...calibRef.current].sort((a, b) => a - b)[2];
            retune();
            peakRef.current = 0;
            startListening();
          }
        } else if (p === "listening") {
          if (rms < thr) { floorRef.current = floorRef.current * 0.97 + rms * 0.03; retune(); }
          peakRef.current = Math.max(peakRef.current, rms);
          setMicSilent(Date.now() - v.listenStart > 5000 && peakRef.current < 0.0015);
          v.above = rms > thr ? v.above + 1 : 0;
          if (v.above >= 3) {
            v.speechStart = Date.now() - 3 * TICK_MS;
            v.silentMs = 0;
            setPhase("hearing");
          } else if (pendingRef.current && Date.now() - v.listenStart > CONTINUE_WAIT_MS) {
            const text = pendingRef.current;
            stopRecorder();
            submit(text);
          } else if (Date.now() - v.listenStart > IDLE_RESTART_MS) startListening();
        } else if (p === "hearing") {
          if (rms < thr * 0.6) v.silentMs += TICK_MS;
          else if (rms > thr * 0.8) v.silentMs = 0;
          setQuiet(Math.min(1, v.silentMs / END_SILENCE_MS));
          if (v.silentMs >= END_SILENCE_MS || Date.now() - v.speechStart > MAX_SPEECH_MS) endUtterance();
        } else if (p === "thinking") {
          // a long silence while the agents work: say once what stage they are in
          const turn = turnRef.current;
          const line = turn && PROGRESS[turn.stage];
          if (turn && line && !turn.said.has(turn.stage) && !playingRef.current && !fetchingRef.current && !queueRef.current.length
              && Date.now() - turn.quietSince > PROGRESS_AFTER_MS) {
            turn.said.add(turn.stage);
            enqueueRef.current(line);
          }
        } else if (p === "speaking" && bargeRef.current) {
          v.echo = v.echo ? v.echo * 0.95 + rms * 0.05 : rms;
          v.barge = rms > Math.max(thr * BARGE_FACTOR, v.echo * BARGE_OVER_ECHO) ? v.barge + TICK_MS : 0;
          if (v.barge >= BARGE_MS) {
            silence();
            startListening();
            v.speechStart = Date.now() - BARGE_MS;
            setPhase("hearing");
          }
        }
      }, TICK_MS);
    })();

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      const src = playingRef.current;
      playingRef.current = null;
      try { src?.stop(); } catch { /* not started */ }
      queueRef.current = [];
      stopRecorder();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      ctxRef.current?.close().catch(() => {});
    };
    // once, when the mode opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------------------------------------------------ view */

  const paused = phase === "paused";
  const orbAction = phase === "speaking" || phase === "thinking" ? "Sela" : phase === "hearing" || (phase === "listening" && pending) ? "Kirim sekarang" : null;
  const scale = 1 + (phase === "hearing" ? level * 0.6 : phase === "speaking" ? 0.12 : 0);
  const onOrb = () => {
    if (phase === "speaking" || phase === "thinking") { silence(); startListening(); }
    else if (phase === "hearing") endUtterance(true);
    else if (phase === "listening" && pendingRef.current) { stopRecorder(); submit(pendingRef.current); }
  };

  return (
    <div className="border-t border-white/10 bg-black/20 p-2 text-[11.5px]">
      <div className="flex items-center gap-2.5">
        <button type="button" onClick={onOrb} title={orbAction ?? undefined} aria-label={orbAction ?? LABEL[phase]}
          className={`relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#5b5fd6]/25 ${orbAction ? "cursor-pointer" : "cursor-default"}`}>
          <span className={`absolute inset-1.5 rounded-full bg-[#7c7ff0] transition-transform duration-75 ${phase === "thinking" || phase === "transcribing" ? "animate-pulse" : ""}`}
            style={{ opacity: paused || phase === "error" ? 0.25 : phase === "hearing" || phase === "speaking" ? 0.95 : 0.6, transform: `scale(${scale})` }} />
          <span className="relative text-white">{phase === "speaking" ? <Icon name="stop" className="h-3.5 w-3.5" /> : <MicIcon />}</span>
        </button>
        <div className="min-w-0 flex-1">
          <p className="font-medium text-[#e5e8eb]">{phase === "listening" && pending ? "Silakan lanjutkan…" : LABEL[phase]}</p>
          <p className="truncate text-[11px] text-[#8f99a8]" title={saying ?? pending ?? heard ?? undefined}>
            {saying ? `“${saying}”` : pending ? `Anda: ${pending}…` : heard ? `Anda: ${heard}` : "Jawaban dari agen yang sama, dibacakan setelah divalidasi."}
          </p>
          <div className={`mt-1 h-[3px] rounded-full bg-white/10 ${phase === "hearing" ? "" : "opacity-0"}`}>
            <div className="h-full rounded-full bg-[#9d8cff]" style={{ width: `${(1 - quiet) * 100}%` }} />
          </div>
        </div>
      </div>
      {error && <p className="mt-1.5 text-[11px] text-red-300">{error}</p>}
      {micSilent && phase === "listening" && <p className="mt-1.5 text-[11px] text-red-300">Mikrofon tidak menangkap suara. Periksa mikrofon yang dipilih browser dan pastikan tidak dibisukan.</p>}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
        <button type="button" disabled={phase === "starting" || phase === "error"}
          onClick={() => { if (paused) startListening(); else { silence(); stopRecorder(); pendingRef.current = null; setPending(null); setPhase("paused"); } }}
          className="flex items-center gap-1 rounded border border-white/15 px-1.5 py-0.5 text-[#d3d8de] hover:bg-white/10 disabled:opacity-40">
          <MicIcon off={!paused} />{paused ? "Lanjut" : "Jeda"}
        </button>
        <select value={voice} onChange={(e) => setVoice(e.target.value)} title="Suara" className="rounded border border-white/15 bg-[#111418] px-1 py-0.5 text-[#d3d8de]">
          {(status?.voices ?? [{ name: "marin", style: "", gender: "" }]).map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
        </select>
        <label className="flex items-center gap-1 text-[#abb3bf]" title="Bicara saat jawaban dibacakan untuk menyelanya. Pakai headset: tanpa headset, suara jawaban sendiri bisa terbaca sebagai sela.">
          <input type="checkbox" checked={bargeByVoice} onChange={(e) => setBargeByVoice(e.target.checked)} />Sela dengan suara
        </label>
        <button type="button" onClick={onClose} className="ml-auto flex items-center gap-1 rounded border border-white/15 px-1.5 py-0.5 text-[#d3d8de] hover:bg-white/10"><Icon name="x" className="h-3 w-3" />Selesai</button>
      </div>
      <p className="mt-1.5 truncate text-[10px] text-[#8f99a8]" title={`${micName ?? ""} · dengar ${status?.transcriber ?? ""} · baca ${status?.reader ?? ""}`}>
        {tampilBiaya ? <>suara sesi ini {usd(cost)}{status ? ` · bulan ini ${usd(status.spend.usd + cost)}${status.spend.cap_usd != null ? ` dari ${usd(status.spend.cap_usd)}` : ""}` : ""}{micName ? ` · ${micName}` : ""}</> : micName ?? ""}
      </p>
    </div>
  );
}
