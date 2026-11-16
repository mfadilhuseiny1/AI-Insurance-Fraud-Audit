/**
 * Use LLM node: the prompt templates (classification, summarization, translation, sentiment, entity
 * extraction, empty prompt), the JSON schema each answer must follow, and the node's evaluation.
 *
 * The evaluator is synchronous, so answers come from `Services`: each row's prompt is hashed into a key,
 * known answers are looked up, missing ones are requested (the caller sends them to the API in batches
 * and evaluates again). The API keeps answers by key, which is what "Skip recomputing rows" reuses.
 */
import {
  LLM_PREVIEW_ROWS,
  type Cell,
  type ColType,
  type EvalOptions,
  type LlmConfig,
  type LlmEntity,
  type LlmOutputType,
  type NodeResult,
  type Row,
  type Table,
} from "./pipeline";

export type LlmModel = { id: string; label: string; vendor: string; vision: boolean; registered?: boolean; description?: string };

/** Models offered by the node; the API maps them to providers (prices stay server-side). The open-weight models run on
 *  Vertex AI behind the platform's spend guard (api/aip/models.py is the registry; GET /api/aip/models lists it). */
export const LLM_MODELS: LlmModel[] = [
  { id: "vertex/openai/gpt-oss-120b-maas", label: "gpt-oss-120b (open)", vendor: "OpenAI · open weights", vision: false, description: "Open model on Vertex AI, lowest cost: the default for row-by-row work." },
  { id: "vertex/deepseek-ai/deepseek-v4.1-flash-maas", label: "DeepSeek V4.1 Flash (open)", vendor: "DeepSeek · open weights", vision: false, description: "Open model on Vertex AI, fast on long text, strong in Indonesian." },
  { id: "vertex/zai-org/glm-5.2-maas", label: "GLM-5.2 (open)", vendor: "Z.ai · open weights", vision: false, description: "Open model on Vertex AI, strongest reasoning, highest price of the open models." },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", vendor: "Google", vision: true, description: "Fast, multilingual, reads images." },
  { id: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5", vendor: "Anthropic", vision: true, description: "Highest quality." },
  { id: "openai/gpt-6-luna", label: "GPT-6 Luna", vendor: "OpenAI", vision: true, description: "Fast and inexpensive." },
  { id: "deepseek/deepseek-v4-pro-0813", label: "DeepSeek V4 Pro", vendor: "DeepSeek", vision: false, description: "Strong reasoning at a moderate price." },
  { id: "qwen/qwen3.8-flash", label: "Qwen 3.8 Flash", vendor: "Alibaba", vision: false, description: "Lowest cost." },
  { id: "qwen/qwen3.7-flash", label: "Qwen 3.7 Flash (vision)", vendor: "Alibaba", vision: true, description: "Small vision model." },
];
export const DEFAULT_LLM_MODEL = "vertex/openai/gpt-oss-120b-maas";

export const TEMPLATE_INFO: Record<LlmConfig["template"], { label: string; hint: string }> = {
  classification: { label: "Classification", hint: "Categorize data into the categories you list." },
  summarization: { label: "Summarization", hint: "Summarize text to a given length." },
  translation: { label: "Translation", hint: "Translate text into another language." },
  sentiment: { label: "Sentiment analysis", hint: "Score text from most negative to most positive." },
  entities: { label: "Entity extraction", hint: "Pull out the elements you name, typed." },
  empty: { label: "Empty prompt", hint: "Write your own prompt." },
};

export function newLlmConfig(template: LlmConfig["template"], column = ""): LlmConfig {
  const base: LlmConfig = { model: DEFAULT_LLM_MODEL, template, column, outputType: "String", outputColumn: "llm_output", temperature: 0, maxTokens: 1024 };
  switch (template) {
    case "classification":
      return { ...base, multiplicity: "exactly one", categories: [], context: "", outputColumn: "llm_category" };
    case "summarization":
      return { ...base, size: 1, unit: "sentences", outputColumn: "summary" };
    case "translation":
      return { ...base, language: "Spanish", outputColumn: "translation" };
    case "sentiment":
      return { ...base, scaleMin: 0, scaleMax: 5, outputType: "Integer", outputColumn: "sentiment" };
    case "entities":
      return { ...base, entities: [], outputType: "Struct", outputColumn: "entities" };
    default:
      return { ...base, system: "", prompt: column ? `{${column}}` : "" };
  }
}

/** The output type a template produces (templates fix it; created and empty prompts choose). */
export function effectiveOutputType(c: LlmConfig): LlmOutputType {
  if (c.created || c.template === "empty") return c.outputType;
  if (c.template === "classification") return c.multiplicity === "exactly one" ? "String" : "Array<String>";
  if (c.template === "sentiment") return "Integer";
  if (c.template === "entities") return "Struct";
  return "String";
}

const entityLine = (e: LlmEntity) => `- ${e.name} (${e.type})`;

/** The template's instructions, with {column} where a row's value goes. Shown in the Preview tab and kept by Create prompt. */
export function templatePrompt(c: LlmConfig): { system: string; prompt: string } {
  const col = c.column ? `{${c.column}}` : "{column}";
  if (c.created || c.template === "empty") return { system: c.system ?? "", prompt: c.prompt ?? "" };
  switch (c.template) {
    case "classification": {
      const cats = (c.categories ?? []).filter(Boolean);
      const many =
        c.multiplicity === "exactly one"
          ? "Assign exactly one category."
          : c.multiplicity === "exact number"
            ? `Assign exactly ${c.count ?? 2} categories.`
            : "Assign every category that applies (at least one).";
      return {
        system: `You classify ${c.context?.trim() || "data"} into categories. The categories are: ${cats.map((x) => `"${x}"`).join(", ") || "(none yet)"}. ${many} Use the category names exactly as written.`,
        prompt: `Classify this ${c.context?.trim() || "value"}:\n\n${col}`,
      };
    }
    case "summarization":
      return {
        system: `You summarize text. The summary is at most ${c.size ?? 1} ${c.unit ?? "sentences"} long and keeps the most important information. Answer with the summary only.`,
        prompt: `Summarize:\n\n${col}`,
      };
    case "translation":
      return {
        system: `You translate text into ${c.language || "English"}. Keep the meaning, tone and formatting. Answer with the translation only.`,
        prompt: `Translate:\n\n${col}`,
      };
    case "sentiment":
      return {
        system: `You rate sentiment as a whole number from ${c.scaleMin ?? 0} (most negative) to ${c.scaleMax ?? 5} (most positive).`,
        prompt: `Rate the sentiment of:\n\n${col}`,
      };
    case "entities":
      return {
        system: `You extract entities from text. Extract:\n${(c.entities ?? []).map(entityLine).join("\n") || "(no entities defined)"}\nUse null when an entity is not present.`,
        prompt: `Extract the entities from:\n\n${col}`,
      };
  }
  return { system: "", prompt: "" };
}

type JsonSchema = Record<string, unknown>;

function entitySchema(e: LlmEntity): JsonSchema {
  switch (e.type) {
    case "Integer":
      return { type: ["integer", "null"] };
    case "Double":
      return { type: ["number", "null"] };
    case "Boolean":
      return { type: ["boolean", "null"] };
    case "Array<String>":
      return { type: "array", items: { type: "string" } };
    case "Array<Integer>":
      return { type: "array", items: { type: "integer" } };
    default:
      return { type: ["string", "null"] };
  }
}

/** JSON schema of the answer's `value`. */
export function valueSchema(c: LlmConfig): JsonSchema {
  const t = effectiveOutputType(c);
  if (c.template === "classification" && !c.created) {
    const cats = (c.categories ?? []).filter(Boolean);
    const one: JsonSchema = cats.length ? { type: "string", enum: cats } : { type: "string" };
    if (t === "String") return one;
    return c.multiplicity === "exact number"
      ? { type: "array", items: one, minItems: c.count ?? 2, maxItems: c.count ?? 2 }
      : { type: "array", items: one, minItems: 1 };
  }
  if (c.template === "sentiment" && !c.created) return { type: "integer", minimum: c.scaleMin ?? 0, maximum: c.scaleMax ?? 5 };
  if (c.template === "entities" && !c.created) {
    const ents = (c.entities ?? []).filter((e) => e.name.trim());
    return {
      type: "object",
      properties: Object.fromEntries(ents.map((e) => [e.name, entitySchema(e)])),
      required: ents.map((e) => e.name),
      additionalProperties: false,
    };
  }
  switch (t) {
    case "Integer":
      return { type: "integer" };
    case "Double":
      return { type: "number" };
    case "Boolean":
      return { type: "boolean" };
    case "Array<String>":
      return { type: "array", items: { type: "string" } };
    case "Struct":
      return { type: "object" };
    default:
      return { type: "string" };
  }
}

/** Column type the node writes. */
export function outputColType(c: LlmConfig): ColType {
  if (c.includeErrors) return "String";
  const t = effectiveOutputType(c);
  return t === "Integer" ? "Long" : t === "Double" ? "Double" : t === "Boolean" ? "Boolean" : "String";
}

/** The columns a prompt reads: {name} placeholders that are input columns. */
export function promptColumns(text: string, columns: string[]): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\{([^{}]+)\}/g)) if (columns.includes(m[1])) out.add(m[1]);
  return [...out];
}

