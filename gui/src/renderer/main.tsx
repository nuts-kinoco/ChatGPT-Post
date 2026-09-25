import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { BridgeGuiState, BridgeRequest, DoctorItem, RequestStatus } from "../main/state.js";
import "./styles.css";

const INITIAL_STATE: BridgeGuiState = { doctor: { ok: false, items: [], error: "Connecting" }, lockHeld: null, requests: [], updatedAt: new Date(0).toISOString() };
const TERMINAL_STATUSES = new Set<RequestStatus>(["Completed", "Failed", "Blocked"]);
const statusColor: Record<RequestStatus, string> = { Running: "bg-ok", Unknown: "bg-info", Completed: "bg-ink-3", Failed: "bg-err", Blocked: "bg-warn" };
const statusCode: Record<RequestStatus, string> = { Running: "RUN", Unknown: "UNK", Completed: "DONE", Failed: "FAIL", Blocked: "BLOCK" };

function elapsed(iso: string, now: number) {
  const elapsedSeconds = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  return `${String(Math.floor(elapsedSeconds / 60)).padStart(2, "0")}:${String(elapsedSeconds % 60).padStart(2, "0")}`;
}
function statusRequest(requests: BridgeRequest[]) { return requests.find((request) => request.status === "Running") ?? requests.find((request) => request.status === "Unknown"); }
function health(item: DoctorItem | undefined, kind: "bridge" | "chrome" | "auth" | "lock") {
  if (!item) return { label: "Unknown", color: "bg-ink-3" };
  if (kind === "lock") return item.ok ? { label: "Free", color: "bg-ok" } : { label: "In-use", color: "bg-warn" };
  return item.ok ? { label: kind === "bridge" ? "Ready" : kind === "chrome" ? "Connected" : "Valid", color: "bg-ok" } : { label: kind === "bridge" ? "Offline" : kind === "chrome" ? "Disconnected" : "Expired", color: "bg-err" };
}

function RequestRow({ request, now }: { request: BridgeRequest; now: number }) {
  return <div className="grid grid-cols-[52px_1fr_48px] items-center gap-2 rounded bg-raised px-2 py-2 text-[10px] hover:bg-line">
    <span className="flex items-center gap-1 text-ink-2"><i className={`h-1.5 w-1.5 rounded-full ${statusColor[request.status]}`} />{statusCode[request.status]}</span>
    <span className="min-w-0 truncate font-sans text-ink" title={request.title}>{request.title}</span>
    <span className="text-right text-ink-2">{elapsed(request.startedAt, now)}</span>
  </div>;
}

function Popup({ state, now }: { state: BridgeGuiState; now: number }) {
  const byName = (name: string) => state.doctor.items.find((item) => item.name === name);
  const healthItems = [["Bridge", byName("daemon"), "bridge"], ["Chrome", byName("profile.processes"), "chrome"], ["Auth", byName("login"), "auth"], ["Lock", byName("lock"), "lock"]] as const;
  const running = state.requests.find((request) => request.status === "Running");
  const unknown = state.requests.filter((request) => request.status === "Unknown").sort((a, b) => b.requestMtimeMs - a.requestMtimeMs);
  const recent = state.requests.filter((request) => TERMINAL_STATUSES.has(request.status)).sort((a, b) => (b.terminalSortMs ?? 0) - (a.terminalSortMs ?? 0)).slice(0, 5);
  return <section className="h-[480px] overflow-y-auto border-x border-b border-line bg-surface px-3 py-3 font-mono text-[10px] text-ink">
    <div className="mb-3 flex items-center justify-between"><span className="tracking-[0.16em] text-ink-2">BRIDGE // CONTROL</span><span className="text-ink-3">READ ONLY</span></div>
    <div className="mb-3 grid grid-cols-2 gap-px overflow-hidden rounded border border-line bg-line">
      {healthItems.map(([label, item, kind]) => { const value = health(item, kind); return <div key={label} className="flex items-center justify-between bg-surface px-2 py-2"><span className="text-ink-2">{label}</span><span className="flex items-center gap-1"><i className={`h-1.5 w-1.5 rounded-full ${value.color}`} />{value.label}</span></div>; })}
    </div>
    {running && <section className="mb-3 rounded border border-ok/40 bg-raised p-2"><p className="mb-1 text-[9px] tracking-[0.14em] text-ok">NOW RUNNING</p><p className="truncate font-sans text-ink" title={running.title}>{running.title}</p><p className="mt-1 text-ink-2">{running.caller} · {running.project} · {elapsed(running.startedAt, now)}</p></section>}
    {unknown.length > 0 && <section className="mb-3"><p className="mb-1.5 text-[9px] tracking-[0.14em] text-ink-2">NO RESULT YET</p><div className="space-y-1">{unknown.slice(0, 4).map((request) => <RequestRow key={request.requestId} request={request} now={now} />)}</div></section>}
    <section className="mb-3"><p className="mb-1.5 text-[9px] tracking-[0.14em] text-ink-2">RECENT</p><div className="space-y-1">{recent.length ? recent.map((request) => <RequestRow key={request.requestId} request={request} now={now} />) : <p className="rounded bg-raised px-2 py-2 text-ink-3">No terminal requests</p>}</div></section>
    <div className="grid grid-cols-4 gap-1 border-t border-line pt-3">{["New", "Stop", "Refresh Cookie", "Settings"].map((label) => <button key={label} disabled className="rounded border border-line bg-base px-1 py-1.5 text-[9px] text-ink-3 disabled:cursor-not-allowed">{label}</button>)}</div>
  </section>;
}

function App() {
  const [state, setState] = useState(INITIAL_STATE);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const unsubscribe = window.bridgeGui.onState(setState); const timer = window.setInterval(() => setNow(Date.now()), 1_000); return () => { unsubscribe(); window.clearInterval(timer); }; }, []);
  const active = useMemo(() => statusRequest(state.requests), [state.requests]);
  const additional = state.requests.filter((request) => request.status === "Running" || request.status === "Unknown").length - (active ? 1 : 0);
  const idleDetail = state.lockHeld === false ? "Lock free" : state.lockHeld === true ? "Lock in use" : "Lock unknown";
  return <main className="overflow-hidden font-mono text-[11px] text-ink">
    <button type="button" onClick={() => window.bridgeGui.togglePopup()} className="flex h-10 w-full items-center border border-line bg-base px-3 text-left hover:bg-raised">
      <span aria-label={`Bridge status: ${active?.status ?? "idle"}`} className={`mr-2 h-2 w-2 shrink-0 rounded-full ${active ? statusColor[active.status] : "bg-ink-3"}`} />
      <span className="shrink-0 text-ink-2">{active ? statusCode[active.status] : "IDLE"}</span>
      <span className="mx-3 min-w-0 flex-1 truncate font-sans text-ink" title={active?.title}>{active?.title ?? idleDetail}</span>
      <span className="shrink-0 text-ink-2">{active ? elapsed(active.startedAt, now) : "--:--"}</span>
      {additional > 0 && <span className="ml-2 rounded bg-raised px-1.5 py-0.5 text-[10px] text-ink-2">+{additional}</span>}
      <span aria-hidden="true" className="ml-3 text-ink-3">⌄</span>
    </button>
    <Popup state={state} now={now} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<App />);
