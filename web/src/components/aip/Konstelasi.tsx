"use client";
import { useEffect, useRef } from "react";

/* The AIP Operator's backdrop (the user, 2026-10-28, showing a Palantir AIP still: "this is a good background"): a ring of
   connected nodes in a violet glow, turning slowly — bright on the empty screen, livelier while the operator works, faint
   behind a conversation. Canvas, no library: the glow is drawn once per size and rotated, the links are stroked in a few
   alpha bands. One still frame for readers who ask for reduced motion; paused while the page is hidden. */

type Node = { a: number; r: number; z: number; v: number; s: number; ph: number };

export function Konstelasi({ level = 1, className = "" }: { level?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const want = useRef(level);
  useEffect(() => { want.current = level; }, [level]);

  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let seed = 20261028;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    // most nodes sit on the ring, a few drift inside it
    const nodes: Node[] = Array.from({ length: 78 }, (_, i) => ({
      a: rnd() * Math.PI * 2, r: i < 56 ? 0.8 + (rnd() - 0.5) * 0.36 : 0.15 + rnd() * 0.6, z: rnd(),
      v: 0.00025 + rnd() * 0.0006, s: 0.7 + rnd() * 1.5, ph: rnd() * 6.283,
    }));
    let w = 0, h = 0, R = 0, raf = 0, lvl = want.current, repaint = 0;
    let glow: HTMLCanvasElement | null = null;
    const t0 = performance.now();

    const paintGlow = () => {
      // the ring's glow, brightest on one side, softened once; rotated per frame
      const g = document.createElement("canvas");
      const S = Math.ceil(R * 2.9);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      g.width = g.height = S * dpr;
      const c = g.getContext("2d");
      if (!c) return null;
      c.scale(dpr, dpr);
      c.translate(S / 2, S / 2);
      c.filter = `blur(${Math.max(6, R * 0.07)}px)`;
      const seg = 120;
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1.4) / seg) * Math.PI * 2;
        const k = Math.max(0, Math.cos(a0 - 0.6));
        c.strokeStyle = `rgba(${Math.round(124 + 40 * k)}, ${Math.round(92 + 30 * k)}, 246, ${0.05 + 0.5 * k ** 2.2})`;
        c.lineWidth = R * (0.07 + 0.11 * k);
        c.beginPath();
        c.arc(0, 0, R * 0.93, a0, a1);
        c.stroke();
      }
      c.filter = "none";
      for (let i = 0; i < seg; i++) {  // a thin bright rim over the glow
        const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1.2) / seg) * Math.PI * 2;
        const k = Math.max(0, Math.cos(a0 - 0.6));
        c.strokeStyle = `rgba(196, 181, 253, ${0.04 + 0.32 * k ** 3})`;
        c.lineWidth = 1.2 + 1.6 * k;
        c.beginPath();
        c.arc(0, 0, R * 0.93, a0, a1);
        c.stroke();
      }
      return g;
    };

    const size = () => {
      const b = cv.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      w = b.width; h = b.height;
      cv.width = Math.max(1, Math.round(w * dpr));
      cv.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      R = Math.min(w, h) * 0.34;
      // the blurred glow is repainted once the size settles (the backdrop grows over 0.7 s); the old one scales meanwhile
      clearTimeout(repaint);
      if (!glow) glow = R > 10 ? paintGlow() : null;
      else repaint = window.setTimeout(() => { glow = R > 10 ? paintGlow() : null; if (still) draw(t0 + 4000); }, 150);
    };

    const bands = [0.06, 0.12, 0.2, 0.3];
    const draw = (now: number) => {
      const t = (now - t0) / 1000;
      lvl += (want.current - lvl) * 0.05;
      ctx.clearRect(0, 0, w, h);
      if (R <= 10) return;
      const cx = w / 2, cy = h / 2;
      const spin = t * (0.035 + 0.07 * lvl);
      if (glow) {
        ctx.save();
        ctx.globalAlpha = 0.18 + 0.82 * lvl * (0.92 + 0.08 * Math.sin(t * (0.8 + 1.6 * lvl)));
        ctx.globalCompositeOperation = "lighter";
        ctx.translate(cx, cy);
        ctx.rotate(spin * 0.6);
        const S = R * 2.9;
        ctx.drawImage(glow, -S / 2, -S / 2, S, S);
        ctx.restore();
      }
      const pts = nodes.map((n) => {
        const a = n.a + t * n.v * 60 * (0.6 + lvl) + spin * 0.3;
        const rr = n.r * R * (1 + 0.035 * Math.sin(t * 0.7 + n.ph));
        return { x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr * 0.96, z: n.z, s: n.s };
      });
      const maxD = R * 0.42;
      const paths = bands.map(() => new Path2D());
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y;
          const d = Math.hypot(dx, dy);
          if (d > maxD) continue;
          const f = (1 - d / maxD) * (0.45 + 0.55 * Math.min(pts[i].z, pts[j].z));
          const b = f > 0.66 ? 3 : f > 0.42 ? 2 : f > 0.22 ? 1 : 0;
          paths[b].moveTo(pts[i].x, pts[i].y);
          paths[b].lineTo(pts[j].x, pts[j].y);
        }
      }
      const fade = 0.25 + 0.75 * lvl;
      ctx.lineWidth = 0.8;
      paths.forEach((p, b) => {
        ctx.strokeStyle = `rgba(220, 226, 240, ${bands[b] * 1.6 * fade})`;
        ctx.stroke(p);
      });
      for (const p of pts) {
        const r = p.s * (0.55 + 0.45 * p.z);
        ctx.fillStyle = `rgba(240, 243, 250, ${(0.35 + 0.55 * p.z) * fade})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const loop = (now: number) => {
      draw(now);
      raf = requestAnimationFrame(loop);
    };
    const ro = new ResizeObserver(() => { size(); if (still) draw(t0 + 4000); });
    ro.observe(cv);
    size();
    if (still) draw(t0 + 4000);
    else raf = requestAnimationFrame(loop);
    const vis = () => {
      cancelAnimationFrame(raf);
      if (!still && document.visibilityState === "visible") raf = requestAnimationFrame(loop);
    };
    document.addEventListener("visibilitychange", vis);
    return () => { cancelAnimationFrame(raf); clearTimeout(repaint); ro.disconnect(); document.removeEventListener("visibilitychange", vis); };
  }, []);

  return <canvas ref={ref} aria-hidden className={`pointer-events-none ${className}`} />;
}
