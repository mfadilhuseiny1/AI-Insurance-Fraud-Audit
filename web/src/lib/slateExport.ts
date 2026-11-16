/** slate.exportWidget: a widget's DOM as a PNG (the element cloned with its computed styles into an SVG foreignObject,
 *  drawn on a canvas) and that PNG as a one-page PDF (a JPEG image object written by hand). Images from other origins
 *  inside the widget are left out by the browser (a canvas with them could not be read). */

const PROPS = [
  "display", "position", "top", "left", "right", "bottom", "width", "height", "min-width", "min-height", "max-width", "max-height", "margin", "padding", "box-sizing",
  "border", "border-top", "border-right", "border-bottom", "border-left", "border-radius", "border-collapse", "background", "background-color", "color", "font", "font-family",
  "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "text-align", "text-decoration", "text-transform", "white-space", "word-break", "overflow",
  "text-overflow", "vertical-align", "opacity", "visibility", "flex", "flex-direction", "flex-wrap", "flex-grow", "flex-shrink", "flex-basis", "align-items", "align-self",
  "justify-content", "gap", "grid-template-columns", "grid-template-rows", "grid-column", "grid-row", "transform", "transform-origin", "fill", "stroke", "stroke-width",
  "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "fill-opacity", "stroke-opacity", "text-anchor", "dominant-baseline", "paint-order", "box-shadow", "object-fit", "z-index",
];

function inline(src: Element, dst: Element) {
  const cs = getComputedStyle(src);
  let css = "";
  for (const p of PROPS) {
    const v = cs.getPropertyValue(p);
    if (v) css += `${p}:${v};`;
  }
  dst.setAttribute("style", css);
  const a = src.children;
  const b = dst.children;
  for (let i = 0; i < a.length && i < b.length; i++) inline(a[i], b[i]);
}

export async function widgetPng(el: HTMLElement, scale = 2): Promise<Blob> {
  const r = el.getBoundingClientRect();
  const w = Math.max(1, Math.ceil(r.width));
  const h = Math.max(1, Math.ceil(r.height));
  if (el.querySelectorAll("*").length > 6000) throw new Error("exportWidget: the widget is too large to export");
  const clone = el.cloneNode(true) as HTMLElement;
  inline(el, clone);
  clone.style.margin = "0";
  clone.style.position = "static";
  clone.style.width = `${w}px`;
  clone.style.height = `${h}px`;
  // canvases (none of the built-in widgets, but code may add them) become images
  const canvases = el.querySelectorAll("canvas");
  clone.querySelectorAll("canvas").forEach((c, i) => {
    const img = document.createElement("img");
    try {
      img.src = canvases[i].toDataURL();
      img.setAttribute("style", c.getAttribute("style") ?? "");
      c.replaceWith(img);
    } catch {
      c.remove();
    }
  });
  clone.querySelectorAll("script,iframe").forEach((x) => x.remove());
  const bg = getComputedStyle(document.body).backgroundColor;
  const xml = new XMLSerializer().serializeToString(clone);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;height:${h}px;background:${bg}">${xml}</div></foreignObject></svg>`;
  const img = new Image();
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error("exportWidget: the widget could not be rendered"));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
  const canvas = document.createElement("canvas");
  canvas.width = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0);
  return new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("exportWidget: the image could not be read"))), "image/png"));
}

/** A one-page PDF the size of the image (72 dpi points), holding it as a JPEG. */
export async function pngToPdf(png: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(png);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0);
  const jpeg = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("exportWidget: the image could not be read"))), "image/jpeg", 0.92));
  const data = new Uint8Array(await jpeg.arrayBuffer());
  const [pw, ph] = [bmp.width / 2, bmp.height / 2];
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let at = 0;
  const push = (x: string | Uint8Array) => {
    const b = typeof x === "string" ? enc.encode(x) : x;
    parts.push(b);
    at += b.length;
  };
  const obj = (n: number, body: string) => {
    offsets[n] = at;
    push(`${n} 0 obj\n${body}\nendobj\n`);
  };
  push("%PDF-1.4\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  offsets[4] = at;
  push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${bmp.width} /Height ${bmp.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${data.length} >>\nstream\n`);
  push(data);
  push("\nendstream\nendobj\n");
  const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  const xref = at;
  push(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map((n) => `${String(offsets[n]).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts as BlobPart[], { type: "application/pdf" });
}
