/** Same-frame manual reference counter. No localStorage, provider calls or observation injection. */
const FIELDS = ["limit", "threshold", "start", "end", "timezone", "other"];
const EMPTY = {
  limit: null,
  warnRemaining: null,
  startsAt: null,
  endsAt: null,
  timeZone: null,
  otherUsage: null,
};
export function parseCounterFields(fields) {
  const number = (text, minimum = 0) => {
    if (text.trim() === "") return null;
    if (!/^\d+$/.test(text.trim())) throw new Error("回数は整数で入力してください");
    const result = Number(text);
    if (!Number.isSafeInteger(result) || result < minimum || result > 100000)
      throw new Error("回数は指定された範囲で入力してください");
    return result;
  };
  const instant = (text) => {
    const value = text.trim();
    if (!value) return null;
    if (
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value
    )
      throw new Error("日時はUTCで 2026-10-03T08:00:00.000Z の形式にしてください");
    return value;
  };
  const settings = {
    limit: number(fields.limit, 1),
    warnRemaining: number(fields.threshold),
    startsAt: instant(fields.start),
    endsAt: instant(fields.end),
    timeZone: fields.timezone.trim() || null,
    otherUsage: number(fields.other),
  };
  // JST is a presentation draft default, not evidence of an account reset window.
  if (settings.startsAt === null && settings.endsAt === null && settings.timeZone === "Asia/Tokyo")
    settings.timeZone = null;
  if (
    settings.warnRemaining !== null &&
    (settings.limit === null || settings.warnRemaining > settings.limit)
  )
    throw new Error("警告しきい値は上限回数以下にしてください");
  if ([settings.startsAt, settings.endsAt, settings.timeZone].some((value) => value !== null)) {
    if (
      !settings.startsAt ||
      !settings.endsAt ||
      !settings.timeZone ||
      settings.endsAt <= settings.startsAt
    )
      throw new Error("開始・終了・IANA名をひと組で指定してください");
    try {
      new Intl.DateTimeFormat("en", { timeZone: settings.timeZone }).format();
    } catch {
      throw new Error("IANAタイムゾーン名を確認してください");
    }
  }
  return settings;
}
export function counterCopy(counter) {
  if (counter?.state !== "available")
    return {
      counts: "観測記録は利用できません",
      remaining: "残りの参考回数は不明です",
      coverage: "公式quota・アカウント全体の利用量は確認できません",
      warning: "ホストのカウンター設定または記録を確認してください",
      danger: false,
    };
  const view = counter.view;
  const settings = view.configuration?.settings;
  let bounds = "未設定";
  if (settings?.startsAt && settings?.endsAt && settings?.timeZone) {
    try {
      const format = new Intl.DateTimeFormat("ja-JP", {
        timeZone: settings.timeZone,
        dateStyle: "medium",
        timeStyle: "short",
      });
      bounds = `${format.format(new Date(settings.startsAt))}〜${format.format(new Date(settings.endsAt))} (${settings.timeZone})`;
    } catch {
      bounds = "日時の確認が必要";
    }
  }
  return {
    counts: `Bridge観測：確認済み ${view.confirmed}回 · 利用した可能性 ${view.possible}回`,
    remaining: view.remaining
      ? `設定に対する残りの参考範囲：${view.remaining.lower}〜${view.remaining.upper}回`
      : "残りの参考回数は不明です",
    coverage: `公式quota・アカウント全体の利用量は不明。時間枠：${view.windowState} · ${bounds} · 現在の枠に対応しない記録 ${view.unassignedInWindow}件 · 記録の欠落 ${view.coverageGaps ?? 0}件${view.coveragePending ? " · 観測の照合中" : ""} · 最終表示 ${view.observedAt}`,
    warning: view.warning.text,
    danger: view.warning.active === true,
  };
}
export function mountProCounter({
  api,
  document,
  endpoint = "/api/settings/pro-counter",
  onClose = () => {},
}) {
  const node = (name) => document.getElementById(`pro-counter-${name}`);
  let current = null,
    draftRevision = null,
    dirty = false,
    pending = false,
    uncertain = false,
    epoch = 0,
    destroyed = false,
    reconciled = true;
  const listeners = [];
  const listen = (name, type, listener) => {
    node(name).addEventListener(type, listener);
    listeners.push([node(name), type, listener]);
  };
  const message = (text, danger = false) => {
    node("message").textContent = text;
    node("message").className = `notice ${danger ? "danger" : "info"}`;
  };
  const controls = () => {
    node("fields").disabled = pending || current?.state !== "available";
    node("save").disabled = pending || uncertain || !dirty || current?.state !== "available";
    node("reset-draft").disabled = pending || (uncertain && !reconciled);
  };
  const fill = () => {
    const settings =
      current?.state === "available" ? (current.view.configuration?.settings ?? EMPTY) : EMPTY;
    const values = {
      limit: settings.limit,
      threshold: settings.warnRemaining,
      start: settings.startsAt,
      end: settings.endsAt,
      timezone: settings.timeZone ?? "Asia/Tokyo",
      other: settings.otherUsage,
    };
    for (const key of FIELDS) node(key).value = values[key] === null ? "" : String(values[key]);
    draftRevision =
      current?.state === "available" ? (current.view.configuration?.revision ?? 0) : null;
    dirty = false;
  };
  const render = () => {
    const copy = counterCopy(current);
    for (const key of ["counts", "remaining", "coverage", "warning"])
      node(key).textContent = copy[key];
    node("warning").className = `notice ${copy.danger ? "danger" : "info"}`;
    if (!dirty) fill();
    controls();
  };
  const accept = (response) => {
    const incoming = response?.proCounter;
    if (
      incoming?.version !== "bridge-pro-counter-settings-1" ||
      !["available", "unavailable"].includes(incoming.state)
    )
      throw new Error("カウンター応答を確認できません");
    const revision = (value) =>
      value?.state === "available" ? (value.view.configuration?.revision ?? 0) : -1;
    if (
      incoming.state === "available" &&
      current?.state === "available" &&
      (revision(incoming) < revision(current) ||
        (revision(incoming) === revision(current) &&
          incoming.view.observedAt < current.view.observedAt))
    )
      return false;
    current = incoming;
    render();
    return true;
  };
  const refresh = async () => {
    if (destroyed || pending) return;
    const selectedEpoch = ++epoch;
    try {
      const response = await api(endpoint);
      if (destroyed || selectedEpoch !== epoch) return;
      if (!accept(response)) return;
      reconciled = true;
      const latest =
        current?.state === "available" ? (current.view.configuration?.revision ?? 0) : null;
      if (dirty && draftRevision !== latest) {
        uncertain = true;
        message(
          "別の設定更新を確認しました。編集内容は保持しています。編集を取り消して最新設定を確認してください",
          true,
        );
      } else if (uncertain) {
        uncertain = true;
        message("送信結果を再読込しました。編集を取り消して保存済み設定を確認してください", true);
      } else
        message(
          current.state === "available"
            ? "Bridgeの観測と手動設定を表示しています"
            : "カウンターは未構成、または記録を確認できません",
          current.state !== "available",
        );
      controls();
    } catch {
      if (!destroyed && selectedEpoch === epoch) {
        uncertain = true;
        reconciled = false;
        message("記録を読み込めません。編集内容は保持しています。再読込で確認してください", true);
        controls();
      }
    }
  };
  listen("form", "submit", async (event) => {
    event.preventDefault();
    if (pending || uncertain || !dirty || current?.state !== "available" || draftRevision === null)
      return;
    let settings;
    try {
      settings = parseCounterFields(
        Object.fromEntries(FIELDS.map((key) => [key, node(key).value])),
      );
    } catch (error) {
      message(error.message, true);
      return;
    }
    pending = true;
    epoch++;
    controls();
    try {
      const expectedRevision = draftRevision;
      const response = await api(endpoint, { expectedRevision, settings });
      if (destroyed) return;
      // Acknowledged save clears only this submitted draft; controls were locked during the request.
      if (
        !accept(response) ||
        current?.state !== "available" ||
        current.view.configuration?.revision !== expectedRevision + 1 ||
        JSON.stringify(current.view.configuration.settings) !== JSON.stringify(settings)
      )
        throw new Error("save_unconfirmed");
      dirty = false;
      uncertain = false;
      reconciled = true;
      fill();
      message("参考値を保存しました。公式の利用枠や実行許可は変更されません");
    } catch {
      if (!destroyed) {
        uncertain = true;
        reconciled = false;
        message(
          "保存結果を確認できません。自動再送しません。記録を再読込し、保存済み設定を確認してください",
          true,
        );
      }
    } finally {
      pending = false;
      if (!destroyed) controls();
    }
  });
  for (const key of FIELDS)
    listen(key, "input", () => {
      dirty = true;
      controls();
    });
  listen("refresh", "click", () => void refresh());
  listen("reset-draft", "click", () => {
    if (pending || (uncertain && !reconciled)) return;
    uncertain = false;
    fill();
    render();
    message("保存済み設定に戻しました");
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
      for (const [element, type, listener] of listeners)
        element.removeEventListener(type, listener);
    },
  };
}
