"use client";
import { useEffect, useState } from "react";

/**
 * Google Maps Platform untuk app ini — dua permukaan:
 *  1. Basemap 2D Satellite/Hybrid lewat Map Tiles API (perlu session token).
 *  2. Mode 3D "Google Earth" lewat Maps JavaScript API (Photorealistic 3D, gmp-map-3d).
 * Kunci dibaca dari NEXT_PUBLIC_GOOGLE_MAPS_API_KEY (web/.env.local). Tanpa kunci,
 * peta tetap memakai basemap bebas OSM/Esri dan mode 3D menampilkan petunjuk setup.
 * Buat kunci: Google Cloud Console → APIs & Services → Credentials → API key,
 * aktifkan "Maps JavaScript API" + "Map Tiles API", batasi referrer ke domain app.
 */
export const GOOGLE_MAPS_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";
export const hasGoogleMaps = () => GOOGLE_MAPS_API_KEY.length > 0;

export type GoogleMapType = "satellite" | "roadmap";
/** "hybrid" BUKAN mapType session yang valid di Map Tiles API (createSession -> 400).
 *  Hybrid = tile dasar satellite (JPEG) + tile overlay roadmap transparan (PNG,
 *  session satellite dengan layerTypes ["layerRoadmap"] & overlay: true), ditumpuk. */
export type GoogleBasemapKind = "satellite" | "hybrid";
const sessions = new Map<string, Promise<string>>();

/** Session token Map Tiles API (dicache; token berlaku ~2 minggu di sisi Google). */
function createSession(cacheKey: string, body: Record<string, unknown>): Promise<string> {
  const hit = sessions.get(cacheKey);
  if (hit) return hit;
  const p = (async () => {
    const r = await fetch(`https://tile.googleapis.com/v1/createSession?key=${GOOGLE_MAPS_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const detail = await r.json().catch(() => null);
      throw new Error(`Google Map Tiles session gagal (${r.status}): ${detail?.error?.message ?? "periksa API key & aktivasi Map Tiles API"}`);
    }
    return (await r.json()).session as string;
  })();
  sessions.set(cacheKey, p);
  p.catch(() => sessions.delete(cacheKey));
  return p;
}

export const googleBaseSession = () => createSession("satellite", { mapType: "satellite", language: "id", region: "ID" });
/** Session overlay label/jalan untuk hybrid (PNG transparan, ditumpuk di atas satellite). */
export const googleOverlaySession = () =>
  createSession("overlay", { mapType: "satellite", layerTypes: ["layerRoadmap"], overlay: true, language: "id", region: "ID" });

export const googleTileUrl = (session: string) => (z: number, x: number, y: number) =>
  `https://tile.googleapis.com/v1/2dtiles/${z}/${x}/${y}?session=${session}&key=${GOOGLE_MAPS_API_KEY}`;

/** Hook: session dasar + overlay (hybrid) untuk basemap Google; null selama memuat / tanpa kunci. */
export function useGoogleSessions(kind: GoogleBasemapKind | null): { base: string | null; overlay: string | null; error: string | null } {
  const [base, setBase] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!kind || !hasGoogleMaps()) return;
    let live = true;
    googleBaseSession().then((s) => live && setBase(s), (e: Error) => live && setError(e.message));
    if (kind === "hybrid") googleOverlaySession().then((s) => live && setOverlay(s), (e: Error) => live && setError(e.message));
    return () => { live = false; };
  }, [kind]);
  return { base, overlay, error };
}

let loader: Promise<void> | null = null;
/** Muat Maps JavaScript API (beta, library maps3d) sekali saja. */
export function loadGoogleMaps3d(): Promise<void> {
  if (loader) return loader;
  loader = new Promise((resolve, reject) => {
    if ((window as any).google?.maps) return resolve();
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}&v=beta&libraries=maps3d,marker`;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Gagal memuat Google Maps JavaScript API"));
    document.head.appendChild(s);
  });
  return loader;
}
