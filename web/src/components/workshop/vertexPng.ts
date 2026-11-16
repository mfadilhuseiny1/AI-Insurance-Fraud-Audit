// "Export as PNG" of the Vertex: Graph widget: the canvas' SVG cloned with the computed styles of its shapes inlined
// (its colors come from CSS classes), framed on the whole drawing, painted on a background and drawn on a canvas.
import { vxPngFrame } from "@/lib/workshop";

/** The styles of SVG shapes and text that classes may set. */
const SVG_PROPS = [
  "fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "opacity", "visibility", "display",
  "font-family", "font-size", "font-weight", "font-style", "text-anchor", "dominant-baseline", "paint-order", "vector-effect",
];

function inline(src: Element, dst: Element) {
  const cs = getComputedStyle(src);
  let css = "";
  for (const p of SVG_PROPS) {
    const v = cs.getPropertyValue(p);
    if (v) css += `${p}:${v};`;
  }
  dst.setAttribute("style", css);
  dst.removeAttribute("class");
  const a = src.children;
  const b = dst.children;
  for (let i = 0; i < a.length && i < b.length; i++) inline(a[i], b[i]);
}

/** The PNG of a graph drawn in `svg`: every shape in it (not only the part in view), on `background`. Hover titles are
 * left out. */
export async function vertexGraphPng(svg: SVGSVGElement, background: string): Promise<Blob> {
  const bb = svg.getBBox();
  if (!(bb.width > 0 || bb.height > 0)) throw new Error("The graph has nothing to export");
  const f = vxPngFrame({ x: bb.x, y: bb.y, width: bb.width, height: bb.height });
  const clone = svg.cloneNode(true) as SVGSVGElement;
  inline(svg, clone);
  clone.querySelectorAll("title").forEach((t) => t.remove());
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("viewBox", `${f.x} ${f.y} ${f.w} ${f.h}`);
  clone.setAttribute("width", String(f.width));
  clone.setAttribute("height", String(f.height));
  clone.setAttribute("style", "");
  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("x", String(f.x));
  bg.setAttribute("y", String(f.y));
  bg.setAttribute("width", String(f.w));
  bg.setAttribute("height", String(f.h));
  bg.setAttribute("fill", background);
  clone.insertBefore(bg, clone.firstChild);
  const markup = new XMLSerializer().serializeToString(clone);
  const img = new Image();
  const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml" }));
  try {
    await new Promise<void>((ok, bad) => {
      img.onload = () => ok();
      img.onerror = () => bad(new Error("The graph could not be drawn as an image"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = f.width;
    canvas.height = f.height;
    const ctx = canvas.getContext("2d")!;
    // the canvas painted first: no half-transparent pixels where the image's edges fall between pixels
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, f.width, f.height);
    ctx.drawImage(img, 0, 0, f.width, f.height);
    return await new Promise<Blob>((ok, bad) => canvas.toBlob((x) => (x ? ok(x) : bad(new Error("PNG export failed"))), "image/png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The background an element shows: its own colour, else the first of its ancestors' that is not transparent. */
export function opaqueBackground(el: Element | null, fallback = "#0b1220"): string {
  for (let e = el; e; e = e.parentElement) {
    const b = getComputedStyle(e).backgroundColor;
    if (b && b !== "transparent" && !/^rgba\(.*,\s*0\)$/.test(b)) return b;
  }
  return fallback;
}

/** Saves a file in the browser. */
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A file name from a graph's name (characters Windows refuses replaced). */
export const pngName = (name: string) => `${(name || "graph").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").trim().slice(0, 120) || "graph"}.png`;
