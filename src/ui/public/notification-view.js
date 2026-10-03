/** Per-actor registered-recipient settings. No raw address/token input and no send path. */
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
    destroyed = false;
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
  const controls = () => {
    const available = current?.state === "available";
    node("enabled").disabled = pending || !available || (!current.canEnable && !enabled);
    node("fields").disabled = pending || !available;
    node("save").disabled = pending || !available || !dirty || uncertain || !validSelection();
    node("reset-draft").disabled = pending || (uncertain && !reconciled);
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
        if (pending || checkbox.disabled) return;
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
      : "登録先の設定を保存できます。この画面から通知は送信しません";
    node("availability").className = `notice ${reason ? "danger" : "info"}`;
    renderChoices();
    controls();
  };
  const accept = (response) => {
    const incoming = response?.notifications;
    if (
      incoming?.version !== "bridge-notification-settings-1" ||
      !["available", "unavailable"].includes(incoming.state) ||
      incoming.sendingImplemented !== false
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
    if (destroyed || pending) return;
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
    if (pending || node("enabled").disabled) return;
    enabled = node("enabled").checked;
    dirty = true;
    controls();
  });
  listen("form", "submit", async (event) => {
    event.preventDefault();
    if (
      destroyed ||
      pending ||
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
  listen("refresh", "click", () => void refresh());
  listen("reset-draft", "click", () => {
    if (pending || (uncertain && !reconciled)) return;
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
