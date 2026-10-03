/** Native presentation only. No task/approval/process controls live in this state machine. */
export interface ProductPreferences {
  theme: "light" | "dark";
  alwaysOnTop: boolean;
  hideWhenInactive: boolean;
  minimizeToTray: boolean;
  completionNotifications: boolean;
}
export type ProductMode = "collapsed" | "expanded" | "hidden";
export type ProductAction = "expand" | "collapse" | "hide" | "restore" | "minimize" | "settings";
export interface ProductWindowSnapshot {
  revision: number;
  mode: ProductMode;
  lastVisible: "collapsed" | "expanded";
  settingsRevision: number;
  preferences: ProductPreferences;
}
export interface ProductWindowPorts {
  prepare(mode: "collapsed" | "expanded"): Promise<void>;
  activate(mode: ProductMode): void;
  preferencesChanged(preferences: ProductPreferences): void;
  anyFocused(): boolean;
}
export function isProductAction(value: unknown): value is ProductAction {
  return typeof value === "string" && ["expand", "collapse", "hide", "restore", "minimize", "settings"].includes(value);
}
export class ProductWindowState {
  private revision = 0;
  private listeners = new Set<(value: ProductWindowSnapshot) => void>();
  private value: ProductWindowSnapshot = {
    revision: 0, mode: "collapsed", lastVisible: "collapsed", settingsRevision: 0,
    preferences: { theme:"light", alwaysOnTop:false, hideWhenInactive:false, minimizeToTray:false, completionNotifications:true },
  };
  constructor(private readonly ports: ProductWindowPorts) {}
  snapshot(): ProductWindowSnapshot { return structuredClone(this.value); }
  subscribe(callback: (value: ProductWindowSnapshot) => void): () => void {
    this.listeners.add(callback); return () => this.listeners.delete(callback);
  }
  private publish(): void { this.value.revision++; for (const callback of this.listeners) callback(this.snapshot()); }
  applyPreferences(preferences: ProductPreferences): void {
    this.value.preferences = structuredClone(preferences);
    this.ports.preferencesChanged(structuredClone(preferences));
    this.publish(); // A theme/notification change must never show, focus or expand a window.
  }
  async action(action: ProductAction): Promise<ProductWindowSnapshot> {
    if (!isProductAction(action)) throw new Error("product_window_action_denied");
    const mode: ProductMode = action === "expand" || action === "settings" ? "expanded"
      : action === "collapse" ? "collapsed"
      : action === "restore" ? this.value.lastVisible
      : action === "minimize" ? this.value.preferences.minimizeToTray ? "hidden" : "collapsed"
      : "hidden";
    const revision = ++this.revision;
    if (mode !== "hidden") await this.ports.prepare(mode);
    if (revision !== this.revision) return this.snapshot();
    this.value.mode = mode;
    if (mode !== "hidden") this.value.lastVisible = mode;
    if (action === "settings") this.value.settingsRevision++;
    this.ports.activate(mode);
    this.publish();
    return this.snapshot();
  }
  async inactive(): Promise<void> {
    if (this.value.preferences.hideWhenInactive && !this.ports.anyFocused()) await this.action("hide");
  }
}
