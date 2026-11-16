"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { AppHeader } from "@/components/ontology/parts";
import { buttonClass, inputClass } from "@/components/pipeline/Modal";
import { ApiError } from "@/components/States";
import { codeRepos, type CatalogModel } from "@/lib/codeRepos";

type Catalog = Awaited<ReturnType<typeof codeRepos.models>>;

const example = (m: CatalogModel) =>
  m.kind === "chat"
    ? `from transforms.api import transform, Input, Output
from palantir_models.transforms import GenericChatCompletionLanguageModelInput
from language_model_service_api.languagemodelservice_api_completion_v3 import GenericChatCompletionRequest
from language_model_service_api.languagemodelservice_api import ChatMessage, ChatMessageRole


@transform.spark.using(
    source=Input("/path/to/reviews"),
    output=Output("/path/to/answers"),
    model=GenericChatCompletionLanguageModelInput("${m.rid}"),
)
def compute(ctx, source, output, model):
    def answer(text):
        request = GenericChatCompletionRequest([ChatMessage(ChatMessageRole.USER, f"Summarize: {text}")])
        return model.create_chat_completion(request).completion

    df = source.pandas()
    df["summary"] = df["review"].map(answer)
    output.write_pandas(df)
`
    : `from transforms.api import transform, Input, Output
from palantir_models.transforms import GenericEmbeddingModelInput
from language_model_service_api.languagemodelservice_api_embeddings_v3 import GenericEmbeddingsRequest


@transform.spark.using(
    source=Input("/path/to/documents"),
    output=Output("/path/to/embeddings"),
    model=GenericEmbeddingModelInput("${m.rid}"),
)
def compute(ctx, source, output, model):
    df = source.pandas()
    df["embedding"] = model.create_embeddings(GenericEmbeddingsRequest(inputs=list(df["text"]))).embeddings
    output.write_pandas(df)
`;

/** Model Catalog: the chat and embedding models transforms can use through palantir_models inputs, with the
 *  resource identifiers to pass them. */
