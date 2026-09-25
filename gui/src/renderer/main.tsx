import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import type { BridgeGuiState, BridgeRequest, DoctorItem, RequestStatus } from "../main/state.js";
import type { RequestDetail } from "../main/main.js";
import type { NewSubmissionInput } from "../main/submit-new.js";
import type { WindowControlState } from "../main/main.js";
import { COMPLETION_TOAST_DURATION_MS, terminalTransitionsSinceLastPoll } from "../main/completion-notifications.js";
import "./styles.css";

const INITIAL: BridgeGuiState = { doctor: { ok: false, items: [], error: "Connecting" }, lockHeld: null, requests: [], updatedAt: new Date(0).toISOString() };
const NOTICE_DURATION_MS = 8_000;
const terminal = new Set<RequestStatus>(["Completed", "Failed", "Blocked"]);
const color: Record<RequestStatus, string> = { Running: "bg-ok", Unknown: "bg-info", Completed: "bg-ink-3", Failed: "bg-err", Blocked: "bg-warn" };
const code: Record<RequestStatus, string> = { Running: "RUN", Unknown: "UNK", Completed: "DONE", Failed: "FAIL", Blocked: "BLOCK" };
const elapsed = (iso: string, now: number) => { const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000)); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
const running = (r: BridgeRequest[]) => r.find((x) => x.status === "Running");
const current = (r: BridgeRequest[]) => running(r) ?? r.find((x) => x.status === "Unknown");
function Health({ item, name }: { item?: DoctorItem; name: string }) { const good = item?.ok; return <div className="flex items-center justify-between bg-surface px-2 py-2"><span className="text-ink-2">{name}</span><span className={`flex items-center gap-1 ${good ? "text-ink" : "text-ink-3"}`}><i className={`h-1.5 w-1.5 rounded-full ${good ? "bg-ok" : "bg-ink-3"}`} />{item ? good ? "Ready" : "Attention" : "Unknown"}</span></div>; }
function Row({ r, now, choose }: { r: BridgeRequest; now: number; choose: (id: string) => void }) { return <button type="button" onClick={() => choose(r.requestId)} className="grid w-full grid-cols-[52px_1fr_48px] items-center gap-2 rounded bg-raised px-2 py-2 text-left text-[10px] hover:bg-line"><span className="flex items-center gap-1 text-ink-2"><i className={`h-1.5 w-1.5 rounded-full ${color[r.status]}`} />{code[r.status]}</span><span className="min-w-0 truncate font-sans text-ink">{r.title}</span><span className="text-right text-ink-2">{elapsed(r.startedAt, now)}</span></button>; }
function NewRequestModal({ close, showNotice }: { close: () => void; showNotice: (notice: string) => void }) {
  const [prompt, setPrompt] = useState(""); const [preset, setPreset] = useState("current"); const [model, setModel] = useState("current"); const [newChat, setNewChat] = useState(true); const [conversationUrl, setConversationUrl] = useState(""); const [attachments, setAttachments] = useState<string[]>([]); const [submitting, setSubmitting] = useState(false); const [error, setError] = useState<string | null>(null);
  const chooseAttachments = () => { void window.bridgeGui.chooseNewAttachments().then((files) => { const next = [...attachments, ...files.filter((file) => !attachments.includes(file))]; if (next.length > 20) { setError("Attachments are limited to 20"); return; } setAttachments(next); }, () => setError("Could not open the attachment picker")); };
  const submit = (event: FormEvent) => { event.preventDefault(); if (!prompt.trim() || submitting) return; setSubmitting(true); setError(null); const input: NewSubmissionInput = { prompt, preset, model, newChat, ...(newChat ? {} : { conversationUrl }), attachments }; void window.bridgeGui.submitNew(input).then((result) => { if (result.ok) { showNotice(`Submitted request ${result.requestId}`); close(); } else setError(result.reason); }, () => setError("Could not contact the main process to submit the request")).finally(() => setSubmitting(false)); };
  return <section className="absolute inset-0 z-30 h-[480px] overflow-y-auto border-x border-b border-line bg-surface px-3 py-3 font-mono text-[10px] text-ink"><div className="mb-3 flex items-center justify-between"><span className="tracking-[.14em] text-ink-2">NEW REQUEST</span><button type="button" onClick={close} disabled={submitting} className="text-ink-3 hover:text-ink">Close</button></div><form onSubmit={submit} className="space-y-3"><label className="block text-ink-2">PROMPT<textarea required value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={8} className="mt-1 w-full resize-y rounded border border-line bg-base p-2 text-ink" /></label><p className={prompt.length > 20_000 ? "text-err" : "text-ink-3"}>{prompt.length.toLocaleString()} / 20,000 characters</p><div className="grid grid-cols-2 gap-2"><label className="text-ink-2">PRESET<select value={preset} onChange={(event) => setPreset(event.target.value)} className="mt-1 w-full rounded border border-line bg-base p-1.5 text-ink">{["current", "instant", "medium", "high", "extra_high", "pro"].map((value) => <option key={value}>{value}</option>)}</select></label><label className="text-ink-2">MODEL<select value={model} onChange={(event) => setModel(event.target.value)} className="mt-1 w-full rounded border border-line bg-base p-1.5 text-ink">{["current", "latest", "gpt-5.6-sol", "gpt-5.5"].map((value) => <option key={value}>{value}</option>)}</select></label></div><label className="flex items-center gap-2 text-ink-2"><input type="checkbox" checked={newChat} onChange={(event) => setNewChat(event.target.checked)} />New chat</label>{!newChat && <label className="block text-ink-2">CONVERSATION URL<input required pattern="https://chatgpt\\.com/c/[A-Za-z0-9-]+" value={conversationUrl} onChange={(event) => setConversationUrl(event.target.value)} placeholder="https://chatgpt.com/c/..." className="mt-1 w-full rounded border border-line bg-base p-1.5 text-ink" /></label>}<div><div className="flex items-center justify-between"><span className="text-ink-2">ATTACHMENTS ({attachments.length} / 20)</span><button type="button" onClick={chooseAttachments} disabled={submitting || attachments.length >= 20} className="text-info disabled:text-ink-3">Choose files</button></div>{attachments.length > 0 && <ul className="mt-1 space-y-1">{attachments.map((file) => <li key={file} className="flex items-center justify-between gap-2 rounded bg-base px-2 py-1"><span className="min-w-0 truncate">{file}</span><button type="button" onClick={() => setAttachments(attachments.filter((item) => item !== file))} disabled={submitting} className="text-err">Remove</button></li>)}</ul>}</div>{error && <p className="rounded border border-err/40 bg-raised p-2 text-err">{error}</p>}<div className="flex justify-end gap-2 border-t border-line pt-3"><button type="button" onClick={close} disabled={submitting} className="rounded border border-line bg-base px-3 py-1.5 text-ink-2">Cancel</button><button type="submit" disabled={submitting || !prompt.trim()} className="rounded border border-ok/40 bg-raised px-3 py-1.5 text-ok disabled:text-ink-3">{submitting ? "Submitting..." : "Submit"}</button></div></form></section>;
}
function SettingsModal({ close }: { close: () => void }) {
  const [openAtLogin, setOpenAtLogin] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void window.bridgeGui.getAutostart().then((value) => { if (alive) setOpenAtLogin(value); }, () => { if (alive) setError("Could not read the Windows startup setting"); });
    return () => { alive = false; };
  }, []);
  const toggle = () => {
    if (openAtLogin === null || saving) return;
    setSaving(true);
    setError(null);
    void window.bridgeGui.setAutostart(!openAtLogin).then(setOpenAtLogin, () => setError("Could not update the Windows startup setting")).finally(() => setSaving(false));
  };
  return <section className="absolute inset-0 z-30 h-[480px] overflow-y-auto border-x border-b border-line bg-surface px-3 py-3 font-mono text-[10px] text-ink"><div className="mb-3 flex items-center justify-between"><span className="tracking-[.14em] text-ink-2">SETTINGS</span><button type="button" onClick={close} disabled={saving} className="text-ink-3 hover:text-ink">Close</button></div><button type="button" role="switch" aria-checked={openAtLogin ?? false} onClick={toggle} disabled={openAtLogin === null || saving} className="flex w-full items-center justify-between rounded border border-line bg-base px-3 py-3 text-left hover:bg-raised disabled:text-ink-3"><span><span className="block text-ink">Start with Windows</span><span className="mt-1 block text-ink-3">Launch ChatGPT Bridge Control when you sign in.</span></span><span className={`ml-3 rounded border px-2 py-1 ${openAtLogin ? "border-ok/40 text-ok" : "border-line text-ink-3"}`}>{openAtLogin === null ? "..." : openAtLogin ? "ON" : "OFF"}</span></button>{error && <p className="mt-3 rounded border border-err/40 bg-raised p-2 text-err">{error}</p>}</section>;
}
function Popup({ state, now, choose, showNotice, newRequest, openSettings }: { state: BridgeGuiState; now: number; choose: (id: string) => void; showNotice: (notice: string) => void; newRequest: () => void; openSettings: () => void }) {
  const get = (n: string) => state.doctor.items.find((x) => x.name === n); const run = running(state.requests); const noResult = state.requests.filter((x) => x.status === "Unknown").sort((a, b) => b.requestMtimeMs - a.requestMtimeMs); const recent = state.requests.filter((x) => terminal.has(x.status)).sort((a, b) => (b.terminalSortMs ?? 0) - (a.terminalSortMs ?? 0)).slice(0, 5);
  const stop = () => { if (run) void window.bridgeGui.stopRequest(run.requestId).then((result) => showNotice(result.ok ? "Stop requested. The running process will stop cooperatively after its next poll." : `Stop not requested: ${result.reason}`), () => showNotice("Stop not requested: could not contact the main process")); };
  const refreshCookie = () => { void window.bridgeGui.refreshCookie().then((result) => showNotice(result.ok ? "Chrome opened for manual login. Log in, then close that window when done." : result.reason), () => showNotice("Could not contact the main process to refresh cookies")); };
  return <section className="h-[480px] overflow-y-auto border-x border-b border-line bg-surface px-3 py-3 font-mono text-[10px] text-ink"><div className="mb-3 flex justify-between"><span className="tracking-[.16em] text-ink-2">BRIDGE // CONTROL</span><span className="text-ink-3">READ ONLY</span></div><div className="mb-3 grid grid-cols-2 gap-px overflow-hidden rounded border border-line bg-line"><Health name="Bridge" item={get("daemon")} /><Health name="Chrome" item={get("profile.processes")} /><Health name="Auth" item={get("login")} /><Health name="Lock" item={get("lock")} /></div>{run && <button type="button" onClick={() => choose(run.requestId)} className="mb-3 w-full rounded border border-ok/40 bg-raised p-2 text-left hover:bg-line"><p className="mb-1 text-[9px] tracking-[.14em] text-ok">NOW RUNNING</p><p className="truncate font-sans text-ink">{run.title}</p></button>}{noResult.length > 0 && <section className="mb-3"><p className="mb-1.5 text-[9px] tracking-[.14em] text-ink-2">NO RESULT YET</p><div className="space-y-1">{noResult.slice(0, 4).map((r) => <Row key={r.requestId} r={r} now={now} choose={choose} />)}</div></section>}<section className="mb-3"><p className="mb-1.5 text-[9px] tracking-[.14em] text-ink-2">RECENT</p><div className="space-y-1">{recent.length ? recent.map((r) => <Row key={r.requestId} r={r} now={now} choose={choose} />) : <p className="rounded bg-raised px-2 py-2 text-ink-3">No terminal requests</p>}</div></section><div className="grid grid-cols-4 gap-1 border-t border-line pt-3"><button type="button" onClick={newRequest} className="rounded border border-line bg-base px-1 py-1.5 text-[9px] text-ink hover:bg-raised">New</button><button type="button" disabled={!run} onClick={stop} className={`rounded border border-line bg-base px-1 py-1.5 text-[9px] ${run ? "text-ink hover:bg-raised" : "text-ink-3"}`}>Stop</button><button type="button" onClick={refreshCookie} className="rounded border border-line bg-base px-1 py-1.5 text-[9px] text-ink hover:bg-raised">Refresh Cookie</button><button type="button" onClick={openSettings} className="rounded border border-line bg-base px-1 py-1.5 text-[9px] text-ink hover:bg-raised">Settings</button></div></section>;
}

