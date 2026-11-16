import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/*
 * Token usage and LLM cost of the Extraction and Knowledge Graph tabs, for monitoring. The API
 * keeps usage in its records (data/kg/, written by api/knowledge.py) and never serves it, so
 * this reads the records directly; the UI and API run on the same machine (start.ps1).
 */

const DATA = process.env.BLUESANDAI_DATA_DIR ?? path.join(process.cwd(), "..", "data");

/** USD per million tokens (input, output) for models billed outside OpenRouter. OpenRouter
 *  returns the exact cost of each call, which the API adds up in `openrouter_cost`. */
const DIRECT_PRICES: Record<string, [number, number]> = {
  "vertex/openai/gpt-oss-120b-maas": [0.09, 0.36],
  "vertex/deepseek-ai/deepseek-v4.1-flash-maas": [0.3, 1.2],
  "gemini-3.5-flash": [1.5, 9.0],
};

export type KgUsage = {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
};

type Usage = { calls?: number; input_tokens?: number; output_tokens?: number; openrouter_cost?: number };

function cost(model: string | null, u: Usage): KgUsage {
  const [pin, pout] = (model && DIRECT_PRICES[model]) || [0, 0];
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  return {
    calls: u.calls ?? 0,
    input_tokens: input,
    output_tokens: output,
    cost_usd: (u.openrouter_cost ?? 0) + (input * pin + output * pout) / 1e6,
  };
}

async function read(folder: string, modelOf: (rec: Record<string, unknown>) => string | null) {
  const out: Record<string, KgUsage> = {};
  let names: string[] = [];
  try {
    names = await readdir(folder);
  } catch {
    return out;
  }
  await Promise.all(
    names
      .filter((n) => n.endsWith(".json") && !n.endsWith(".graph.json"))
      .map(async (n) => {
        try {
          const rec = JSON.parse(await readFile(path.join(folder, n), "utf-8"));
          if (rec.usage) out[rec.id] = cost(modelOf(rec), rec.usage);
        } catch {
          // a record being rewritten right now; it shows up on the next poll
        }
      }),
  );
  return out;
}

const API = process.env.BLUESANDAI_API_URL ?? "http://127.0.0.1:8000";

/** Signed in? The API decides (its session cookie comes with the request when the API and web share a host). */
async function signedIn(request: Request): Promise<boolean> {
  try {
    const res = await fetch(`${API}/api/auth/status`, { headers: { cookie: request.headers.get("cookie") ?? "" }, cache: "no-store" });
    const s = (await res.json()) as { enabled: boolean; user: unknown };
    return !s.enabled || !!s.user;
  } catch {
    return false;
  }
}

export async function GET(request: Request) {
  if (!(await signedIn(request))) return Response.json({ detail: "Sign in to use BluesandAI" }, { status: 401 });
  const [extractions, graphs] = await Promise.all([
    read(path.join(DATA, "kg", "extractions"), (r) => r.model as string),
    read(path.join(DATA, "kg", "graphs"), (r) => (r.resolve_model as string) ?? null),
  ]);
  return Response.json({ extractions, graphs });
}
