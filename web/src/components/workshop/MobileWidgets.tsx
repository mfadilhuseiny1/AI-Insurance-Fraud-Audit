"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { Field } from "@/components/ontology/parts";
import { inputClass } from "@/components/pipeline/Modal";
import { workshop, type Column, type Module, type ModuleSettings, type NavItem, type Widget, type WidgetConfig } from "@/lib/workshop";
import type { ModuleState } from "./WidgetView";
import { EventsEditor } from "./WorkshopConfig";

/** Workshop mobile: the device type, the bottom navigation bar, the QR Code Reader and the Current Location Manager. */

export const MOBILE_TYPES = new Set(["qr_reader", "current_location"]);
export const isMobile = (mod: Module | null | undefined) => mod?.settings?.mobile?.device === "mobile";
/** the phone size the editor shows a mobile module at */
export const PHONE = { w: 390, h: 760 };
export const NAV_ICONS: IconName[] = ["home", "list", "table", "search", "filter", "cube", "globe", "camera", "bell", "star", "doc", "clock", "gauge", "comment", "folder", "grid", "info", "edit", "check", "alert", "device"];
const MAX_NAV = 4;

/** Mobile-friendly controls: touch-sized inputs and buttons (16px text avoids zoom on focus in iOS), action forms and
 * dialogs as full-screen bottom drawers, drawers no wider than the screen. */
export const MOBILE_CSS = `
.ws-mobile input:not([type=checkbox]):not([type=radio]):not([type=color]),.ws-mobile select,.ws-mobile textarea{min-height:40px;font-size:16px}
.ws-mobile [data-widget] button{min-height:36px}
.ws-mobile input[type=checkbox],.ws-mobile input[type=radio]{width:18px;height:18px}
.ws-mobile .fixed.inset-0.z-50{padding:0;align-items:flex-end}
.ws-mobile .fixed.inset-0.z-50>div{max-width:100%;max-height:100%;height:100%;border-radius:0}
.ws-mobile [data-overlay]>div{max-width:100%}
`;

const Msg = ({ children }: { children: React.ReactNode }) => <div className="flex h-full items-center justify-center p-2 text-center text-xs text-muted">{children}</div>;

// ------------------------------------------------------------------------------------------------
// QR Code Reader
// ------------------------------------------------------------------------------------------------

/** BarcodeDetector format names (the API's), barcode formats offered for the barcode scanner */
export const BARCODE_FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "code_93", "codabar", "itf", "pdf417", "data_matrix", "aztec"];
type Detector = { detect: (src: CanvasImageSource | Blob) => Promise<{ rawValue: string; format: string }[]> };
type DetectorCtor = { new (o: { formats: string[] }): Detector; getSupportedFormats: () => Promise<string[]> };

/** The browser's BarcodeDetector for these formats when it supports them all, else null (the API decodes frames). */
async function nativeDetector(formats: string[]): Promise<Detector | null> {
  const D = (globalThis as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
  if (!D) return null;
  try {
    const ok = await D.getSupportedFormats();
    const want = formats.filter((f) => ok.includes(f));
    return want.length ? new D({ formats: want }) : null;
  } catch {
    return null;
  }
}

const formatsOf = (c: WidgetConfig) => (c.qr_kind === "barcode" ? (c.barcode_formats?.length ? c.barcode_formats : BARCODE_FORMATS) : ["qr_code"]);

export function QrReaderWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const c = widget.config;
  const b = c.qr_button ?? {};
  const [open, setOpen] = useState(false);
  const out = c.qr_output ? state.variables[c.qr_output] : undefined;
  const count = Array.isArray(out) ? out.length : out ? 1 : 0;
  const style =
    b.style === "minimal" ? "text-ocean hover:bg-ocean/10" : b.style === "secondary" ? "border border-line-2 bg-panel-2 text-soft hover:text-white" : "bg-ocean text-white hover:bg-ocean/90";
  return (
    <div className={`flex h-full items-center gap-2 p-1 ${b.fill ? "" : "justify-start"}`} data-qr-reader>
      <button
        type="button"
        disabled={editing || !c.qr_output}
        onClick={() => setOpen(true)}
        className={`flex items-center justify-center gap-2 rounded-lg disabled:opacity-50 ${style} ${b.large ? "min-h-11 px-4 text-sm" : "px-3 py-1.5 text-xs"} ${b.fill ? "h-full w-full" : ""}`}
        title={!c.qr_output ? "Choose the output variable in the panel" : undefined}
        data-qr-open
      >
        <Icon name={(b.icon as IconName) || "camera"} className={b.large ? "h-4 w-4" : "h-3.5 w-3.5"} />
        {b.label ?? (c.qr_kind === "barcode" ? "Scan barcode" : "Scan QR code")}
      </button>
      {!b.fill && count > 0 && (
        <span className="truncate text-[11px] text-muted" data-qr-count>
          {Array.isArray(out) ? `${count} scanned` : String(out)}
        </span>
      )}
      {open && (
        <Scanner
          c={c}
          onClose={() => setOpen(false)}
          onDone={(codes) => {
            setOpen(false);
            if (!c.qr_output || !codes.length) return;
            state.setVariable(c.qr_output, c.qr_multiple ? codes : codes[0]);
            if (c.qr_events?.length) void state.runEvents?.(c.qr_events);
          }}
        />
      )}
    </div>
  );
}

