"use client";
import { useEffect, useRef, useState } from "react";
import { hasGoogleMaps, loadGoogleMaps3d } from "@/lib/googleMaps";

export type EarthPoint = { lat: number; lng: number; label?: string };

/**
 * Mode 3D ala Google Earth: Photorealistic 3D map (gmp-map-3d, Maps JS API beta).
 * Titik layer digambar sebagai marker 3D. Tanpa API key, tampil petunjuk setup —
 * peta 2D tetap berfungsi penuh dengan basemap bebas.
 */
export function GoogleEarth3D({ center, points, onClose }: { center: { lat: number; lng: number }; points: EarthPoint[]; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!hasGoogleMaps() || !box.current) return;
    let live = true;
    loadGoogleMaps3d()
      .then(async () => {
        if (!live || !box.current) return;
        const host = box.current;
        host.innerHTML = "";
        const map = document.createElement("gmp-map-3d") as HTMLElement & Record<string, unknown>;
        map.setAttribute("center", `${center.lat},${center.lng},120`);
        map.setAttribute("range", "1800");
        map.setAttribute("tilt", "62");
        map.setAttribute("heading", "15");
        map.setAttribute("mode", "hybrid");
        (map as HTMLElement).style.width = "100%";
        (map as HTMLElement).style.height = "100%";
        host.appendChild(map);
        // marker 3D untuk titik layer (maks 200 agar tetap ringan)
        const { Marker3DElement } = (await (window as any).google.maps.importLibrary("maps3d")) as any;
        for (const p of points.slice(0, 200)) {
          try {
            const m = new Marker3DElement({ position: { lat: p.lat, lng: p.lng, altitude: 40 }, label: p.label ?? "" });
            map.appendChild(m);
          } catch { /* marker gagal satu tidak menghentikan peta */ }
        }
        setReady(true);
      })
      .catch((e: Error) => setErr(e.message));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="absolute inset-0 z-20 bg-ink">
      <div ref={box} className="absolute inset-0" />
      {!hasGoogleMaps() && (
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <div className="max-w-md rounded-xl border border-line bg-panel p-5 text-sm">
            <h3 className="font-semibold">Google Earth 3D belum terhubung</h3>
            <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs leading-relaxed text-muted">
              <li>Buka Google Cloud Console → APIs &amp; Services → Credentials → Create API key.</li>
              <li>Aktifkan <b className="text-soft">Maps JavaScript API</b> dan <b className="text-soft">Map Tiles API</b> (perlu billing aktif).</li>
              <li>Batasi kunci: Application restrictions → Websites, isi domain app ini.</li>
              <li>Isi <code className="rounded bg-ink px-1">NEXT_PUBLIC_GOOGLE_MAPS_API_KEY</code> di <code className="rounded bg-ink px-1">web/.env.local</code>, lalu restart web.</li>
            </ol>
            <p className="mt-2 text-xs text-muted">Tanpa kunci, basemap Google Satellite/Hybrid dan mode 3D nonaktif — peta tetap jalan dengan OpenStreetMap.</p>
          </div>
        </div>
      )}
      {err && <div className="absolute inset-x-0 top-14 mx-auto max-w-md rounded-md border border-bad/50 bg-panel/95 px-3 py-2 text-center text-xs text-bad">{err}</div>}
      {hasGoogleMaps() && !ready && !err && <div className="absolute inset-0 flex items-center justify-center text-xs text-muted">Memuat Google Earth 3D…</div>}
      <div className="absolute left-3 top-3 flex items-center gap-2">
        <span className="rounded-md bg-ink/80 px-2.5 py-1.5 text-xs font-semibold text-white">Google Earth 3D {points.length ? `· ${Math.min(points.length, 200)} titik` : ""}</span>
        <button type="button" onClick={onClose} className="rounded-md bg-panel px-2.5 py-1.5 text-xs font-medium text-soft ring-1 ring-line-2 hover:text-white">← Kembali ke 2D</button>
      </div>
      <div className="absolute bottom-1 right-2 rounded bg-ink/70 px-1 text-[10px] text-soft">Imagery © Google — seret untuk orbit, Ctrl+seret untuk tilt</div>
    </div>
  );
}
