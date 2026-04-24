/**
 * ChatSidebar — structured-events panel that sits next to the xterm.js
 * terminal in the dashboard Chat tab.
 *
 * The terminal pane (`<ChatPage>`) renders the literal TUI process via PTY
 * — full fidelity, byte-identical to `hermes --tui` in a regular terminal.
 * That's the canonical chat surface; everything that happens inside the
 * agent loop is painted there.
 *
 * This sidebar runs a *parallel* JSON-RPC WebSocket to the same gateway
 * (and same session, when the gateway shipped one) and renders the
 * structural metadata that PTY can't surface to the surrounding chrome:
 *
 *   • current model + provider badge with connection state
 *   • running tool-call list (driven by `tool.start` / `tool.progress`
 *     / `tool.complete` events, rendered with `<ToolCall>`)
 *   • model picker (click the model badge → `<ModelPickerDialog>`)
 *
 * Anything destructive (slash exec, model switch) is handed off to the
 * TUI via the gateway so the terminal pane stays the source of truth.
 *
 * The sidecar is best-effort: if the WebSocket can't connect (older
 * gateway, network hiccup, missing token) the terminal pane keeps
 * working unimpaired — we just stop rendering metadata.
 */

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ModelPickerDialog } from "@/components/ModelPickerDialog";
import { ToolCall, type ToolEntry } from "@/components/ToolCall";
import {
  GatewayClient,
  type ConnectionState,
} from "@/lib/gatewayClient";
import { AlertCircle, ChevronDown, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface SessionInfo {
  cwd?: string;
  model?: string;
  provider?: string;
  credential_warning?: string;
}

const STATE_LABEL: Record<ConnectionState, string> = {
  idle: "idle",
  connecting: "connecting",
  open: "live",
  closed: "closed",
  error: "error",
};

const STATE_TONE: Record<ConnectionState, string> = {
  idle: "bg-muted text-muted-foreground",
  connecting: "bg-primary/10 text-primary",
  open: "bg-emerald-500/10 text-emerald-500 dark:text-emerald-400",
  closed: "bg-muted text-muted-foreground",
  error: "bg-destructive/10 text-destructive",
};

const TOOL_LIMIT = 20;

const randId = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

export function ChatSidebar() {
  const gwRef = useRef<GatewayClient | null>(null);
  const [state, setState] = useState<ConnectionState>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [info, setInfo] = useState<SessionInfo>({});
  const [tools, setTools] = useState<ToolEntry[]>([]);
  const [modelOpen, setModelOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Single sidecar GatewayClient lives for the page's lifetime. The PTY pane
  // owns its own WebSocket; the two run side by side without coupling.
  useEffect(() => {
    const gw = new GatewayClient();
    gwRef.current = gw;

    const offState = gw.onState(setState);

    const offSessionInfo = gw.on<SessionInfo>("session.info", (ev) => {
      if (ev.session_id) setSessionId(ev.session_id);
      if (ev.payload) setInfo((prev) => ({ ...prev, ...ev.payload }));
    });

    const offToolStart = gw.on<{
      tool_id: string;
      name: string;
      context?: string;
    }>("tool.start", (ev) => {
      const p = ev.payload;
      if (!p?.tool_id) return;
      setTools((prev) =>
        [
          ...prev,
          {
            kind: "tool" as const,
            id: randId("tool"),
            tool_id: p.tool_id,
            name: p.name ?? "tool",
            context: p.context,
            status: "running" as const,
            startedAt: Date.now(),
          },
        ].slice(-TOOL_LIMIT),
      );
    });

    const offToolProgress = gw.on<{ name?: string; preview?: string }>(
      "tool.progress",
      (ev) => {
        const preview = ev.payload?.preview;
        const name = ev.payload?.name;
        if (!preview || !name) return;
        setTools((prev) =>
          prev.map((t) =>
            t.status === "running" && t.name === name ? { ...t, preview } : t,
          ),
        );
      },
    );

    const offToolComplete = gw.on<{
      tool_id: string;
      summary?: string;
      error?: string;
      inline_diff?: string;
    }>("tool.complete", (ev) => {
      const p = ev.payload;
      if (!p?.tool_id) return;
      setTools((prev) =>
        prev.map((t) =>
          t.tool_id === p.tool_id
            ? {
                ...t,
                status: p.error ? ("error" as const) : ("done" as const),
                summary: p.summary,
                error: p.error,
                inline_diff: p.inline_diff,
                completedAt: Date.now(),
              }
            : t,
        ),
      );
    });

    const offError = gw.on<{ message?: string }>("error", (ev) => {
      const m = ev.payload?.message;
      if (m) setError(m);
    });

    gw.connect()
      .then(async () => {
        // Adopt whichever session the gateway hands us. session.create is a
        // no-op on the existing slot if the gateway already has an active
        // session for this profile; either way we get a sid back to use.
        const created = await gw.request<{ session_id: string }>(
          "session.create",
          {},
        );
        if (created?.session_id) setSessionId(created.session_id);
      })
      .catch((e: Error) => {
        setError(e.message);
      });

    return () => {
      offState();
      offSessionInfo();
      offToolStart();
      offToolProgress();
      offToolComplete();
      offError();
      gw.close();
      gwRef.current = null;
    };
  }, []);

  const reconnect = useCallback(() => {
    setError(null);
    setTools([]);
    gwRef.current?.close();
    const gw = new GatewayClient();
    gwRef.current = gw;
    gw.onState(setState);
    gw.connect().catch((e: Error) => setError(e.message));
  }, []);

  // Picker hands us a fully-formed slash command (e.g. "/model anthropic/...").
  // Fire-and-forget through `slash.exec`; the TUI pane will render the result
  // via PTY, so the sidebar doesn't need to surface output of its own.
  const onModelSubmit = useCallback(
    (slashCommand: string) => {
      const gw = gwRef.current;
      if (!gw || !sessionId) return;
      void gw.request("slash.exec", {
        session_id: sessionId,
        command: slashCommand,
      });
      setModelOpen(false);
    },
    [sessionId],
  );

  const modelLabel = useMemo(() => {
    const m = info.model ?? "—";
    return m.split("/").slice(-1)[0] ?? m;
  }, [info.model]);

  const canPickModel = state === "open" && !!sessionId && !!gwRef.current;

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col gap-3 normal-case">
      <Card className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">
            model
          </div>
          <button
            type="button"
            disabled={!canPickModel}
            onClick={() => setModelOpen(true)}
            className="flex items-center gap-1 truncate text-sm font-medium hover:underline disabled:cursor-not-allowed disabled:opacity-60 disabled:no-underline"
            title={info.model ?? "switch model"}
          >
            <span className="truncate">{modelLabel}</span>
            {canPickModel && (
              <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
            )}
          </button>
        </div>
        <Badge className={STATE_TONE[state]}>{STATE_LABEL[state]}</Badge>
      </Card>

      {(error || info.credential_warning) && (
        <Card className="flex items-start gap-2 border-destructive/40 bg-destructive/5 px-3 py-2 text-xs">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <div className="break-words text-destructive">
              {error ?? info.credential_warning}
            </div>
            {error && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-1 h-6 px-1.5 text-xs"
                onClick={reconnect}
              >
                <RefreshCw className="mr-1 h-3 w-3" />
                reconnect
              </Button>
            )}
          </div>
        </Card>
      )}

      <Card className="flex min-h-0 flex-1 flex-col px-2 py-2">
        <div className="px-1 pb-2 text-xs uppercase tracking-wider text-muted-foreground">
          tools
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-1">
          {tools.length === 0 ? (
            <div className="px-2 py-4 text-center text-xs text-muted-foreground">
              no tool calls yet
            </div>
          ) : (
            tools.map((t) => <ToolCall key={t.id} tool={t} />)
          )}
        </div>
      </Card>

      {modelOpen && canPickModel && gwRef.current && sessionId && (
        <ModelPickerDialog
          gw={gwRef.current}
          sessionId={sessionId}
          onClose={() => setModelOpen(false)}
          onSubmit={onModelSubmit}
        />
      )}
    </aside>
  );
}