export function fillPrompt(text: string, row: Row, columns: string[]): string {
  return text.replace(/\{([^{}]+)\}/g, (m, name: string) => (columns.includes(name) ? (row[name] === null || row[name] === undefined ? "" : String(row[name])) : m));
}

/** cyrb53: a fast 53-bit string hash, as hex. */
export function hashKey(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

export type LlmCall = {
  model: string;
  system: string;
  prompt: string;
  schema: JsonSchema;
  temperature?: number;
  max_tokens?: number;
  stop?: string[];
  /** a media reference (Files item id), URL or data URL of an image for vision models */
  image?: string | null;
  /** builds without Skip recomputing rows ask for a fresh answer */
  fresh?: boolean;
};

/** The call for one row, and its cache key (the prompt's columns and parameters only, as the doc describes). */
export function rowCall(c: LlmConfig, row: Row, columns: string[], nodeId: string): { key: string; call: LlmCall } {
  const { system, prompt } = templatePrompt(c);
  const call: LlmCall = {
    model: c.model || DEFAULT_LLM_MODEL,
    system: fillPrompt(system, row, columns),
    prompt: fillPrompt(prompt, row, columns),
    schema: valueSchema(c),
    temperature: c.temperature ?? 0,
    max_tokens: c.maxTokens ?? 1024,
    stop: (c.stop ?? []).filter(Boolean).slice(0, 4),
    image: c.imageColumn ? (row[c.imageColumn] === null || row[c.imageColumn] === undefined ? null : String(row[c.imageColumn])) : null,
  };
  const key = `llm:${nodeId}:${c.cacheEpoch ?? 0}:${hashKey(JSON.stringify(call))}`;
  return { key, call };
}

/** An answer as the output column's value; throws when it does not fit the type (strict, as structs are). */
export function coerceAnswer(c: LlmConfig, value: unknown): Cell {
  const t = effectiveOutputType(c);
  if (value === null || value === undefined) return null;
  switch (t) {
    case "Integer": {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isInteger(n)) throw new Error("Cannot coerce to provided output type (Integer)");
      return n;
    }
    case "Double": {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) throw new Error("Cannot coerce to provided output type (Double)");
      return n;
    }
    case "Boolean":
      if (typeof value === "boolean") return value;
      if (value === "true" || value === "false") return value === "true";
      throw new Error("Cannot coerce to provided output type (Boolean)");
    case "Array<String>":
      if (!Array.isArray(value)) throw new Error("Cannot coerce to provided output type (Array<String>)");
      return JSON.stringify(value.map(String));
    case "Struct":
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Cannot coerce to provided output type (Struct)");
      return JSON.stringify(value);
    case "JSON string":
      return typeof value === "string" ? value : JSON.stringify(value);
    default:
      return typeof value === "string" ? value : JSON.stringify(value);
  }
}

