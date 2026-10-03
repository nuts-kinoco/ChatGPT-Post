/** Per-actor settings and distinct explicit actions. Raw credentials stay in the native provider. */
export function mountNotificationPreferences({
  api,
  document,
  endpoint = "/api/settings/notifications",
  onClose = () => {},
}) {
  const node = (name) => document.getElementById(`notification-${name}`);
  let current = null,
    dirty = false,
    pending = false,
    uncertain = false,
    reconciled = true,
    draftRevision = null,
    selected = new Set(),
    enabled = false,
    epoch = 0,
    destroyed = false,
    actionDestination = "",
    action = null,
    actionPending = false,
    actionReading = false,
    actionVerified = false;
  const listeners = [];
  const listen = (name, event, fn) => {
    node(name).addEventListener(event, fn);
    listeners.push([node(name), event, fn]);
  };
  const message = (text, danger = false) => {
    node("message").textContent = text;
    node("message").className = `notice ${danger ? "danger" : "info"}`;
  };
  const destinations = () =>
    current?.state === "available" && current.destinations.state === "available"
      ? current.destinations.value
      : [];
  const validSelection = () =>
    !enabled ||
    (selected.size > 0 &&
      selected.size <= 8 &&
      [...selected].every((id) =>
        destinations().some((value) => value.destinationId === id && value.transportAvailable),
      ));
  const actionTerminal = () =>
    actionVerified && action && !["queued", "sending"].includes(action.state);
  const actionReady = () =>
    current?.state === "available" &&
    current.sendingImplemented &&
    current.controls?.version === "bridge-notification-controls-1" &&
    !pending &&
    !actionPending &&
    !actionReading &&
    !dirty &&
    !uncertain &&
    draftRevision === current.preferences.revision &&
    (!action || actionTerminal());
  const credential = () =>
    current?.controls?.destinations.find((row) => row.destinationId === actionDestination);
  const controls = () => {
    const available = current?.state === "available";
    const busy = pending || actionPending || actionReading;
    node("enabled").disabled = busy || !available || (!current.canEnable && !enabled);
    node("fields").disabled = busy || !available;
    node("save").disabled = busy || !available || !dirty || uncertain || !validSelection();
    node("reset-draft").disabled = busy || (uncertain && !reconciled);
    node("action-destination").disabled = busy || !available || !current.controls;
    node("test").disabled =
      !actionReady() ||
      credential()?.credentialState !== "configured" ||
      !destinations().some(
        (row) => row.destinationId === actionDestination && row.transportAvailable,
      );
    node("credentials").disabled =
      !actionReady() || !credential() || !current.controls.credentialInteractionAvailable;
    node("action-refresh").disabled = busy || !action;
    node("refresh").disabled = busy;
  };
  const fill = () => {
    enabled = current?.state === "available" ? current.preferences.authBlocked.enabled : false;
    selected = new Set(
      current?.state === "available" ? current.preferences.authBlocked.destinationIds : [],
    );
    draftRevision = current?.state === "available" ? current.preferences.revision : null;
    dirty = false;
  };
  const renderChoices = () => {
    const values = destinations();
    const rows = [];
    for (const value of values) {
      const row = document.createElement("label"),
        checkbox = document.createElement("input"),
        text = document.createElement("span");
      checkbox.type = "checkbox";
      checkbox.value = value.destinationId;
      checkbox.checked = selected.has(value.destinationId);
      checkbox.disabled = !value.transportAvailable && !selected.has(value.destinationId);
      text.textContent = `${value.channel === "email" ? "Email" : "Discord"} · ${value.label}${value.transportAvailable ? "" : `（利用不可：${value.unavailableReason}）`}`;
      checkbox.addEventListener("change", () => {
        if (pending || actionPending || actionReading || checkbox.disabled) return;
        if (checkbox.checked && !value.transportAvailable) {
          checkbox.checked = false;
          message(`通知先を利用できません：${value.unavailableReason}`, true);
          return;
        }
        if (checkbox.checked) selected.add(value.destinationId);
        else selected.delete(value.destinationId);
        if (selected.size > 8) {
          selected.delete(value.destinationId);
          checkbox.checked = false;
          message("通知先は8件まで選べます", true);
        }
        if (!value.transportAvailable) checkbox.disabled = true;
        dirty = true;
        controls();
      });
      row.append(checkbox, text);
      rows.push(row);
    }
    for (const id of selected)
      if (!values.some((value) => value.destinationId === id)) {
        const row = document.createElement("p");
        row.textContent = `保存済み宛先 ${id}：登録状態を確認できません。通知希望をOFFにすることはできます`;
        rows.push(row);
      }
    if (rows.length === 0) {
      const row = document.createElement("p");
      row.textContent = "利用可能な登録先はありません。ホスト側のEmail・Discord設定が必要です";
      rows.push(row);
    }
    node("destinations").replaceChildren(...rows);
  };
  const stateText = {
    queued: "待機中",
    sending: "処理中",
    delivered: "配信済み",
    not_sent: "未送信",
    uncertain: "結果不明（自動再送しません）",
    cancelled: "取り消し済み",
    saved: "保存済み",
    rejected: "拒否されました",
    unknown: "結果を確認できません（自動再送しません）",
  };
  const renderAction = () => {
    node("action-state").textContent = action
      ? `${action.kind === "test" ? "テスト送信" : "安全なローカル設定"} · ${action.destinationId} · ${stateText[action.state] ?? stateText.unknown}`
      : "未実行です。保存だけでは送信しません";
    node("action-state").className =
      `notice ${action && ["unknown", "uncertain"].includes(action.state) ? "danger" : "info"}`;
  };
  const renderActions = () => {
    const implemented = current?.state === "available" && current.sendingImplemented;
    node("actions").hidden = !implemented;
    const values = destinations();
    if (!values.some((row) => row.destinationId === actionDestination))
      actionDestination = values[0]?.destinationId ?? "";
    const options = values.map((value) => {
      const option = document.createElement("option");
      option.value = value.destinationId;
      option.textContent = `${value.channel === "email" ? "Email" : "Discord"} · ${value.label}`;
      return option;
    });
    node("action-destination").replaceChildren(...options);
    node("action-destination").value = actionDestination;
    const state = credential()?.credentialState;
    node("credential-state").textContent =
      state === "configured"
        ? "認証情報：設定済み ••••••••"
        : state === "missing"
          ? "認証情報：未設定"
          : "認証情報：利用不可";
    const recent = (current?.controls?.recent ?? []).slice(0, 16).map((row) => {
      const item = document.createElement("p");
      item.textContent = `${row.destinationId} · ${row.kind === "test" ? "テスト" : "認証ブロック"} · ${stateText[row.state] ?? stateText.unknown} · 試行 ${row.attempts}/3`;
      return item;
    });
    node("recent").replaceChildren(...recent);
    renderAction();
  };
  const render = () => {
    if (!dirty) fill();
    node("enabled").checked = enabled;
    node("state").textContent =
      current?.state === "available"
        ? `${current.profile === "demo" ? "デモ専用" : "本番専用"} · 利用者別の保存設定 · revision ${current.preferences.revision}`
        : "通知設定の保存先を確認できません";
    const reason =
      current?.state === "available"
        ? current.unavailableReason
        : (current?.reason ?? "notification_preferences_unavailable");
    node("availability").textContent = reason
      ? `利用できない理由：${reason}`
      : current.sendingImplemented
        ? "保存は通知希望だけを更新します。テスト送信と安全なローカル設定は別の操作です"
        : "通知送信は未構成です。登録先の設定だけを保存できます";
    node("availability").className = `notice ${reason ? "danger" : "info"}`;
    renderChoices();
    renderActions();
    controls();
  };
  const validControlsView = (value) =>
    value == null ||
    (value.version === "bridge-notification-controls-1" &&
      typeof value.credentialInteractionAvailable === "boolean" &&
      Array.isArray(value.destinations) &&
      value.destinations.length <= 64 &&
      Array.isArray(value.recent) &&
      value.recent.length <= 16 &&
      value.destinations.every(
        (row) =>
          row &&
          /^[a-z][a-z0-9_-]{0,63}$/.test(row.destinationId) &&
          ["configured", "missing", "unavailable"].includes(row.credentialState),
      ) &&
      value.recent.every(
        (row) =>
          row &&
          /^[a-z][a-z0-9_-]{0,63}$/.test(row.destinationId) &&
          ["test", "human_check"].includes(row.kind) &&
          ["queued", "sending", "delivered", "not_sent", "uncertain", "cancelled"].includes(
            row.state,
          ) &&
          Number.isSafeInteger(row.attempts) &&
          row.attempts >= 0 &&
          row.attempts <= 3,
      ));
  const accept = (response) => {
    const incoming = response?.notifications;
    if (
      incoming?.version !== "bridge-notification-settings-1" ||
      !["available", "unavailable"].includes(incoming.state) ||
      typeof incoming.sendingImplemented !== "boolean" ||
      !validControlsView(incoming.controls)
    )
      throw new Error("notification_response_invalid");
    if (
      incoming.state === "available" &&
      current?.state === "available" &&
      incoming.preferences.revision < current.preferences.revision
    )
      return false;
    current = incoming;
    render();
    return true;
  };
  const refresh = async () => {
    if (destroyed || pending || actionPending || actionReading) return;
    const reading = ++epoch;
    try {
      const response = await api(endpoint);
      if (destroyed || reading !== epoch || !accept(response)) return;
      reconciled = true;
      if (
        dirty &&
        draftRevision !== (current.state === "available" ? current.preferences.revision : null)
      ) {
        uncertain = true;
        message(
          "設定が更新されています。編集内容は保持しています。編集を取り消して最新設定を確認してください",
          true,
        );
      } else if (uncertain)
        message("保存済み設定を再読込しました。編集を取り消して内容を確認してください", true);
      else
        message(
          current.state === "available"
            ? "利用者別の通知設定を表示しています。通知は送信していません"
            : "設定を確認できません",
          current.state !== "available",
        );
      controls();
    } catch {
      if (!destroyed && reading === epoch) {
        uncertain = true;
        reconciled = false;
        message("設定を読み込めません。編集内容を保持しています。再読込で確認してください", true);
        controls();
      }
    }
  };
  listen("enabled", "change", () => {
    if (pending || actionPending || actionReading || node("enabled").disabled) return;
    enabled = node("enabled").checked;
    dirty = true;
    controls();
  });
  listen("form", "submit", async (event) => {
    event.preventDefault();
    if (
      destroyed ||
      pending ||
      actionPending ||
      actionReading ||
      uncertain ||
      !dirty ||
      current?.state !== "available" ||
      draftRevision === null ||
      !validSelection()
    )
      return;
    const settings = { enabled, destinationIds: [...selected].sort() },
      expectedRevision = draftRevision;
    pending = true;
    epoch++;
    controls();
    try {
      const response = await api(endpoint, { expectedRevision, settings });
      if (destroyed) return;
      if (
        !accept(response) ||
        current.state !== "available" ||
        current.preferences.revision !== expectedRevision + 1 ||
        current.preferences.authBlocked.enabled !== settings.enabled ||
        JSON.stringify([...current.preferences.authBlocked.destinationIds].sort()) !==
          JSON.stringify(settings.destinationIds)
      )
        throw new Error("notification_save_unconfirmed");
      dirty = false;
      uncertain = false;
      reconciled = true;
      fill();
      render();
      message("通知先設定を保存しました。送信・テスト送信は行っていません");
    } catch {
      if (!destroyed) {
        uncertain = true;
        reconciled = false;
        message(
          "保存結果を確認できません。自動再送しません。再読込して保存済み設定を確認してください",
          true,
        );
      }
    } finally {
      pending = false;
      if (!destroyed) controls();
    }
  });
  const acceptAction = (response, expected) => {
    const value = response?.action;
    if (
      !value ||
      Object.keys(value).sort().join() !== "actionId,destinationId,kind,state" ||
      value.actionId !== expected.actionId ||
      value.kind !== expected.kind ||
      value.destinationId !== expected.destinationId ||
      !(
        value.kind === "test"
          ? ["queued", "sending", "delivered", "not_sent", "uncertain", "cancelled"]
          : ["queued", "sending", "saved", "rejected", "uncertain", "cancelled"]
      ).includes(value.state)
    )
      throw new Error("notification_action_response_invalid");
    action = {
      actionId: value.actionId,
      destinationId: value.destinationId,
      kind: value.kind,
      state: value.state,
    };
    actionVerified = true;
    renderAction();
  };
  const startAction = async (kind) => {
    if (destroyed || !actionReady() || node(kind === "test" ? "test" : "credentials").disabled)
      return;
    let actionId;
    try {
      actionId = globalThis.crypto.randomUUID();
    } catch {
      message("安全な操作IDを作成できません。この環境からは実行できません", true);
      return;
    }
    const input = { actionId, destinationId: actionDestination, expectedRevision: draftRevision };
    action = { actionId, destinationId: actionDestination, kind, state: "sending" };
    actionVerified = false;
    actionPending = true;
    epoch++; // Older settings reads cannot replace the revision used by this action.
    renderAction();
    controls();
    try {
      const response = await api(`${endpoint}/${kind === "test" ? "test" : "credentials"}`, input);
      if (destroyed) return;
      acceptAction(response, action);
      message(
        kind === "test"
          ? "明示した1回のテスト結果です。自動通知がOFFでも設定は変更しません"
          : "安全なローカル設定の結果です。認証情報の状態は再読込で確認してください",
      );
    } catch (error) {
      if (!destroyed) {
        if (
          error?.code === "stale_notification_preferences" &&
          error.status === 409 &&
          error.uncertain === false
        ) {
          // This fixed pre-admission rejection proves no action was admitted. Refresh first.
          action = null;
          actionVerified = false;
          uncertain = true;
          reconciled = false;
          renderAction();
          message(
            "設定が更新されたため操作は受け付けられませんでした。再読込して最新設定を確認してください",
            true,
          );
        } else {
          action.state = "unknown";
          actionVerified = false;
          renderAction();
          message("操作結果を確認できません。再実行せず、操作状態を確認してください", true);
        }
      }
    } finally {
      actionPending = false;
      if (!destroyed) controls();
    }
  };
  const refreshAction = async () => {
    if (destroyed || !action || pending || actionPending || actionReading) return;
    const expected = { ...action };
    actionReading = true;
    controls();
    try {
      const response = await api(`${endpoint}/actions/${expected.actionId}`);
      if (destroyed) return;
      acceptAction(response, expected);
      message(
        actionTerminal()
          ? "操作状態を確認しました。新しい操作には明示的なボタンクリックが必要です"
          : "操作はまだ終了していません。状態の再確認だけを行ってください",
      );
    } catch {
      if (!destroyed) {
        // An unavailable lookup cannot prove whether the earlier effect happened.
        actionVerified = false;
        message("操作状態を確認できません。自動再送は行いません", true);
      }
    } finally {
      actionReading = false;
      if (!destroyed) controls();
    }
  };
  listen("action-destination", "change", () => {
    if (destroyed || pending || actionPending || actionReading) return;
    const value = node("action-destination").value;
    if (!destinations().some((row) => row.destinationId === value)) return;
    actionDestination = value;
    renderActions();
    controls();
  });
  listen("test", "click", () => startAction("test"));
  listen("credentials", "click", () => startAction("credential"));
  listen("action-refresh", "click", refreshAction);
  listen("refresh", "click", () => void refresh());
  listen("reset-draft", "click", () => {
    if (pending || actionPending || actionReading || (uncertain && !reconciled)) return;
    uncertain = false;
    fill();
    render();
    message("保存済み設定へ戻しました");
  });
  listen("close", "click", () => {
    node("panel").hidden = true;
    onClose();
  });
  return {
    open: async () => {
      node("panel").hidden = false;
      await refresh();
    },
    close: () => {
      node("panel").hidden = true;
    },
    refresh,
    destroy: () => {
      destroyed = true;
      epoch++;
      for (const [element, event, fn] of listeners) element.removeEventListener(event, fn);
      node("destinations").replaceChildren();
    },
  };
}