export default function ModelCatalogPage() {
  const [data, setData] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | "chat" | "embedding" | "registered">("all");
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    codeRepos.models().then(setData, (e: Error) => setError(e.message));
  }, []);
  const copy = (text: string, key: string) => {
    navigator.clipboard?.writeText(text).then(() => setCopied(key), () => {});
  };

  if (error && !data) return <ApiError message={error} />;
  const all = data ? [...data.chat, ...data.embedding] : [];
  const shown = all.filter(
    (m) =>
      (kind === "all" || (kind === "registered" ? !!m.registered : m.kind === kind)) &&
      (!q || `${m.id} ${m.label ?? ""} ${m.vendor ?? ""}`.toLowerCase().includes(q.toLowerCase())),
  );
  const registered = all.filter((m) => m.registered).length;
  return (
    <div className="dot-grid flex-1 overflow-y-auto">
      <AppHeader app="Model Catalog" icon="list" href="/models">
        <Link href="/model-studio" className="rounded-md border border-line bg-panel px-3 py-1.5 text-xs text-soft hover:text-white">Model Studio</Link>
        <Link href="/model-experiments" className="rounded-md border border-line bg-panel px-3 py-1.5 text-xs text-soft hover:text-white">Experiments</Link>
        <Link href="/modeling-objectives" className="rounded-md border border-line bg-panel px-3 py-1.5 text-xs text-soft hover:text-white">Modeling Objectives</Link>
      </AppHeader>
      <div className="mx-auto max-w-6xl p-8">
        <h1 className="text-xl font-semibold">Model Catalog</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Language and embedding models available to Python transforms in{" "}
          <Link href="/code-repositories" className="text-ocean hover:underline">
            Code Repositories
          </Link>
          . Pass a model&apos;s resource identifier to a <span className="font-mono">palantir_models</span> input; previews and builds call it with the job&apos;s
          credentials. {data?.aliases}
        </p>
        <p className="mt-2 max-w-3xl text-sm text-muted">
          Registered models are published functions that implement a function interface:{" "}
          <span className="font-mono">@function(implements=&quot;ChatCompletion&quot;)</span> (messages in, the completion out, or streamed with{" "}
          <span className="font-mono">Iterator[str]</span>) or <span className="font-mono">@function(implements=&quot;Embedding&quot;, dimension=…)</span> (inputs: a list of
          strings in, one vector each out). Their latest release is listed here and wherever models are chosen.
          {data && ` ${registered} registered.`}
        </p>
        <div className="mt-5 flex items-center gap-2">
          <div className="relative w-72">
            <Icon name="search" className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search models…" className={`${inputClass} pl-8 text-sm`} />
          </div>
          {(["all", "chat", "embedding", "registered"] as const).map((k) => (
            <button key={k} type="button" onClick={() => setKind(k)} className={kind === k ? buttonClass.secondary : buttonClass.ghost}>
              {k === "all" ? "All" : k === "chat" ? "Chat" : k === "embedding" ? "Embedding" : "Registered"}
            </button>
          ))}
          <span className="ml-auto text-xs text-muted">{data ? `${shown.length} of ${all.length} models` : "Loading…"}</span>
        </div>
        <div className="mt-3 overflow-hidden rounded-xl border border-line bg-panel">
          <table className="w-full text-sm">
            <thead className="border-b border-line text-left text-xs text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Model</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Resource identifier</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {shown.map((m) => {
                const key = `${m.kind}:${m.id}`;
                return (
                  <ModelRow
                    key={key}
                    m={m}
                    open={open === key}
                    copied={copied}
                    onToggle={() => setOpen(open === key ? null : key)}
                    onCopy={(text, what) => copy(text, `${key}:${what}`)}
                    copyKey={key}
                  />
                );
              })}
              {data && shown.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-xs text-muted">
                    No models match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/** Try a registered chat model: its completion appears piece by piece when its function streams. */
function TryRegistered({ model }: { model: string }) {
  const [prompt, setPrompt] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setText("");
    setError(null);
    codeRepos
      .chatStream(model, prompt, (piece) => setText((t) => t + piece))
      .then(setText, (e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <div className="mt-3">
      <div className="flex items-center gap-2">
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
          placeholder="Try it: a prompt for this model…"
          className={`${inputClass} text-sm`}
        />
        <button type="button" onClick={run} disabled={busy || !prompt.trim()} className={buttonClass.secondary}>
          {busy ? "Running…" : "Run"}
        </button>
      </div>
      {error && <div className="mt-2 text-xs text-warn">{error}</div>}
      {text && <pre className="mt-2 whitespace-pre-wrap rounded-md border border-line bg-panel p-3 text-xs text-soft">{text}</pre>}
    </div>
  );
}

function ModelRow({
  m,
  open,
  copied,
  copyKey,
  onToggle,
  onCopy,
}: {
  m: CatalogModel;
  open: boolean;
  copied: string | null;
  copyKey: string;
  onToggle: () => void;
  onCopy: (text: string, what: "rid" | "code") => void;
}) {
  return (
    <>
      <tr className="border-b border-line last:border-0 hover:bg-panel-2/60">
        <td className="px-4 py-2.5">
          <div className="flex items-center gap-1.5 font-medium">
            {m.label ?? m.id}
            {m.registered && <span className="rounded bg-ocean/15 px-1.5 text-[10px] font-normal text-ocean">registered{m.version ? ` · v${m.version}` : ""}</span>}
            {m.streaming && <span className="rounded bg-panel-2 px-1.5 text-[10px] font-normal text-soft">streams</span>}
          </div>
          <div className="font-mono text-[11px] text-muted">
            {m.id}
            {m.vendor ? ` · ${m.vendor}` : ""}
            {m.dimension ? ` · ${m.dimension} dimensions` : m.registered && m.kind === "embedding" ? " · dimension known after its first call" : ""}
          </div>
          {m.registered && m.function_id && (
            <Link href={`/functions/${m.function_id}`} className="text-[11px] text-ocean hover:underline">
              Open the function
            </Link>
          )}
        </td>
        <td className="px-4 py-2.5 text-xs text-soft">{m.kind === "chat" ? "Chat completion" : "Embedding"}</td>
        <td className="px-4 py-2.5">
          <button type="button" onClick={() => onCopy(m.rid, "rid")} title="Copy" className="flex max-w-xs items-center gap-1.5 text-left font-mono text-[11px] text-soft hover:text-white">
            <span className="truncate">{m.rid}</span>
            <Icon name={copied === `${copyKey}:rid` ? "check" : "copy"} className="h-3 w-3 shrink-0" />
          </button>
        </td>
        <td className="px-4 py-2.5 text-xs">{m.available === false ? <span className="text-warn">no API key</span> : <span className="text-ok">available</span>}</td>
        <td className="px-4 py-2.5 text-right">
          <button type="button" onClick={onToggle} className="text-xs text-ocean hover:underline">
            {open ? "Hide example" : "Use in a transform"}
          </button>
        </td>
      </tr>
      {open && (
        <tr className="border-b border-line bg-panel-2/40">
          <td colSpan={5} className="px-4 py-3">
            <div className="mb-2 flex items-center gap-2 text-xs text-muted">
              Inputs: {m.inputs.map((i) => <span key={i} className="rounded bg-panel px-1.5 font-mono text-[11px] text-soft">{i}</span>)}
              <button type="button" onClick={() => onCopy(example(m), "code")} className={`${buttonClass.ghost} ml-auto`}>
                <Icon name={copied === `${copyKey}:code` ? "check" : "copy"} className="h-3.5 w-3.5" /> Copy code
              </button>
            </div>
            <pre className="overflow-x-auto rounded-md border border-line bg-panel p-3 font-mono text-[11px] leading-relaxed text-soft">{example(m)}</pre>
            {m.registered && m.kind === "chat" && <TryRegistered model={m.id} />}
          </td>
        </tr>
      )}
    </>
  );
}
