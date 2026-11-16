import { API_URL } from "@/lib/api";

export type TtsSpend = { month: string; usd: number; calls: number; cap_usd: number | null };
export type TtsStatus = { configured: boolean; provider?: string; models: string[]; default?: string; error?: string; spend?: TtsSpend };
export type TtsVoice = { name: string; style: string; gender: "female" | "male" | "neutral" };
export type TtsEstimate = { seconds: number; usd: number };
export type TtsJob = {
  id: string;
  title: string;
  voice: string;
  model: string;
  style: string;
  status: "running" | "completed" | "failed" | "cancelled";
  done: number;
  chunks: number;
  characters: number;
  seconds?: number;
  error: string | null;
  created_at: number;
  /** what the readings cost so far (OpenAI) */
  usd?: number;
  estimate?: TtsEstimate;
  /** chunks the model did not read word for word (by its own transcript), 1-based */
  drift?: { chunk: number; similarity: number }[];
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(API_URL + path, { cache: "no-store", ...init });
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json() as Promise<T>;
}

async function errorMessage(response: Response) {
  try {
    const body = await response.json();
    return typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? body);
  } catch {
    return response.statusText;
  }
}

const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const tts = {
  status: () => request<TtsStatus>("/api/tts/status"),
  voices: (model: string) => request<TtsVoice[]>(`/api/tts/voices?model=${encodeURIComponent(model)}`),
  prepare: (markdown: string, model: string) =>
    request<{ text: string; characters: number; chunks: number; estimate: TtsEstimate | Record<string, never> }>("/api/tts/prepare", json({ markdown, model })),
  jobs: () => request<TtsJob[]>("/api/tts/jobs"),
  job: (id: string) => request<TtsJob>(`/api/tts/jobs/${id}`),
  create: (body: { markdown: string; voice: string; model: string; style: string; title: string }) => request<TtsJob>("/api/tts/jobs", json(body)),
  cancel: (id: string) => request<TtsJob>(`/api/tts/jobs/${id}/cancel`, { method: "POST" }),
  retry: (id: string) => request<TtsJob>(`/api/tts/jobs/${id}/retry`, { method: "POST" }),
  /** audio of a finished job as an object URL */
  audio: async (id: string) => {
    const response = await fetch(`${API_URL}/api/tts/jobs/${id}/audio`, { cache: "no-store" });
    if (!response.ok) throw new Error(await errorMessage(response));
    return URL.createObjectURL(await response.blob());
  },
  sample: async (voice: string, model: string) => {
    const response = await fetch(`${API_URL}/api/tts/sample`, json({ voice, model }));
    if (!response.ok) throw new Error(await errorMessage(response));
    return URL.createObjectURL(await response.blob());
  },
};
