import type { AipEvent } from "./aipRun";

/* The pure part of the AIP voice mode (VoiceMode.tsx): what is read aloud for each run event, how an answer is cut
   into readings, and when a transcript sounds unfinished. No browser APIs, so it can be tested. Adapted from the
   voice mode of ai-muhammadiyah (lib/knowledge-graph/voice.ts). */

/** Answer text → text to read aloud: result markers [r1], markdown, bullets and link targets are not read. */
export function speakable(s: string): string {
  return s
    .replace(/\[\s*r\d+(?:\s*[,;]\s*r?\d+)*\s*\]/gi, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>|]+/g, "")
    .replace(/^\s*(?:[-•]|\d+[.)])\s+/gm, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

/** An agent's name as said aloud: "Agen Klaim & Fraud (BPJS)" → "Agen Klaim dan Fraud". */
export const spokenName = (name: string) => name.replace(/\s*\(BPJS\)\s*/g, "").replace(/\s*&\s*/g, " dan ").trim();

const join = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} dan ${xs.at(-1)}`);

/**
 * What the voice says for a run event, or null. The voice only reads what the run itself produced — the plan, the
 * answer, the validator's verdict — and never adds facts of its own.
 */
export function narration(e: AipEvent): string | null {
  switch (e.type) {
    case "plan": {
      const names = [...new Set(((e.tasks ?? []) as { name?: string }[]).map((t) => spokenName(t.name ?? "")).filter(Boolean))];
      return names.length ? `Saya minta ${join(names)} memeriksa datanya.` : null;
    }
    case "draft": {
      const text = speakable(String(e.text ?? ""));
      if (!text) return null;
      return e.revised ? `Jawaban yang sudah diperbaiki. ${text}` : text;
    }
    case "verdict": {
      const total = Number(e.total ?? 0);
      const passed = Number(e.passed ?? 0);
      if (!total) return "Validator tidak menghasilkan cek, jadi jawaban ini belum terverifikasi.";
      if (passed === total) return `Validator dari keluarga model lain memeriksa ulang ke data: ${passed} dari ${total} cek lolos.`;
      return `Validator menemukan ${total - passed} dari ${total} klaim tidak didukung data, jadi jawabannya diperbaiki.`;
    }
    default:
      return null;
  }
}

/** Short lines for a long silence while the agents work, by the run's current stage (said at most once each). */
export const PROGRESS: Record<string, string> = {
  plan: "Orkestrator sedang menyusun rencananya.",
  evidence: "Agen domain masih membaca data di Nexus.",
  write: "Datanya sudah terkumpul, jawabannya sedang ditulis.",
  validate: "Validator sedang memeriksa ulang angkanya.",
  revise: "Jawabannya sedang diperbaiki.",
  ui: "Layar hasilnya sedang disusun.",
};

export const FILLERS = ["Baik, saya teruskan ke orkestrator.", "Baik, saya minta agennya memeriksa.", "Baik, saya cek datanya dulu."];

/** Readings of an answer: the first sentence alone so the voice starts soon, then about 300 characters each. */
export function speechChunks(text: string): string[] {
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((x) => x.trim())
    .filter((x) => /[\p{L}\p{N}]/u.test(x));
  const out: string[] = [];
  let buffer = "";
  for (const s of sentences) {
    if (!out.length && !buffer) {
      out.push(s);
      continue;
    }
    buffer = buffer ? `${buffer} ${s}` : s;
    if (buffer.length >= 300) {
      out.push(buffer);
      buffer = "";
    }
  }
  if (buffer) out.push(buffer);
  return out;
}

/** Words that almost never end a finished question: the speaker is probably still thinking, not done. */
const CONTINUATION = new Set(
  (
    "dan atau tapi tetapi namun terus lalu kemudian kalau jika apabila bila yang untuk dengan karena sebab sama " +
    "jadi misalnya contohnya seperti kayak terhadap tentang soal mengenai apakah bagaimana gimana kenapa mengapa " +
    "di ke dari pada oleh per eh em emm hmm ehm anu maksudnya maksud saya"
  ).split(" "),
);

/** A transcript that sounds unfinished: it ends with a comma, an ellipsis or a joining word. */
export function soundsUnfinished(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/(,|…|\.\.\.|-|—)$/.test(t)) return true;
  const last = (/[.!?]$/.test(t) ? t.slice(0, -1) : t).trim().split(/\s+/).at(-1)?.toLowerCase().replace(/[^\p{L}]/gu, "") ?? "";
  return CONTINUATION.has(last);
}

/** Vocabulary hints sometimes come back as the whole transcript of near-silence: treat that as silence. */
export function echoesHint(text: string, hint: string): boolean {
  const words = text.toLowerCase().match(/[\p{L}']{3,}/gu) ?? [];
  if (!words.length) return true;
  const known = new Set(hint.toLowerCase().match(/[\p{L}']{3,}/gu));
  return words.filter((w) => known.has(w)).length / words.length > 0.6;
}