/** The full-screen camera view: detects codes in the video (BarcodeDetector, else the API on a frame every 0.6 s), or in a
 * photo; one code ends the scan, several are collected until Done; with a prompt each detected code waits for "Scan code". */
function Scanner({ c, onClose, onDone }: { c: WidgetConfig; onClose: () => void; onDone: (codes: string[]) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [camera, setCamera] = useState<"starting" | "on" | "off">("starting");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [engine, setEngine] = useState<"browser" | "server" | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const formats = formatsOf(c);
  const kind = c.qr_kind === "barcode" ? "barcode" : "qr";
  // the latest handlers for the detection loop
  const found = useRef<(v: string) => void>(() => {});
  const accept = (v: string) => {
    if (!c.qr_multiple) return onDone([v]);
    setCodes((xs) => (xs.includes(v) ? xs : [...xs, v]));
    setNote(`Scanned: ${v}`);
  };
  useEffect(() => {
    found.current = (v: string) => {
      if (c.qr_prompt) setPending((p) => p ?? v);
      else if (!codes.includes(v)) accept(v);
    };
  });

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const canvas = document.createElement("canvas");
    (async () => {
      const det = await nativeDetector(formats);
      if (stopped) return;
      setEngine(det ? "browser" : "server");
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      } catch (e) {
        if (!stopped) {
          setCamera("off");
          setCameraError((e as Error).name === "NotAllowedError" ? "Camera access was denied." : "No camera is available.");
        }
        return;
      }
      if (stopped) return stream.getTracks().forEach((t) => t.stop());
      const v = video.current!;
      v.srcObject = stream;
      await v.play().catch(() => {});
      setCamera("on");
      const tick = async () => {
        if (stopped) return;
        if (v.readyState >= 2 && v.videoWidth) {
          try {
            let values: string[] = [];
            if (det) values = (await det.detect(v)).filter((x) => formats.includes(x.format)).map((x) => x.rawValue);
            else {
              canvas.width = v.videoWidth;
              canvas.height = v.videoHeight;
              canvas.getContext("2d")!.drawImage(v, 0, 0);
              const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.85));
              if (blob) values = (await workshop.decodeCodes(blob, kind)).codes.filter((x) => kind === "qr" || formats.includes(x.format)).map((x) => x.value);
            }
            if (!stopped) values.forEach((x) => found.current(x));
          } catch {
            // a frame that fails to decode: try the next one
          }
        }
        timer = setTimeout(tick, det ? 250 : 600);
      };
      void tick();
    })();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
    // the camera runs once per open scanner
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const photo = async (file: File | undefined) => {
    if (!file) return;
    setNote("Reading the photo…");
    try {
      const det = await nativeDetector(formats);
      const values = det
        ? (await det.detect(await createImageBitmap(file))).filter((x) => formats.includes(x.format)).map((x) => x.rawValue)
        : (await workshop.decodeCodes(file, kind)).codes.filter((x) => kind === "qr" || formats.includes(x.format)).map((x) => x.value);
      if (!values.length) return setNote("No code found in the photo.");
      setNote(null);
      values.forEach((x) => found.current(x));
    } catch (e) {
      setNote((e as Error).message);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-black text-white" data-qr-scanner>
      <div className="flex items-center gap-2 px-4 py-3 text-sm">
        <Icon name="camera" className="h-4 w-4" />
        <span className="flex-1">{kind === "barcode" ? "Scan barcodes" : "Scan QR codes"}</span>
        <button type="button" onClick={onClose} className="rounded p-1 hover:bg-white/10" aria-label="Close" data-qr-close>
          <Icon name="x" className="h-5 w-5" />
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        <video ref={video} muted playsInline className={`h-full w-full object-cover ${camera === "on" ? "" : "hidden"}`} data-qr-video />
        {camera === "on" && <div className="pointer-events-none absolute left-1/2 top-1/2 h-56 w-56 -translate-x-1/2 -translate-y-1/2 rounded-2xl border-4 border-white/80" />}
        {camera !== "on" && (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-white/80">
            {camera === "starting" ? "Starting the camera…" : cameraError}
            {camera === "off" && <span className="text-xs text-white/60">Take or choose a photo of the code instead.</span>}
          </div>
        )}
      </div>
      <div className="space-y-2 bg-black/90 px-4 py-3 text-sm">
        {pending && (
          <div className="flex items-center gap-2 rounded-lg bg-white/10 px-3 py-2" data-qr-pending>
            <span className="min-w-0 flex-1 truncate font-mono">{pending}</span>
            <button type="button" onClick={() => (accept(pending), setPending(null))} className="min-h-10 rounded-lg bg-ocean px-4" data-qr-confirm>
              Scan code
            </button>
            <button type="button" onClick={() => setPending(null)} className="min-h-10 rounded-lg px-2 text-white/70">
              Skip
            </button>
          </div>
        )}
        {note && <div className="text-xs text-white/70" data-qr-note>{note}</div>}
        {c.qr_multiple && codes.length > 0 && (
          <div className="max-h-24 overflow-y-auto text-xs text-white/80" data-qr-codes>
            {codes.map((x) => (
              <div key={x} className="flex items-center gap-1 font-mono">
                <Icon name="check" className="h-3 w-3 text-ok" /> {x}
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <label className="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border border-white/30 px-3 text-xs">
            <Icon name="image" className="h-4 w-4" /> Photo
            <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => void photo(e.target.files?.[0])} data-qr-photo />
          </label>
          <span className="flex-1 text-[10px] text-white/50">{engine === "browser" ? "Detected in the browser" : engine === "server" ? "Decoded by the platform" : ""}</span>
          {c.qr_multiple && (
            <button type="button" onClick={() => onDone(codes)} disabled={!codes.length} className="min-h-10 rounded-lg bg-ocean px-4 disabled:opacity-40" data-qr-done>
              Done ({codes.length})
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Current Location Manager
// ------------------------------------------------------------------------------------------------

type Fix = { lat: number; lon: number; accuracy: number };
type Place = { label: string; lat: number; lon: number };

function km(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

/** Watches the device's location while it is mounted (its page is open): "lat,long" into the output variable; the preview
 * shows the coordinates and, with a source, the nearest place (a local lookup: no location leaves the platform). */
export function CurrentLocationWidget({ widget, state, editing }: { widget: Widget; state: ModuleState; editing: boolean }) {
  const c = widget.config;
  const [fix, setFix] = useState<Fix | null>(null);
  const [problem, setProblem] = useState<"denied" | "unavailable" | "unsupported" | null>(null);
  const [places, setPlaces] = useState<Place[]>([]);
  const setVar = useRef(state.setVariable);
  useEffect(() => {
    setVar.current = state.setVariable;
  });
  const out = c.location_output;
  useEffect(() => {
    if (editing || !out) return;
    if (!("geolocation" in navigator)) {
      queueMicrotask(() => setProblem("unsupported"));
      return;
    }
    let last = "";
    const id = navigator.geolocation.watchPosition(
      (p) => {
        const v = `${p.coords.latitude.toFixed(6)},${p.coords.longitude.toFixed(6)}`;
        setProblem(null);
        setFix({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy });
        if (v !== last) setVar.current(out, (last = v));
      },
      (e) => setProblem(e.code === e.PERMISSION_DENIED ? "denied" : "unavailable"),
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [editing, out]);
  const src = c.source;
  const placeKey = src && c.place_lat && c.place_lon && !c.hide_location ? JSON.stringify([src, c.place_label, c.place_lat, c.place_lon]) : "";
  useEffect(() => {
    if (!placeKey || !src) return;
    let stale = false;
    const cols = [c.place_label, c.place_lat, c.place_lon].filter((x): x is string => !!x);
    workshop
      .query({ source: src, columns: cols, limit: 5000 })
      .then((r) => {
        if (stale) return;
        const ps = (r.rows ?? []).map((x) => ({ label: String(x[c.place_label ?? ""] ?? x.__pk ?? ""), lat: Number(x[c.place_lat!]), lon: Number(x[c.place_lon!]) })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
        setPlaces(ps);
      }, () => !stale && setPlaces([]));
    return () => {
      stale = true;
    };
    // the key holds the source and its columns
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeKey]);
  if (!out) return <Msg>Choose the location output variable in the panel</Msg>;
  if (c.hide_location && !problem) return editing ? <Msg>Location (hidden in view mode)</Msg> : <div className="h-full" data-current-location="hidden" />;
  const nearest = fix && places.length ? places.map((p) => ({ ...p, d: km(fix, p) })).sort((a, b) => a.d - b.d)[0] : null;
  const preview = editing
    ? "The detected location shows here"
    : problem === "denied"
      ? null
      : fix
        ? `${nearest ? `Near ${nearest.label} (${nearest.d < 1 ? `${Math.round(nearest.d * 1000)} m` : `${nearest.d.toFixed(1)} km`}) · ` : ""}${fix.lat.toFixed(5)}, ${fix.lon.toFixed(5)} (±${Math.round(fix.accuracy)} m)`
        : problem === "unsupported"
          ? "This browser cannot share a location"
          : problem === "unavailable"
            ? "The location is not available yet"
            : "Detecting your location…";
  return (
    <div className="flex h-full items-center gap-2 overflow-hidden px-2 text-xs" data-current-location={problem ?? (fix ? "ok" : "waiting")}>
      {problem === "denied" ? (
        <span className="flex items-center gap-1.5 text-warn" data-location-denied>
          <Icon name="alert" className="h-3.5 w-3.5 shrink-0" /> Location access was denied: no current location is set.
        </span>
      ) : (
        <>
          <Icon name="globe" className={`h-3.5 w-3.5 shrink-0 ${fix ? "text-ok" : "text-muted"}`} />
          {c.location_label !== "" && <span className="shrink-0 text-muted">{c.location_label ?? "Current location"}</span>}
          <span className="truncate" data-location-preview>
            {preview}
          </span>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Mobile Navigation Bar
// ------------------------------------------------------------------------------------------------

const pagesOf = (it: NavItem): string[] =>
  [...(it.events ?? []), ...(it.items ?? []).flatMap((x) => x.events)].flatMap((e) => (e.kind === "go_page" && "page" in e ? [String((e as { page: string }).page)] : []));

/** Up to four items at the bottom of the screen: single items run events, submenus open a bottom sheet of items. Stack
 * navigation: the item of the page shown is highlighted, and stays so on pages reached from it. */
export function MobileNavBar({ mod, state, page, editing }: { mod: Module; state: ModuleState; page: string; editing: boolean }) {
  const nav = mod.settings?.mobile?.navbar;
  const items = (nav?.items ?? []).slice(0, MAX_NAV);
  const [active, setActive] = useState<number | null>(null);
  const [menu, setMenu] = useState<number | null>(null);
  const [seen, setSeen] = useState<string | null>(null);
  // the item of the page now shown becomes the active one (pages without an item keep the last one)
  if (seen !== page) {
    setSeen(page);
    const hit = items.findIndex((it) => pagesOf(it).includes(page));
    if (hit >= 0 && hit !== active) setActive(hit);
  }
  if (!isMobile(mod) || !nav?.visible || !items.length) return null;
  const run = (events: NavItem["events"]) => {
    if (!editing && events?.length) void state.runEvents?.(events);
  };
  const height = nav.height ?? 56;
  return (
    <>
      {menu !== null && items[menu] && (
        <div className="fixed inset-0 z-50 flex items-end bg-ink/60" onClick={() => setMenu(null)} data-nav-submenu>
          <div className="w-full rounded-t-2xl border-t border-line bg-panel pb-2 pt-1" onClick={(e) => e.stopPropagation()}>
            <div className="mx-auto mb-1 h-1 w-10 rounded bg-line-2" />
            <div className="px-4 py-2 text-xs font-semibold text-muted">{state.tr?.(items[menu].label) ?? items[menu].label}</div>
            {(items[menu].items ?? []).map((x, i) => (
              <button
                key={i}
                type="button"
                onClick={() => (setActive(menu), setMenu(null), run(x.events))}
                className="flex min-h-12 w-full items-center gap-3 px-4 text-left text-sm hover:bg-panel-2"
                data-nav-subitem={i}
              >
                <Icon name={(x.icon as IconName) || "right"} className="h-4 w-4 text-muted" /> {state.tr?.(x.label) ?? x.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <nav className="flex shrink-0 items-stretch border-t border-line bg-panel" style={{ height, paddingBottom: "env(safe-area-inset-bottom)" }} data-mobile-navbar>
        {items.map((it, i) => {
          const on = active === i;
          return (
            <button
              key={i}
              type="button"
              onClick={() => (it.type === "submenu" ? setMenu(i) : (setActive(i), run(it.events)))}
              className={`flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 ${on ? "text-ocean" : "text-muted hover:text-white"}`}
              aria-current={on ? "page" : undefined}
              data-nav-item={i}
              data-active={on ? "true" : undefined}
            >
              <Icon name={(it.icon as IconName) || (it.type === "submenu" ? "dots" : "grid")} className="h-5 w-5" />
              {!nav.hide_text && <span className="max-w-full truncate px-1 text-[11px]">{state.tr?.(it.label) ?? it.label}</span>}
            </button>
          );
        })}
      </nav>
    </>
  );
}

// ------------------------------------------------------------------------------------------------
// configuration: the device type and navigation bar (module settings), the widgets
// ------------------------------------------------------------------------------------------------

const lab = "text-[11px] text-muted";
function IconSelect({ value, onChange }: { value?: string; onChange: (v: string | undefined) => void }) {
  return (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} className={`${inputClass} text-xs`}>
      <option value="">Default icon</option>
      {NAV_ICONS.map((n) => (
        <option key={n}>{n}</option>
      ))}
    </select>
  );
}

export function MobileSettingsPanel({ mod, setMod }: { mod: Module; setMod: (m: Module) => void }) {
  const mob = mod.settings?.mobile ?? {};
  const nav = mob.navbar ?? {};
  const items = nav.items ?? [];
  const setMob = (x: Partial<NonNullable<ModuleSettings["mobile"]>>) => setMod({ ...mod, settings: { ...mod.settings, mobile: { ...mob, ...x } } });
  const setNav = (x: Partial<NonNullable<NonNullable<ModuleSettings["mobile"]>["navbar"]>>) => setMob({ navbar: { ...nav, ...x } });
  const setItem = (i: number, x: Partial<NavItem>) => setNav({ items: items.map((it, j) => (j === i ? { ...it, ...x } : it)) });
  return (
    <div data-mobile-settings>
      <div className="mb-1 font-semibold uppercase tracking-wide text-muted">Device type</div>
      <div className="flex gap-1">
        {(["desktop", "mobile"] as const).map((d) => (
          <button key={d} type="button" onClick={() => setMob({ device: d })} className={`flex-1 rounded border px-2 py-1 ${(mob.device ?? "desktop") === d ? "border-ocean bg-ocean/15 text-white" : "border-line-2 text-muted"}`} data-device={d}>
            <Icon name="device" className="inline h-3 w-3" /> {d === "desktop" ? "Desktop" : "Mobile"}
          </button>
        ))}
      </div>
      {mob.device === "mobile" && (
        <div className="mt-2 space-y-2">
          <p className="text-muted">
            Edited at phone size in one column (widgets in order, full width); listed in the mobile app launcher at <Link href="/m" className="text-ocean">/m</Link>. Action forms open as full-screen drawers.
          </p>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={!!nav.visible} onChange={(e) => setNav({ visible: e.target.checked })} data-navbar-visible /> Module navigation bar visible
          </label>
          {nav.visible && (
            <div className="space-y-2 rounded border border-line p-2">
              <label className={lab}>
                Title (the browser tab)
                <input value={nav.title ?? ""} onChange={(e) => setNav({ title: e.target.value || undefined })} placeholder={mod.name} className={`${inputClass} mt-1 text-xs`} />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className={lab}>
                  Icon (in the launcher)
                  <IconSelect value={nav.icon} onChange={(v) => setNav({ icon: v })} />
                </label>
                <label className={lab}>
                  Height (px)
                  <input type="number" min={40} max={96} value={nav.height ?? 56} onChange={(e) => setNav({ height: Math.max(40, Math.min(96, Number(e.target.value) || 56)) })} className={`${inputClass} mt-1 text-xs`} />
                </label>
              </div>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={!!nav.hide_text} onChange={(e) => setNav({ hide_text: e.target.checked })} /> Hide menu text
              </label>
              <div className={lab}>Navigation items (up to {MAX_NAV})</div>
              {items.map((it, i) => (
                <div key={i} className="space-y-1 rounded border border-line-2 p-2" data-nav-config={i}>
                  <div className="flex items-center gap-1">
                    <span className="flex-1 font-semibold text-soft">Item {i + 1}</span>
                    <select value={it.type} onChange={(e) => setItem(i, { type: e.target.value as NavItem["type"] })} className="rounded border border-line-2 bg-ink px-1 py-0.5 text-xs">
                      <option value="single">Single</option>
                      <option value="submenu">Submenu</option>
                    </select>
                    <button type="button" onClick={() => setNav({ items: items.filter((_, j) => j !== i) })} className="px-1 text-muted hover:text-bad" title="Remove">
                      ✕
                    </button>
                  </div>
                  <input value={it.label} onChange={(e) => setItem(i, { label: e.target.value })} placeholder="Label" className={`${inputClass} text-xs`} />
                  <IconSelect value={it.icon} onChange={(v) => setItem(i, { icon: v })} />
                  {it.type === "single" ? (
                    <EventsEditor events={it.events ?? []} mod={mod} onChange={(ev) => setItem(i, { events: ev })} label="On select" />
                  ) : (
                    <div className="space-y-1 pl-2">
                      {(it.items ?? []).map((x, k) => (
                        <div key={k} className="space-y-1 border-l border-line pl-2">
                          <div className="flex gap-1">
                            <input value={x.label} onChange={(e) => setItem(i, { items: (it.items ?? []).map((y, m) => (m === k ? { ...y, label: e.target.value } : y)) })} placeholder="Item label" className={`${inputClass} min-w-0 flex-1 text-xs`} />
                            <button type="button" onClick={() => setItem(i, { items: (it.items ?? []).filter((_, m) => m !== k) })} className="px-1 text-muted hover:text-bad">
                              ✕
                            </button>
                          </div>
                          <IconSelect value={x.icon} onChange={(v) => setItem(i, { items: (it.items ?? []).map((y, m) => (m === k ? { ...y, icon: v } : y)) })} />
                          <EventsEditor events={x.events} mod={mod} onChange={(ev) => setItem(i, { items: (it.items ?? []).map((y, m) => (m === k ? { ...y, events: ev } : y)) })} label="On select" />
                        </div>
                      ))}
                      <button type="button" onClick={() => setItem(i, { items: [...(it.items ?? []), { label: `Item ${(it.items ?? []).length + 1}`, events: [] }] })} className="text-ocean">
                        + Submenu item
                      </button>
                    </div>
                  )}
                </div>
              ))}
              <button type="button" disabled={items.length >= MAX_NAV} onClick={() => setNav({ items: [...items, { type: "single", label: `Item ${items.length + 1}`, events: [] }] })} className="text-ocean disabled:opacity-40" data-nav-add>
                + Navigation item
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function MobileWidgetConfig({ widget, set, mod, cols }: { widget: Widget; set: (x: Partial<WidgetConfig>) => void; mod: Module; cols: Column[] }) {
  const c = widget.config;
  const vars = mod.variables ?? [];
  const varSel = (k: keyof WidgetConfig, label: string, types: string[]) => (
    <Field label={label}>
      <select value={(c[k] as string | undefined) ?? ""} onChange={(e) => set({ [k]: e.target.value || undefined })} className={inputClass} data-mobile-var={k}>
        <option value="">None</option>
        {vars.filter((v) => types.includes(v.type)).map((v) => (
          <option key={v.name}>{v.name}</option>
        ))}
      </select>
    </Field>
  );
  if (widget.type === "qr_reader") {
    const b = c.qr_button ?? {};
    const setB = (x: Partial<NonNullable<WidgetConfig["qr_button"]>>) => set({ qr_button: { ...b, ...x } });
    return (
      <div className="space-y-2 text-xs" data-qr-config>
        <Field label="Code scanner type">
          <select value={c.qr_kind ?? "qr"} onChange={(e) => set({ qr_kind: e.target.value as "qr" | "barcode" })} className={inputClass}>
            <option value="qr">QR code scanner</option>
            <option value="barcode">Barcode scanner</option>
          </select>
        </Field>
        {c.qr_kind === "barcode" && (
          <div>
            <div className={lab}>Barcode formats (none chosen: all)</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {BARCODE_FORMATS.map((f) => {
                const on = (c.barcode_formats ?? []).includes(f);
                return (
                  <button key={f} type="button" onClick={() => set({ barcode_formats: on ? (c.barcode_formats ?? []).filter((x) => x !== f) : [...(c.barcode_formats ?? []), f] })} className={`rounded border px-1.5 py-0.5 ${on ? "border-ocean bg-ocean/15 text-white" : "border-line-2 text-muted"}`}>
                    {f.toUpperCase().replace(/_/g, " ")}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-muted">PDF417, Data Matrix and Aztec need a browser with BarcodeDetector (Chrome on Android, Safari 17+ on macOS); the others are also decoded by the platform.</p>
          </div>
        )}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={!!c.qr_multiple} onChange={(e) => set({ qr_multiple: e.target.checked, qr_output: undefined })} /> Multiple codes (a string array)
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={!!c.qr_prompt} onChange={(e) => set({ qr_prompt: e.target.checked })} /> Prompt before scanning (a “Scan code” button per code)
        </label>
        {varSel("qr_output", c.qr_multiple ? "Output (a string array variable)" : "Output (a string variable)", c.qr_multiple ? ["array"] : ["string"])}
        <div className={lab}>Button</div>
        <input value={b.label ?? ""} onChange={(e) => setB({ label: e.target.value || undefined })} placeholder={c.qr_kind === "barcode" ? "Scan barcode" : "Scan QR code"} className={`${inputClass} text-xs`} />
        <div className="grid grid-cols-2 gap-2">
          <select value={b.style ?? "primary"} onChange={(e) => setB({ style: e.target.value as "primary" })} className={`${inputClass} text-xs`}>
            <option value="primary">Primary</option>
            <option value="secondary">Secondary</option>
            <option value="minimal">Minimal</option>
          </select>
          <IconSelect value={b.icon} onChange={(v) => setB({ icon: v })} />
        </div>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={!!b.large} onChange={(e) => setB({ large: e.target.checked })} /> Large style
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={!!b.fill} onChange={(e) => setB({ fill: e.target.checked })} /> Fill available space
        </label>
        <EventsEditor events={c.qr_events ?? []} mod={mod} onChange={(ev) => set({ qr_events: ev })} label="After scanning" />
      </div>
    );
  }
  if (widget.type === "current_location") {
    const colSel = (k: "place_label" | "place_lat" | "place_lon", label: string) => (
      <Field label={label}>
        <select value={c[k] ?? ""} onChange={(e) => set({ [k]: e.target.value || undefined })} className={inputClass}>
          <option value="">None</option>
          {cols.map((x) => (
            <option key={x.name} value={x.name}>
              {x.name}
            </option>
          ))}
        </select>
      </Field>
    );
    return (
      <div className="space-y-2 text-xs" data-location-config>
        <Field label="Label (empty: none)">
          <input value={c.location_label ?? "Current location"} onChange={(e) => set({ location_label: e.target.value })} className={inputClass} />
        </Field>
        {varSel("location_output", "Location output variable (a string: lat,long)", ["string"])}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={!!c.hide_location} onChange={(e) => set({ hide_location: e.target.checked })} /> Hide location display (still asks for the location)
        </label>
        {!c.hide_location && (
          <>
            <p className="text-muted">Nearest place (optional): choose a source above with latitude / longitude columns; the preview names the closest row. The lookup runs here: the location is not sent to a geocoding service.</p>
            {c.source && (
              <>
                {colSel("place_label", "Place label")}
                <div className="grid grid-cols-2 gap-2">
                  {colSel("place_lat", "Latitude")}
                  {colSel("place_lon", "Longitude")}
                </div>
              </>
            )}
          </>
        )}
      </div>
    );
  }
  return null;
}
