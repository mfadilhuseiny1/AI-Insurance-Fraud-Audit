"use client";

import "@xterm/xterm/css/xterm.css";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { API_URL } from "@/lib/api";

export type TerminalHandle = { focus: () => void; save: () => Promise<void>; reload: () => Promise<void> };

const THEMES = {
  light: { background: "#ffffff", foreground: "#000000", cursor: "#000000", selectionBackground: "#d7d4f0" },
  dark: { background: "#111111", foreground: "#e0e0e0", cursor: "#ffffff", selectionBackground: "#3d4a6b" },
};

/** A terminal tab (JupyterLab's Terminal): xterm.js over the workspace's terminal websocket (terminado's protocol). */
export const TerminalView = forwardRef<TerminalHandle, { wid: string; tid: string; active: boolean; theme: "light" | "dark" }>(function TerminalView({ wid, tid, active, theme }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<import("@xterm/xterm").Terminal | null>(null);
  const fit = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const [state, setState] = useState<"connecting" | "open" | "closed">("connecting");
  const [attempt, setAttempt] = useState(0);

  useImperativeHandle(ref, () => ({ focus: () => term.current?.focus(), save: async () => {}, reload: async () => setAttempt((a) => a + 1) }));

  useEffect(() => {
    let ws: WebSocket | null = null;
    let disposed = false;
    let observer: ResizeObserver | null = null;
    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed || !host.current) return;
      const t = new Terminal({ fontFamily: "menlo, consolas, 'DejaVu Sans Mono', monospace", fontSize: 13, cursorBlink: true, theme: THEMES[theme], scrollback: 5000 });
      const f = new FitAddon();
      t.loadAddon(f);
      t.open(host.current);
      term.current = t;
      fit.current = f;
      const url = `${(API_URL || window.location.origin).replace(/^http/, "ws")}/api/code-workspaces/${wid}/lab/terminals/${tid}/channels`;
      ws = new WebSocket(url);
      const send = (msg: unknown[]) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
      const resize = () => {
        if (!host.current?.offsetParent) return;
        try {
          f.fit();
          send(["set_size", t.rows, t.cols]);
        } catch {}
      };
      ws.onopen = () => {
        setState("open");
        resize();
        t.focus();
      };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data as string) as [string, string];
          if (msg[0] === "stdout") t.write(msg[1]);
        } catch {}
      };
      ws.onclose = (e) => {
        setState("closed");
        t.write(`\r\n\x1b[90m[disconnected${e.code === 4404 ? ": this terminal was shut down" : e.code === 4401 ? ": sign in again" : ""}]\x1b[0m\r\n`);
      };
      t.onData((d) => send(["stdin", d]));
      observer = new ResizeObserver(() => resize());
      observer.observe(host.current);
    })();
    return () => {
      disposed = true;
      observer?.disconnect();
      ws?.close();
      term.current?.dispose();
      term.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the theme is applied below without reconnecting
  }, [wid, tid, attempt]);

  useEffect(() => {
    if (term.current) term.current.options.theme = THEMES[theme];
  }, [theme]);
  useEffect(() => {
    if (active)
      requestAnimationFrame(() => {
        try {
          fit.current?.fit();
        } catch {}
        term.current?.focus();
      });
  }, [active]);

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: THEMES[theme].background }}>
      {state === "closed" && (
        <div className="jp-Banner jp-mod-warn">
          The terminal is disconnected.
          <button type="button" className="jp-Button jp-mod-small" onClick={() => setAttempt((a) => a + 1)}>Reconnect</button>
        </div>
      )}
      <div ref={host} style={{ flex: 1, minHeight: 0, padding: "4px 0 0 6px" }} />
    </div>
  );
});
