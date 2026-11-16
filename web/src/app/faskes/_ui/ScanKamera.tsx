"use client";
import { useEffect, useRef, useState } from "react";

/* The "camera": a full-screen recorded scan (the video is itself a phone camera screen, 672 x ~1500, 5 s, with sound).
   Its own back arrow and "Input Manual" button are made tappable with invisible hit areas. The scan counts as read
   when the video ends, after a short hold on its "verified" frame. */

const VIDEO = { pasien: "/faskes/scan-pasien.mp4", device: "/faskes/scan-device.mp4" } as const;
export type JenisScan = keyof typeof VIDEO;

export function ScanKamera({ jenis, onSelesai, onBatal, onManual }: { jenis: JenisScan; onSelesai: () => void; onBatal: () => void; onManual: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [perluTap, setPerluTap] = useState(false);
  const [terbaca, setTerbaca] = useState(false);
  const [gagal, setGagal] = useState(false);
  const cb = useRef({ onSelesai, onBatal });
  useEffect(() => { cb.current = { onSelesai, onBatal }; });

  const putar = () => {
    setPerluTap(false);
    ref.current?.play().catch(() => setPerluTap(true));
  };
  useEffect(() => {
    const v = ref.current;
    v?.play().catch(() => {
      // sound needs a gesture on some phones: play muted, else ask for a tap
      v.muted = true;
      v.play().catch(() => setPerluTap(true));
    });
    const k = (e: KeyboardEvent) => e.key === "Escape" && cb.current.onBatal();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  useEffect(() => {
    if (!terbaca) return;
    try { navigator.vibrate?.(50); } catch {}
    const t = setTimeout(() => cb.current.onSelesai(), 700);
    return () => clearTimeout(t);
  }, [terbaca]);

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black" role="dialog" aria-label={jenis === "pasien" ? "Scan QR gelang pasien" : "Scan QR perangkat IoT"}>
      <div className="relative h-full max-w-full overflow-hidden" style={{ aspectRatio: jenis === "pasien" ? "672 / 1504" : "672 / 1536" }}>
        <video ref={ref} src={VIDEO[jenis]} playsInline preload="auto" onEnded={() => setTerbaca(true)} onError={() => setGagal(true)} className="h-full w-full object-cover" />
        {gagal && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#0b1f1d] px-8 text-center text-white">
            <p className="text-[15px]">Tampilan kamera tidak bisa diputar di browser ini.</p>
            <button onClick={() => setTerbaca(true)} className="rounded-full bg-white px-5 py-3 text-[15px] font-semibold text-[#0f766e]">Lanjutkan, anggap QR terbaca</button>
          </div>
        )}
        {/* the video's own controls: back arrow (top left), "Input Manual" (bottom right) */}
        <button onClick={onBatal} aria-label="Batal" className="absolute left-0 top-[3%] h-[9%] w-[22%]" />
        <button onClick={onManual} aria-label="Input manual" className="absolute right-0 top-[84%] h-[13%] w-[52%]" />
        {perluTap && (
          <button onClick={putar} className="absolute inset-0 flex items-center justify-center bg-black/50">
            <span className="rounded-full bg-white px-5 py-3 text-[15px] font-semibold text-[#0f766e]">Ketuk untuk mulai scan</span>
          </button>
        )}
      </div>
    </div>
  );
}

/** Warms the browser cache so the camera opens without a blank frame. */
export function PreloadScan() {
  return (
    <div aria-hidden className="pointer-events-none fixed h-0 w-0 overflow-hidden opacity-0">
      <video src={VIDEO.pasien} preload="auto" muted playsInline />
      <video src={VIDEO.device} preload="auto" muted playsInline />
    </div>
  );
}
