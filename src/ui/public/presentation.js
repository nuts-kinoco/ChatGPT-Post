/** Cosmetic UI state only. Jobs, authority, destinations and secrets are never browser-persisted. */
export const THEME_KEY = "bridge.product.theme";
export function validTheme(value) {
  return value === "light" || value === "dark";
}
export function applyTheme(theme, document, storage) {
  if (!validTheme(theme)) return;
  (document.documentElement || document.body).setAttribute("data-theme", theme);
  try {
    storage?.setItem(THEME_KEY, theme);
  } catch {
    /* Host preferences remain authoritative. */
  }
}
export function choosePresentation(current, incoming) {
  if (
    incoming?.version !== "bridge-presentation-1" ||
    !Number.isSafeInteger(incoming.revision) ||
    incoming.revision < 1
  )
    return current;
  if (!validTheme(incoming.values?.theme)) return current;
  return current && current.revision > incoming.revision ? current : incoming;
}

export function mountPresentation({ api, document, window, statusLabel }) {
  const node = (id) => document.getElementById(id);
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view");
  const residentOnly = view === "resident";
  const candidate = window.bridgeProduct;
  const native =
    candidate && ["state", "action", "onState"].every((key) => typeof candidate[key] === "function")
      ? candidate
      : null;
  const themeStorage = () => {
    try {
      return window.localStorage;
    } catch {
      return undefined;
    }
  };
  let collapsed = residentOnly || (view !== "detail" && view !== "dock");
  let snapshot = null,
    nativeAvailable = false,
    pending = false,
    reading = false;
  let settingsRevision = 0;
  let nativeRevision = -1;
  const observed = new Map();
  const observedHosted = new Map();
  let hostedBaselineGeneration = -1;
  let localBaselineAt = null,
    hostedBaselineAt = null;
  let notificationBaselinePending = false,
    notificationsWereEnabled = null;
  let notificationGeneration = 0;
  let unreadResults = 0,
    unreadFailure = false;
  const renderResultIndicator = () => {
    node("resident-notice").hidden =
      unreadResults === 0 || snapshot?.values.completionNotifications !== true;
    node("resident-notice").textContent = `結果 ${unreadResults > 99 ? "99+" : unreadResults}`;
    node("resident-notice").className = `badge ${unreadFailure ? "error" : "done"} resident-notice`;
  };
  const announce = (text, error = false) => {
    node("presentation-status").textContent = text;
    node("presentation-status").className = error ? "notice danger" : "notice info";
  };
  let suspendedDialogs = [];
  const setCollapsed = (value, focus = false) => {
    const changed = value !== collapsed;
    if (value && changed) {
      suspendedDialogs = [...document.querySelectorAll("dialog[open]")];
      for (const dialog of [...suspendedDialogs].reverse()) dialog.close();
    }
    collapsed = value;
    document.body.classList.toggle("resident-view", collapsed);
    document.body.classList.toggle("resident-only", !!native && collapsed);
    document.body.classList.toggle("native-product", !!native);
    node("resident-bar").hidden = !collapsed;
    node("resident-return").hidden = collapsed || !!native;
    if (!collapsed && suspendedDialogs.length) {
      const dialogs = suspendedDialogs;
      suspendedDialogs = [];
      for (const dialog of dialogs) if (!dialog.open) dialog.showModal();
    } else if (focus && changed) node(collapsed ? "resident-expand" : "show-presentation").focus();
    // Visibility never rebuilds the document, changes selection, clears inputs or sends a task.
  };
  const nativeAction = (action) => {
    if (native)
      void native
        .action(action)
        .catch(() => announce("ウィンドウ操作を確認できません。トレイから戻れます", true));
  };
  const openSettings = () => {
    if (native && collapsed) {
      nativeAction("settings");
      return;
    }
    if (!native && collapsed) setCollapsed(false);
    if (!node("presentation-dialog").open) node("presentation-dialog").showModal();
  };
  function render() {
    const values = snapshot?.values;
    for (const theme of ["light", "dark"]) {
      const button = node(`theme-${theme}`);
      button.setAttribute("aria-pressed", String(values?.theme === theme));
      button.disabled = !values || pending;
    }
    for (const key of [
      "alwaysOnTop",
      "hideWhenInactive",
      "minimizeToTray",
      "completionNotifications",
    ]) {
      const button = node(`pref-${key}`);
      button.setAttribute("aria-checked", String(values?.[key] === true));
      button.disabled =
        !values || pending || (key !== "completionNotifications" && !nativeAvailable);
      button.title =
        key !== "completionNotifications" && !nativeAvailable
          ? "Bridgeデスクトップアプリで利用できます"
          : "";
    }
    node("presentation-native").textContent = nativeAvailable
      ? "デスクトップのウィンドウ操作に接続済み"
      : "ブラウザではテーマと画面内通知を設定できます。最前面・非アクティブ・トレイはデスクトップ専用です";
    node("presentation-revision").textContent = snapshot
      ? `設定 revision ${snapshot.revision} · 実行権限とは別の表示設定`
      : "設定を確認中";
    if (values) {
      if (notificationsWereEnabled === false && values.completionNotifications) {
        notificationBaselinePending = true;
        notificationGeneration++;
      }
      notificationsWereEnabled = values.completionNotifications;
      if (!values.completionNotifications) {
        unreadResults = 0;
        unreadFailure = false;
      }
      renderResultIndicator();
      applyTheme(values.theme, document, themeStorage());
      if (!values.completionNotifications) node("completion-toast").hidden = true;
    }
  }
  async function refresh() {
    if (reading || pending) return;
    reading = true;
    try {
      const response = await api("/api/presentation");
      snapshot = choosePresentation(snapshot, response.presentation);
      nativeAvailable = response.nativeControls?.available === true && !!native;
      render();
    } catch {
      announce(
        "表示設定を取得できません。接続を確認して再読込してください。依頼の状態は変更していません",
        true,
      );
    } finally {
      reading = false;
    }
  }
  async function save(patch) {
    if (!snapshot || pending) return;
    pending = true;
    render();
    try {
      const response = await api("/api/presentation", {
        expectedRevision: snapshot.revision,
        patch,
      });
      snapshot = choosePresentation(snapshot, response.presentation);
      announce("表示設定を保存しました。依頼の入力・進行中の処理・実行権限は変更していません");
    } catch (error) {
      announce(
        error.code === "stale_presentation"
          ? "別の画面で設定が変わりました。再読込してから選び直してください"
          : "保存結果を確認できません。自動で再送せず、設定を再読込してください",
        true,
      );
    } finally {
      pending = false;
      render();
    }
  }
  node("resident-notice").addEventListener("click", () => {
    unreadResults = 0;
    unreadFailure = false;
    renderResultIndicator();
    if (native) nativeAction("expand");
    else setCollapsed(false, true);
  });
  node("resident-expand").addEventListener("click", () => {
    if (native) nativeAction("expand");
    else setCollapsed(false, true);
  });
  for (const id of ["collapse-product", "resident-return"])
    node(id).addEventListener("click", () => {
      if (native) nativeAction("collapse");
      else setCollapsed(true, true);
    });
  for (const button of document.querySelectorAll("[data-collapse-product]"))
    button.addEventListener("click", () => {
      if (native) nativeAction("collapse");
      else setCollapsed(true, true);
    });
  node("minimize-product").addEventListener("click", () => {
    if (native) nativeAction("minimize");
    else setCollapsed(true, true);
  });
  for (const id of ["show-presentation", "resident-settings"])
    node(id).addEventListener("click", openSettings);
  node("close-presentation").addEventListener("click", () => node("presentation-dialog").close());
  node("refresh-presentation").addEventListener("click", () => void refresh());
  for (const theme of ["light", "dark"])
    node(`theme-${theme}`).addEventListener("click", () => void save({ theme }));
  for (const key of [
    "alwaysOnTop",
    "hideWhenInactive",
    "minimizeToTray",
    "completionNotifications",
  ])
    node(`pref-${key}`).addEventListener("click", () => {
      if (snapshot && !node(`pref-${key}`).disabled) void save({ [key]: !snapshot.values[key] });
    });
  node("close-completion-toast").addEventListener("click", () => {
    node("completion-toast").hidden = true;
  });
  node("disable-completion-toast").addEventListener(
    "click",
    () => void save({ completionNotifications: false }),
  );
  const nativeState = (state) => {
    if (
      !state ||
      !Number.isSafeInteger(state.revision) ||
      state.revision < 0 ||
      state.revision < nativeRevision ||
      !Number.isSafeInteger(state.settingsRevision)
    )
      return;
    nativeRevision = state.revision;
    if (state.mode === "collapsed") setCollapsed(true, true);
    else if (state.mode === "expanded") setCollapsed(false, true);
    if (state.settingsRevision > settingsRevision && state.mode === "expanded") openSettings();
    settingsRevision = Math.max(settingsRevision, state.settingsRevision);
    void refresh();
  };
  if (native) {
    void native
      .state()
      .then(nativeState)
      .catch(() => {});
    native.onState(nativeState);
  }
  try {
    const saved = window.localStorage?.getItem(THEME_KEY);
    if (validTheme(saved)) applyTheme(saved, document, window.localStorage);
  } catch {
    /* Optional cosmetic cache only. */
  }
  setCollapsed(collapsed);
  render();
  void refresh();
  setInterval(() => {
    if (!document.hidden) void refresh();
  }, 5000);
  return {
    closeDialog(id) {
      const dialog = node(id);
      suspendedDialogs = suspendedDialogs.filter((value) => value !== dialog);
      dialog?.close();
    },
    refresh,
    observationGeneration: () => notificationGeneration,
    renderTask(task) {
      const title = task?.summary?.title || "依頼を選んでください";
      node("resident-title").textContent = title;
      node("resident-title").title = title;
      node("resident-status").textContent = task ? statusLabel(task.result.status) : "待機中";
      node("resident-profile").textContent = task?.result.synthetic ? "デモ" : "";
    },
    renderOperation(operation) {
      if (!operation) return;
      const title =
        operation.kind === "fanout"
          ? `まとめて依頼 ${operation.available}/${operation.total} 応答`
          : operation.presentation.title;
      node("resident-title").textContent = title;
      node("resident-title").title = title;
      node("resident-status").textContent =
        operation.kind === "fanout"
          ? "まとめて確認"
          : ({
              completed: "応答あり",
              unknown: "状況不明",
              failed: "失敗",
              blocked_auth: "認証待ち",
              approved: "承認済み",
              awaiting_approval: "承認待ち",
            }[operation.state] ?? "未確認");
      node("resident-profile").textContent = "";
    },
    observeHosted(tasks, readGeneration, readStartedAt = null) {
      if (readGeneration !== notificationGeneration) return;
      const baseline = hostedBaselineGeneration !== notificationGeneration;
      for (const task of tasks) {
        const key = task.binding.requestId;
        const value = `${task.state}:${task.terminalAvailable}`;
        const previous = observedHosted.get(key);
        if (previous && previous.revision > task.binding.revision) continue;
        observedHosted.set(key, { value, revision: task.binding.revision });
        const newlyCompleted =
          !previous &&
          hostedBaselineAt !== null &&
          Date.parse(task.presentation.observedAt) > hostedBaselineAt;
        if (
          !baseline &&
          ((previous && previous.value !== value) || newlyCompleted) &&
          (hostedBaselineAt === null ||
            Date.parse(task.presentation.observedAt) > hostedBaselineAt) &&
          task.terminalAvailable &&
          ["completed", "failed"].includes(task.state) &&
          snapshot?.values.completionNotifications
        ) {
          unreadResults = Math.min(100, unreadResults + 1);
          unreadFailure ||= task.state === "failed";
          const label =
            task.state === "completed" ? "通常チャットの応答あり" : "通常チャットの失敗を確認";
          node("resident-notice").title =
            `${label}: ${task.presentation.title}。成果物受領の証明は別に確認します`;
          node("completion-message").textContent = `${label}: ${task.presentation.title}`;
          node("completion-toast").hidden = false;
          renderResultIndicator();
        }
      }
      while (observedHosted.size > 1000) observedHosted.delete(observedHosted.keys().next().value);
      if (baseline)
        hostedBaselineAt = Number.isFinite(Date.parse(readStartedAt))
          ? Date.parse(readStartedAt)
          : null;
      hostedBaselineGeneration = notificationGeneration;
    },
    observeTasks(tasks, freshSnapshot = false, readGeneration = null, readStartedAt = null) {
      if (freshSnapshot && readGeneration !== notificationGeneration) return;
      if (notificationBaselinePending) {
        for (const task of tasks) observed.set(task.requestId, task.status);
        if (freshSnapshot) {
          notificationBaselinePending = false;
          localBaselineAt = Number.isFinite(Date.parse(readStartedAt))
            ? Date.parse(readStartedAt)
            : null;
        }
        return;
      }
      for (const task of tasks) {
        const previous = observed.get(task.requestId);
        observed.set(task.requestId, task.status);
        if (
          ((previous && previous !== task.status) ||
            (!previous &&
              localBaselineAt !== null &&
              Date.parse(task.updatedAt) > localBaselineAt)) &&
          (localBaselineAt === null || Date.parse(task.updatedAt) > localBaselineAt) &&
          ["succeeded", "failed", "cancelled"].includes(task.status) &&
          snapshot?.values.completionNotifications
        ) {
          unreadResults = Math.min(100, unreadResults + 1);
          unreadFailure ||= task.status === "failed";
          node("resident-notice").title =
            `新しい結果: ${statusLabel(task.status)} / ${task.title}。依頼一覧で確認できます。結果ACKは変更しません`;
          renderResultIndicator();
          node("completion-message").textContent = `${statusLabel(task.status)}: ${task.title}`;
          node("completion-toast").hidden = false;
          // No native show/focus/resize call: completion never expands the resident bar.
        }
      }
      if (freshSnapshot && localBaselineAt === null && Number.isFinite(Date.parse(readStartedAt)))
        localBaselineAt = Date.parse(readStartedAt);
      while (observed.size > 1000) observed.delete(observed.keys().next().value);
    },
  };
}