type Tab = "Overview" | "Prompt" | "Response" | "Logs";
function Drawer({ id, back }: { id: string; back: () => void }) {
  const [detail, setDetail] = useState<RequestDetail | null>(null); const [error, setError] = useState<string | null>(null); const [tab, setTab] = useState<Tab>("Overview"); const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { let alive = true; setDetail(null); setError(null); void window.bridgeGui.requestDetail(id).then((v) => { if (!alive) return; if ("error" in v) setError(v.error); else setDetail(v); }); return () => { alive = false; }; }, [id]);
  const copy = async (text: string, fallback: string) => { try { await navigator.clipboard.writeText(text); setNotice("Copied"); } catch { const e = document.getElementById(fallback) as HTMLInputElement | HTMLTextAreaElement | null; e?.focus(); e?.select(); setNotice("Select-to-copy field focused"); } };
  const fileError = (e?: string) => e && <p className="mt-2 rounded border border-warn/40 bg-raised p-2 text-warn">Could not read file: {e}</p>;
  const label = (name: string, observed: string | null, requested: string | null) => <p><span className="text-ink-3">{name}<br /></span>{observed ?? requested ?? "—"} <span className="text-ink-3">{observed ? requested && observed !== requested ? `(observed; requested ${requested})` : "(observed)" : requested ? "(requested)" : ""}</span></p>;
  return <section className="absolute inset-0 z-10 h-[480px] translate-x-full border-x border-b border-line bg-surface px-3 py-3 font-mono text-[10px] text-ink transition-transform data-[open]:translate-x-0" data-open><div className="mb-3 flex justify-between"><button type="button" onClick={back} className="text-ink-2 hover:text-ink">‹ Back</button><span className="tracking-[.14em] text-ink-3">REQUEST DETAIL</span></div>{error && <p className="rounded border border-err/40 bg-raised p-2 text-err">{error}</p>}{!error && !detail && <p className="rounded bg-raised p-2 text-ink-2">Loading request files…</p>}{detail && <><div className="mb-3 grid grid-cols-4 gap-1 border-b border-line pb-3">{(["Overview", "Prompt", "Response", "Logs"] as Tab[]).map((x) => <button key={x} type="button" onClick={() => setTab(x)} className={`rounded px-1 py-1.5 ${tab === x ? "bg-raised text-ink" : "text-ink-3 hover:bg-raised"}`}>{x}</button>)}</div><div className="h-[394px] overflow-y-auto pr-1">{tab === "Overview" && <div className="space-y-3"><div><p className="text-ink-3">REQUEST ID</p><input id="request-id-copy" readOnly value={detail.requestId} onClick={(e) => e.currentTarget.select()} className="mt-1 w-full rounded border border-line bg-base px-2 py-1.5" /><button type="button" onClick={() => void copy(detail.requestId, "request-id-copy")} className="mt-1 text-info">Copy request ID</button></div><div><p className="text-ink-3">CHATGPT URL</p>{detail.conversationUrl ? <button type="button" onClick={() => void window.bridgeGui.openConversation(detail.requestId)} className="mt-1 text-info">Open in Browser ↗</button> : <p className="mt-1 text-ink-2">—</p>}</div><div className="grid grid-cols-2 gap-2">{label("PRESET", detail.observedPreset, detail.requestedPreset)}{label("MODEL", detail.observedModel, detail.requestedModel)}</div><div className="grid grid-cols-2 gap-2"><p><span className="text-ink-3">CALLER<br /></span>{detail.caller ?? "—"}</p><p><span className="text-ink-3">PROJECT<br /></span>{detail.project ?? "—"}</p></div>{detail.error && <p className="rounded border border-err/40 bg-raised p-2 text-err">{detail.error}</p>}{fileError(detail.fieldErrors.request ?? detail.fieldErrors.result ?? detail.fieldErrors.meta)}{notice && <p className="text-ok">{notice}</p>}</div>}{tab === "Prompt" && <>{detail.prompt === null ? <p className="text-ink-2">No prompt file.</p> : <pre className="whitespace-pre-wrap break-words rounded bg-base p-2">{detail.prompt}</pre>}{fileError(detail.fieldErrors.prompt)}</>}{tab === "Response" && <>{detail.response === null ? <p className="text-ink-2">{detail.status === null ? "No response yet." : "No response file."}</p> : <><button type="button" onClick={() => void copy(detail.response ?? "", "response-copy")} className="mb-2 text-info">Copy Markdown</button><textarea id="response-copy" readOnly value={detail.response} className="sr-only" /><pre className="whitespace-pre-wrap break-words rounded bg-base p-2">{detail.response}</pre>{detail.responseTruncated && <p className="mt-2 text-warn">Response truncated at 2 MB.</p>}</>}{fileError(detail.fieldErrors.response)}</>}{tab === "Logs" && <>{detail.log === null ? <p className="text-ink-2">No log file.</p> : <><pre className="whitespace-pre-wrap break-words rounded bg-base p-2">{detail.log}</pre>{detail.logTruncated && <p className="mt-2 text-warn">Showing last 200 KB of log (oldest to newest).</p>}</>}{fileError(detail.fieldErrors.log)}</>}</div></>}</section>;
}
function App() {
  const [state, setState] = useState(INITIAL);
  const [now, setNow] = useState(Date.now());
  const [selected, setSelected] = useState<string | null>(null);
  const [newRequest, setNewRequest] = useState(false);
  const [settings, setSettings] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [controls, setControls] = useState<WindowControlState>({ alwaysOnTop: true, muted: false });
  const [completionToasts, setCompletionToasts] = useState<{ id: number; message: string }[]>([]);
  const previousRequests = useRef<BridgeRequest[] | undefined>(undefined);
  const controlsRef = useRef(controls);
  const nextToastId = useRef(0);

  useEffect(() => { controlsRef.current = controls; }, [controls]);
  useEffect(() => {
    if (!notice) return;
    const timeoutId = window.setTimeout(() => setNotice(null), NOTICE_DURATION_MS);
    return () => window.clearTimeout(timeoutId);
  }, [notice]);
  useEffect(() => {
    const timeoutIds = new Set<number>();
    const off = window.bridgeGui.onState((next) => {
      const transitions = terminalTransitionsSinceLastPoll(previousRequests.current, next.requests);
      previousRequests.current = next.requests;
      setState(next);
      if (controlsRef.current.muted) return;
      for (const request of transitions) {
        const id = ++nextToastId.current;
        setCompletionToasts((toasts) => [...toasts, { id, message: `${request.status}: ${request.title}` }]);
        const timeoutId = window.setTimeout(() => {
          setCompletionToasts((toasts) => toasts.filter((toast) => toast.id !== id));
          timeoutIds.delete(timeoutId);
        }, COMPLETION_TOAST_DURATION_MS);
        timeoutIds.add(timeoutId);
      }
    });
    void window.bridgeGui.windowControls().then(setControls);
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { off(); window.clearInterval(timer); timeoutIds.forEach((id) => window.clearTimeout(id)); };
  }, []);

  const active = useMemo(() => current(state.requests), [state.requests]);
  const extra = state.requests.filter((request) => request.status === "Running" || request.status === "Unknown").length - (active ? 1 : 0);
  const toggleAlwaysOnTop = () => { void window.bridgeGui.toggleAlwaysOnTop().then(setControls); };
  const toggleMute = () => { void window.bridgeGui.toggleMute().then(setControls); };

  return <main className="relative overflow-hidden font-mono text-[11px] text-ink">
    <div className="flex h-10 border border-line bg-base">
      <button type="button" onClick={() => window.bridgeGui.togglePopup()} className="flex min-w-0 flex-1 items-center px-3 text-left hover:bg-raised">
        <span className={`mr-2 h-2 w-2 rounded-full ${active ? color[active.status] : "bg-ink-3"}`} />
        <span className="text-ink-2">{active ? code[active.status] : "IDLE"}</span>
        <span className="mx-3 min-w-0 flex-1 truncate font-sans">{active?.title ?? (state.lockHeld ? "Lock in use" : "Lock free")}</span>
        <span className="text-ink-2">{active ? elapsed(active.startedAt, now) : "--:--"}</span>
        {extra > 0 && <span className="ml-2 text-ink-2">+{extra}</span>}
      </button>
      <button type="button" onClick={toggleAlwaysOnTop} aria-pressed={controls.alwaysOnTop} title="Toggle always on top" className={`border-l border-line px-2 text-[9px] ${controls.alwaysOnTop ? "text-info" : "text-ink-3"}`}>PIN</button>
      <button type="button" onClick={toggleMute} aria-pressed={controls.muted} title="Toggle completion notifications" className={`border-l border-line px-2 text-[9px] ${controls.muted ? "text-warn" : "text-ink-2"}`}>{controls.muted ? "MUTE" : "ON"}</button>
    </div>
    <Popup state={state} now={now} choose={setSelected} showNotice={setNotice} newRequest={() => setNewRequest(true)} openSettings={() => setSettings(true)} />
    {completionToasts.length > 0 && <div aria-live="polite" className="pointer-events-none absolute bottom-3 left-3 right-3 z-20 space-y-2">{completionToasts.map((toast) => <p key={toast.id} role="status" className="completion-toast rounded border border-info/50 bg-raised p-2 text-info">{toast.message}</p>)}</div>}
    {notice && <p role="status" className="pointer-events-none absolute bottom-3 left-3 right-3 z-20 rounded border border-ok/40 bg-raised p-2 text-ok">{notice}</p>}
    {selected && <Drawer id={selected} back={() => setSelected(null)} />}
    {newRequest && <NewRequestModal close={() => setNewRequest(false)} showNotice={setNotice} />}
    {settings && <SettingsModal close={() => setSettings(false)} />}
  </main>;
}
createRoot(document.getElementById("root")!).render(<App />);
