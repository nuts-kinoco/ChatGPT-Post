import path from "node:path";
import { pathToFileURL } from "node:url";

export type ProductUiProfile = "production" | "demo";
export interface ProductUiServer {
  url: string;
  origin: string;
  token: string;
  close(): Promise<void>;
}
export interface ProductUiOptions {
  stateDir: string;
  profile: ProductUiProfile;
  port: number;
}
export interface ProductUiModule {
  startUiServer(options: ProductUiOptions): Promise<ProductUiServer>;
}

export function productUiProfile(value: string | undefined): ProductUiProfile {
  if (value === undefined || value === "production") return "production";
  if (value === "demo") return "demo";
  throw new Error("CHATGPT_BRIDGE_UI_PROFILE must be production or demo");
}

/** Only the selected local checkout can provide the trusted main-process module. */
export async function startProductUi(
  root: string,
  env: NodeJS.ProcessEnv,
  load: (url: string) => Promise<ProductUiModule> = (url) => import(url),
): Promise<ProductUiServer> {
  const profile = productUiProfile(env.CHATGPT_BRIDGE_UI_PROFILE);
  const moduleUrl = pathToFileURL(path.join(root, "dist", "ui", "server.js")).href;
  const runtime = await load(moduleUrl);
  if (typeof runtime.startUiServer !== "function") throw new Error("Bridge v2 UI build is missing; run npm run build in the Bridge root");
  return runtime.startUiServer({
    profile,
    stateDir: path.resolve(env.CHATGPT_BRIDGE_RUNTIME_DIR ?? path.join(root, "runtime")),
    port: 0,
  });
}

/** Do not forward arbitrary URLs, API endpoints, fragments or query parameters to new windows. */
export function productNavigation(raw: string, origin: string): { view: "dock" | "detail"; tab?: string; task?: string } | null {
  try {
    const url = new URL(raw);
    if (url.origin !== origin || url.username || url.password || url.pathname !== "/") return null;
    const keys = [...url.searchParams.keys()];
    if (new Set(keys).size !== keys.length) return null;
    const view = url.searchParams.get("view");
    if (view !== "dock" && view !== "detail") return null;
    if ([...url.searchParams.keys()].some((key) => !["view", "tab", "task"].includes(key))) return null;
    const tab = url.searchParams.get("tab");
    if (tab && !["approval", "payload", "evidence", "recovery"].includes(tab)) return null;
    const task = url.searchParams.get("task");
    if (task && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(task)) return null;
    return { view, ...(tab ? { tab } : {}), ...(task ? { task } : {}) };
  } catch { return null; }
}

export function productUrl(server: ProductUiServer, view: "dock" | "detail", navigation?: { tab?: string; task?: string }): string {
  const url = new URL("/", server.origin);
  url.searchParams.set("view", view);
  if (navigation?.tab) url.searchParams.set("tab", navigation.tab);
  if (navigation?.task) url.searchParams.set("task", navigation.task);
  url.hash = new URLSearchParams({ token: server.token }).toString();
  return url.href;
}

/** Existing details keep their own draft and task selection, even after Close/hide. */
export function revealExistingProductDetail(window: {
  isMinimized(): boolean; restore(): void; show(): void; focus(): void;
} | undefined): boolean {
  if (!window) return false;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  return true;
}

/** Native load errors may contain a full capability URL. Never interpolate them into UI. */
export function productStartupError(error: unknown): string {
  if (error instanceof Error && error.message === "CHATGPT_BRIDGE_UI_PROFILE must be production or demo")
    return "CHATGPT_BRIDGE_UI_PROFILE は production または demo を指定してください。";
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND")
    return "Bridge v2 のビルドまたは依存関係が見つかりません。";
  if (code === "ERR_UNKNOWN_BUILTIN_MODULE")
    return "この実行環境は必要な Node.js 組み込み機能に対応していません。";
  return "ローカル UI サーバーまたは画面を起動できませんでした。";
}
