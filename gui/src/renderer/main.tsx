import { createRoot } from "react-dom/client";
import "./styles.css";

function App() {
  return (
    <main className="flex h-screen items-center overflow-hidden border border-line bg-base px-3 font-mono text-[11px] text-ink">
      <span aria-label="Bridge status: idle" className="mr-2 h-2 w-2 shrink-0 rounded-full bg-ink-3" />
      <span className="shrink-0 text-ink-2">IDLE</span>
      <span className="mx-3 min-w-0 flex-1 truncate font-sans text-ink">—</span>
      <span className="shrink-0 text-ink-2">--:--</span>
      <span aria-hidden="true" className="ml-3 text-ink-3">⌄</span>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
