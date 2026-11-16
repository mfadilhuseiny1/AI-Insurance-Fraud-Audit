"use client";

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { confirmDialog, promptDialog } from "@/lib/dialogs";
import {
  orbis,
  orbisVariant,
  type AskResult,
  type Conversation,
  type KindMeta,
  type OrbisNode,
} from "@/lib/orbis";

/* Tanya Orbis: a question is searched in the vector index orbis-1, the hits are widened by one hop of the graph, and the
   answer cites the nodes it rests on — [n] chips select them, and the answer's subgraph lights up on the canvas.
   Conversations are kept per user in the platform database (Riwayat), with their answers' references and subgraphs. */

// the last conversation per graph (JKN keeps the original key)
const last = () => (orbisVariant().base === "/api/orbis" ? "orbis:conversation" : `orbis:conversation:${orbisVariant().base}`);

type Msg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  result?: AskResult;
  error?: string;
};


interface Props {
  kinds: Record<string, KindMeta>;
  nodeIndex: Map<string, OrbisNode>;
  onSelect: (id: string) => void;
  onHighlight: (r: AskResult | null) => void;
  highlightedId: string | null;
  setHighlightedId: (id: string | null) => void;
}

export default function ChatPanel({
  kinds,
  nodeIndex,
  onSelect,
  onHighlight,
  highlightedId,
  setHighlightedId,
}: Props) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [conv, setConv] = useState<{ id: string; title: string } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [list, setList] = useState<Conversation[] | null>(null);
  const [filter, setFilter] = useState("");
  const [histErr, setHistErr] = useState<string | null>(null);

  const open = async (id: string) => {
    try {
      const c = await orbis.conversation(id);
      setConv({ id: c.id, title: c.title });
      setMsgs(
        c.messages.map((m) =>
          m.role === "user"
            ? { id: m.id, role: "user", content: m.content }
            : {
                id: m.id,
                role: "assistant",
                content: m.content,
                result: m.result ?? undefined,
                error: m.error ?? undefined,
              },
        ),
      );
      setShowHistory(false);
      setHighlightedId(null);
      onHighlight(null);
      try {
        localStorage.setItem(last(), c.id);
      } catch {
        /* storage unavailable */
      }
    } catch (e) {
      setHistErr((e as Error).message);
      try {
        localStorage.removeItem(last());
      } catch {
        /* storage unavailable */
      }
    }
  };
  const fresh = () => {
    setConv(null);
    setMsgs([]);
    setHighlightedId(null);
    onHighlight(null);
    setShowHistory(false);
    try {
      localStorage.removeItem(last());
    } catch {
      /* storage unavailable */
    }
  };
  // reopen the conversation of the last visit
  useEffect(() => {
    let id: string | null = null;
    try {
      id = localStorage.getItem(last());
    } catch {
      /* storage unavailable */
    }
    if (id) open(id);
    // once, on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!showHistory) return;
    let alive = true;
    const t = setTimeout(
      () =>
        orbis.conversations(filter).then(
          (x) => alive && (setList(x), setHistErr(null)),
          (e: Error) => alive && setHistErr(e.message),
        ),
      filter ? 250 : 0,
    );
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [showHistory, filter, conv]);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, busy]);

  const ask = async (q: string) => {
    q = q.trim();
    if (!q || busy) return;
    const uid = `u${Date.now()}`;
    setShowHistory(false);
    setMsgs((m) => [...m, { id: uid, role: "user", content: q }]);
    setText("");
    setBusy(true);
    try {
      const r = await orbis.ask(q, conv?.id ?? null);
      if (r.conversation_id && !conv) {
        setConv({ id: r.conversation_id, title: r.title ?? q });
        try {
          localStorage.setItem(last(), r.conversation_id);
        } catch {
          /* storage unavailable */
        }
      }
      const id = r.message_id ?? `a${Date.now()}`;
      setMsgs((m) => [
        ...m,
        { id, role: "assistant", content: r.answer, result: r },
      ]);
      setHighlightedId(id);
      onHighlight(r);
    } catch (e) {
      setMsgs((m) => [
        ...m,
        {
          id: `e${Date.now()}`,
          role: "assistant",
          content: "",
          error: (e as Error).message,
        },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const ago = (iso: string) => {
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    return m < 1
      ? "baru saja"
      : m < 60
        ? `${m} mnt lalu`
        : m < 1440
          ? `${Math.round(m / 60)} jam lalu`
          : new Date(iso).toLocaleDateString("id-ID", {
              day: "numeric",
              month: "short",
            });
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 border-b px-3 py-1.5">
        <span
          className="min-w-0 flex-1 truncate text-[12px]"
          style={{ color: conv ? "var(--kg-text)" : "var(--kg-text-faint)" }}
          title={conv?.title}
        >
          {conv ? conv.title : "Percakapan baru"}
        </span>
        <button
          className="btn"
          data-active={showHistory}
          onClick={() => setShowHistory((v) => !v)}
          title="Riwayat percakapan"
        >
          Riwayat
        </button>
        <button className="btn" onClick={fresh} title="Percakapan baru">
          + Baru
        </button>
      </div>
      {showHistory ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="border-b p-3">
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Cari judul atau isi percakapan…"
              className="w-full px-2.5 py-1.5"
            />
          </div>
          {histErr && (
            <p className="notice m-3" data-tone="error">
              {histErr}
            </p>
          )}
          <ul className="min-h-0 flex-1 overflow-y-auto p-2">
            {(list ?? []).map((c) => (
              <li
                key={c.id}
                className="group flex items-start gap-1 rounded-md px-2 py-1.5 hover:bg-[var(--kg-surface-2)]"
                style={
                  c.id === conv?.id
                    ? { background: "var(--kg-accent-soft)" }
                    : undefined
                }
              >
                <button
                  className="min-w-0 flex-1 text-left"
                  onClick={() => open(c.id)}
                >
                  <span className="block truncate">{c.title}</span>
                  <span
                    className="mono block text-[10px]"
                    style={{ color: "var(--kg-text-faint)" }}
                  >
                    {ago(c.updated_at)} · {Math.ceil(c.messages / 2)} pertanyaan
                  </span>
                </button>
                <button
                  className="mono shrink-0 rounded px-1 text-[10.5px] opacity-0 hover:underline group-hover:opacity-100"
                  style={{ color: "var(--kg-text-faint)" }}
                  title="Ganti judul"
                  onClick={async () => {
                    const t = await promptDialog("Judul percakapan", c.title, {
                      title: "Ganti judul",
                    });
                    if (!t?.trim()) return;
                    const r = await orbis
                      .renameConversation(c.id, t)
                      .catch((e: Error) => (setHistErr(e.message), null));
                    if (!r) return;
                    setList((l) =>
                      (l ?? []).map((x) =>
                        x.id === c.id ? { ...x, title: r.title } : x,
                      ),
                    );
                    if (conv?.id === c.id)
                      setConv({ id: c.id, title: r.title });
                  }}
                >
                  ubah
                </button>
                <button
                  className="mono shrink-0 rounded px-1 text-[10.5px] opacity-0 hover:underline group-hover:opacity-100"
                  style={{ color: "#f87171" }}
                  title="Hapus percakapan"
                  onClick={async () => {
                    if (
                      !(await confirmDialog({
                        message: `Hapus percakapan "${c.title}"?`,
                        confirmLabel: "Hapus",
                        danger: true,
                      }))
                    )
                      return;
                    const ok = await orbis.deleteConversation(c.id).then(
                      () => true,
                      (e: Error) => (setHistErr(e.message), false),
                    );
                    if (!ok) return;
                    setList((l) => (l ?? []).filter((x) => x.id !== c.id));
                    if (conv?.id === c.id) fresh();
                  }}
                >
                  hapus
                </button>
              </li>
            ))}
            {list && !list.length && (
              <li
                className="px-2 py-6 text-center text-[12px]"
                style={{ color: "var(--kg-text-faint)" }}
              >
                {filter
                  ? "Tidak ada percakapan yang cocok."
                  : "Belum ada percakapan tersimpan."}
              </li>
            )}
            {!list && !histErr && (
              <li
                className="mono kg-pulse px-2 py-6 text-center text-[11px]"
                style={{ color: "var(--kg-text-faint)" }}
              >
                memuat riwayat…
              </li>
            )}
          </ul>
        </div>
      ) : (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          {!msgs.length && (
            <div className="space-y-3">
              <div>
                <div className="text-[14px] font-medium">Tanya Orbis</div>
                <p
                  className="mt-1 leading-relaxed"
                  style={{ color: "var(--kg-text-muted)" }}
                >
                  {orbisVariant().ask} Jawaban dicari
                  di indeks vector <span className="mono">{orbisVariant().index}</span>,
                  diperluas satu langkah di graf, dan merujuk simpulnya.
                </p>
              </div>
              <div className="space-y-1.5">
                {orbisVariant().suggestions.map((s) => (
                  <button
                    key={s}
                    className="block w-full rounded-md border px-2.5 py-1.5 text-left text-[12px] hover:bg-[var(--kg-surface-2)]"
                    style={{ color: "var(--kg-text-muted)" }}
                    onClick={() => ask(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {msgs.map((m) =>
            m.role === "user" ? (
              <div
                key={m.id}
                className="ml-8 rounded-lg px-3 py-2"
                style={{ background: "var(--kg-accent-soft)" }}
              >
                {m.content}
              </div>
            ) : (
              <div
                key={m.id}
                className="fade-in rounded-lg border p-3"
                style={{
                  borderColor:
                    highlightedId === m.id
                      ? "var(--kg-accent)"
                      : "var(--kg-border)",
                }}
              >
                {m.error ? (
                  <p className="notice" data-tone="error">
                    {m.error}
                  </p>
                ) : (
                  <>
                    <Answer
                      text={m.content}
                      result={m.result!}
                      onSelect={onSelect}
                    />
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t pt-2">
                      <button
                        className="btn"
                        data-active={highlightedId === m.id}
                        onClick={() => {
                          if (highlightedId === m.id) {
                            setHighlightedId(null);
                            onHighlight(null);
                          } else {
                            setHighlightedId(m.id);
                            onHighlight(m.result!);
                          }
                        }}
                      >
                        {highlightedId === m.id
                          ? "Lepas sorotan"
                          : "Sorot subgraf"}
                      </button>
                      <span
                        className="mono text-[10px]"
                        style={{ color: "var(--kg-text-faint)" }}
                      >
                        {m.result!.refs.length} simpul ·{" "}
                        {(m.result!.ms / 1000).toFixed(1)} s
                      </span>
                    </div>
                    <details className="mt-1.5">
                      <summary
                        className="mono cursor-pointer text-[10.5px]"
                        style={{ color: "var(--kg-text-faint)" }}
                      >
                        simpul rujukan
                      </summary>
                      <ul className="mt-1 space-y-px">
                        {m.result!.refs.map((r) => (
                          <li key={r.id}>
                            <button
                              className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11.5px] hover:bg-[var(--kg-surface-2)]"
                              onClick={() => onSelect(r.id)}
                            >
                              <span
                                className="mono w-6 shrink-0 text-right text-[10px]"
                                style={{ color: "var(--kg-accent)" }}
                              >
                                {r.n}
                              </span>
                              <span
                                className="h-1.5 w-1.5 shrink-0 rounded-full"
                                style={{
                                  background: kinds[r.kind]?.color ?? "#94a3b8",
                                }}
                              />
                              <span
                                className="min-w-0 flex-1 truncate"
                                style={{ color: "var(--kg-text-muted)" }}
                              >
                                {nodeIndex.get(r.id)?.label ?? r.label}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </details>
                  </>
                )}
              </div>
            ),
          )}
          {busy && (
            <div
              className="mono kg-pulse text-[11px]"
              style={{ color: "var(--kg-text-faint)" }}
            >
              mencari di {orbisVariant().index} dan menelusuri graf…
            </div>
          )}
          <div ref={endRef} />
        </div>
      )}
      <div className="border-t p-3">
        <div className="kg-composer flex items-end gap-2 rounded-lg px-2.5 py-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                ask(text);
              }
            }}
            rows={2}
            placeholder="Tanya tentang data, model, rujukan, keputusan…"
            className="min-h-0 flex-1 resize-none p-0 text-[13px]"
          />
          <button
            className="btn shrink-0"
            disabled={busy || !text.trim()}
            onClick={() => ask(text)}
          >
            Kirim
          </button>
        </div>
        <div
          className="mono mt-1.5 text-[10px]"
          style={{ color: "var(--kg-text-faint)" }}
        >
          {conv
            ? "tersimpan di riwayat"
            : "pertanyaan pertama memulai percakapan tersimpan"}
        </div>
      </div>
    </div>
  );
}

/** A compact markdown subset (paragraphs, bullet and numbered lists, **bold**) with [n] as clickable chips. */
function Answer({
  text,
  result,
  onSelect,
}: {
  text: string;
  result: AskResult;
  onSelect: (id: string) => void;
}) {
  const byN = new Map(result.refs.map((r) => [r.n, r]));
  const inline = (s: string, key: string): ReactNode[] =>
    s.split(/(\*\*[^*]+\*\*|\[\d+\])/g).map((part, i) => {
      const m = part.match(/^\[(\d+)\]$/);
      if (m) {
        const r = byN.get(Number(m[1]));
        return r ? (
          <button
            key={`${key}${i}`}
            className="ev-chip"
            title={r.label}
            onClick={() => onSelect(r.id)}
          >
            {m[1]}
          </button>
        ) : (
          <Fragment key={`${key}${i}`}>{part}</Fragment>
        );
      }
      if (part.startsWith("**") && part.endsWith("**"))
        return <strong key={`${key}${i}`}>{part.slice(2, -2)}</strong>;
      return <Fragment key={`${key}${i}`}>{part}</Fragment>;
    });
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const items = list.items.map((it, i) => (
      <li key={i}>{inline(it, `l${blocks.length}-${i}-`)}</li>
    ));
    blocks.push(
      list.ordered ? (
        <ol key={blocks.length}>{items}</ol>
      ) : (
        <ul key={blocks.length}>{items}</ul>
      ),
    );
    list = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    const num = line.match(/^\d+[.)]\s+(.*)$/);
    if (bullet || num) {
      const ordered = !!num;
      if (!list || list.ordered !== ordered) {
        flush();
        list = { ordered, items: [] };
      }
      list.items.push((bullet ?? num)![1]);
      continue;
    }
    flush();
    if (line)
      blocks.push(
        <p key={blocks.length}>
          {inline(line.replace(/^#+\s*/, ""), `p${blocks.length}-`)}
        </p>,
      );
  }
  flush();
  return <div className="kg-md">{blocks}</div>;
}