/** Checks the node can run against its input table. */
export function llmProblems(c: LlmConfig, t: Table): string[] {
  const cols = t.columns.map((x) => x.name);
  const out: string[] = [];
  if (!c.outputColumn.trim()) out.push("Name the output column");
  if (!c.created && c.template !== "empty") {
    if (!c.column) out.push("Choose the column to read");
    else if (!cols.includes(c.column)) out.push(`Column "${c.column}" not found`);
    if (c.template === "classification" && !(c.categories ?? []).some(Boolean)) out.push("Add the categories");
    if (c.template === "entities" && !(c.entities ?? []).some((e) => e.name.trim())) out.push("Add the entities to extract");
    if (c.template === "translation" && !c.language?.trim()) out.push("Enter the language");
  } else if (!(c.prompt ?? "").trim() && !c.imageColumn) out.push("Write the prompt");
  if (c.imageColumn && !cols.includes(c.imageColumn)) out.push(`Column "${c.imageColumn}" not found`);
  return out;
}

/** Evaluates a Use LLM node (see the module comment). */
export function computeLlm(t: Table, c: LlmConfig, nodeId: string, opts: EvalOptions): NodeResult {
  if (t.files) throw new Error("Extract rows from the files before using an LLM");
  const problems = llmProblems(c, t);
  if (problems.length) throw new Error(problems.join("; "));
  const services = opts.services;
  if (!services) return { error: "LLM answers are computed when the pipeline runs" };
  const columns = t.columns.map((x) => x.name);
  const rows = opts.preview ? t.rows.slice(0, LLM_PREVIEW_ROWS) : t.rows;
  const out = c.outputColumn.trim();
  let pending = 0;
  const outRows = rows.map((row) => {
    const { key, call } = rowCall(c, row, columns, nodeId);
    const fresh = !opts.preview && !c.skipRecompute;
    const answer = services.get(key);
    let value: Cell = null;
    let error: string | null = null;
    if (!answer) {
      pending++;
      services.request({ key, kind: "llm", payload: { ...call, fresh } });
    } else if ("error" in answer) error = answer.error;
    else {
      try {
        value = coerceAnswer(c, answer.value);
      } catch (e) {
        error = (e as Error).message;
      }
    }
    const structured = ["Array<String>", "Struct"].includes(effectiveOutputType(c));
    const cell: Cell = c.includeErrors ? JSON.stringify({ value: structured ? tryParse(value) : value, error }) : value;
    return { ...row, [out]: cell };
  });
  const columnsOut = t.columns.some((x) => x.name === out)
    ? t.columns.map((x) => (x.name === out ? { name: out, type: outputColType(c) } : x))
    : [...t.columns, { name: out, type: outputColType(c) }];
  return { table: { columns: columnsOut, rows: outRows }, pending };
}

const tryParse = (v: Cell): unknown => {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};
