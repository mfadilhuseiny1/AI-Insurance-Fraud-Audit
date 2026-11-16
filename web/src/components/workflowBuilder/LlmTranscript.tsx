"use client";

import { turnGroups, type Step, type ToolCall } from "@/lib/workflowBuilder";

const show = (v: unknown) => (v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v, null, 1));

/** A Use LLM node's conversation in a run: each model turn (its text, streamed while `streaming`) and the tool calls it
 * asked for, with their arguments and results, in the model's order; calls asked for in the same turn are grouped
 * ("in parallel"). Refused or failed calls and the node's error show inline. */
export function LlmTranscript({ step, streaming = false, compact = false }: { step: Step; streaming?: boolean; compact?: boolean }) {
  const groups = turnGroups(step.turns, step.tool_calls);
  const last = groups[groups.length - 1];
  return (
    <div className="space-y-1.5" data-transcript={step.node}>
      {(step.tool_mode || step.fallback) && (
        <div className="text-[10px] text-muted" data-tool-mode-used={step.tool_mode}>
          {step.tool_mode === "native" ? "Native tool calling" : step.tool_mode === "json" ? "JSON-in-text tool calling" : ""}
          {step.fallback && <span className="text-warn"> · fell back: {step.fallback}</span>}
        </div>
      )}
      {groups.map((g) => (
        <div key={g.turn} className="space-y-1" data-turn={g.turn}>
          <div className="text-[10px] uppercase tracking-wide text-muted">{g.turn ? `Turn ${g.turn}` : "Tool calls"}</div>
          {(g.text || (streaming && g === last && !g.calls.length)) && (
            <pre className={`whitespace-pre-wrap rounded bg-ink px-1.5 py-1 font-sans text-[11px] text-white ${compact ? "max-h-32 overflow-auto" : ""}`} data-model-text>
              {g.text}
              {streaming && g === last && !g.calls.length && <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-ocean align-middle" data-caret />}
            </pre>
          )}
          {g.calls.length > 1 ? (
            <div className="rounded border border-dashed border-line-2 p-1" data-parallel={g.calls.length}>
              <div className="mb-0.5 text-[10px] text-sand">{g.calls.length} calls in parallel</div>
              <div className="space-y-1">
                {g.calls.map((c, i) => (
                  <CallRow key={i} c={c} />
                ))}
              </div>
            </div>
          ) : (
            g.calls.map((c, i) => <CallRow key={i} c={c} />)
          )}
        </div>
      ))}
      {streaming && !groups.length && <div className="text-muted">Waiting for the model…</div>}
      {step.stopped && <div className="text-warn" data-llm-stopped>{step.stopped}</div>}
      {step.error && <div className="whitespace-pre-wrap text-bad" data-step-error>{step.error}</div>}
    </div>
  );
}

function CallRow({ c }: { c: ToolCall }) {
  const args = typeof c.args === "string" ? c.args : JSON.stringify(c.args);
  return (
    <details className="rounded bg-ink px-1.5 py-0.5" data-call={c.tool} open={!!c.error}>
      <summary className="cursor-pointer truncate">
        {c.error ? <span className="text-bad">✗</span> : <span className="text-ok">✓</span>} <span className="font-mono">{c.tool}</span>
        <span className="font-mono text-muted">({args.length > 90 ? args.slice(0, 89) + "…" : args})</span>
        {c.ms !== undefined && <span className="ml-1 text-muted">{c.ms} ms</span>}
      </summary>
      <div className="mt-0.5 font-mono text-[10px] text-muted">arguments</div>
      <pre className="whitespace-pre-wrap font-mono text-[10px]" data-call-args>{typeof c.args === "string" ? c.args : JSON.stringify(c.args, null, 1)}</pre>
      <div className="mt-0.5 font-mono text-[10px] text-muted">{c.error ? "error" : "result"}</div>
      <pre className={`max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[10px] ${c.error ? "text-bad" : "text-soft"}`} data-call-result>
        {c.error ?? show(c.result)}
      </pre>
    </details>
  );
}
