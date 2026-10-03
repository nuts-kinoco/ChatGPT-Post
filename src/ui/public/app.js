/* No task state is generated here. Every accepted status and receipt comes from the local API. */
const TOKEN_KEY = "bridge-v2-ui-token";
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
export const STATUS = {
  received: ["受信済み", "", "依頼を受け取りました。まだ開始していません"],
  awaiting_approval: ["承認待ち", "wait", "この内容に一致する承認を待っています"],
  approved: ["承認済み", "done", "承認記録を取得しました。開始時にも有効性を確認します"],
  running: ["実行中", "run", "実行中の記録があります。終了結果はまだ確定していません"],
  cancel_requested: ["停止要求済み", "wait", "停止を要求しました。停止確認の証跡を待っています"],
  cancelled: ["停止確認済み", "", "サーバーが停止の結果を記録しました"],
  succeeded: ["完了", "done", "サーバーが完了の結果を記録しました"],
  failed: ["失敗", "error", "失敗の結果を記録しました。詳しい証跡を確認してください"],
  unknown: ["状況不明", "wait", "状況を確定できません。再実行せず、記録を照合してください"],
};
const ACTION_NAMES = {
  validate: "内容の検証",
  import: "依頼の取り込み",
  approve: "承認",
  start: "開始",
  cancel: "停止要求",
  reconcile: "記録の照合",
  ack: "結果ACK",
  demo: "デモ操作",
};
const MODE_COPY = {
  manual: "この依頼の原文とハッシュを確認し、依頼ごとの承認記録に結び付けます",
  automatic: "保存された条件に照合します。自動承認の指定だけでは実行は許可されません",
  bypass: "事前許可の範囲に照合します。ハッシュ・期限・開始回数の確認は省略しません",
};

/** Consume the secret before any asynchronous work or network request. Never put it in a URL. */
export function consumeToken(location, history, storage) {
  const fragment = location.hash.slice(1);
  if (location.hash) history.replaceState(null, "", `${location.pathname}${location.search}`);
  let incoming = "";
  if (fragment) {
    const params = new URLSearchParams(fragment);
    incoming = params.has("token") ? params.get("token") || "" : fragment;
  }
  let token = incoming;
  try {
    if (incoming) storage.setItem(TOKEN_KEY, incoming);
    else token = storage.getItem(TOKEN_KEY) || "";
  } catch {
    /* The fragment token still works if per-tab storage is disabled. */
  }
  return token;
}

export class ApiError extends Error {
  constructor(code, message, uncertain = false, status = 0) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.uncertain = uncertain;
    this.status = status;
  }
}

/** Single attempt only. Even a failed POST may already have committed on the server. */
export function createApiClient(token, fetcher = fetch) {
  return async (path, body) => {
    if (!token)
      throw new ApiError(
        "token_missing",
        "認証情報がありません。サーバーが表示した起動URLから開き直してください",
      );
    if (!/^\/api\/[a-z0-9/-]+$/i.test(path))
      throw new ApiError("invalid_path", "操作先を確認できません");
    const mutation = body !== undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let response;
    try {
      response = await fetcher(path, {
        method: mutation ? "POST" : "GET",
        mode: "same-origin",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(mutation ? { "Content-Type": "application/json" } : {}),
        },
        ...(mutation ? { body: JSON.stringify(body) } : {}),
      });
      const envelope = await response.json();
      if (!response.ok) {
        throw new ApiError(
          envelope?.error?.code || "request_failed",
          envelope?.error?.message || "サーバーが操作を受け付けませんでした",
          mutation && response.status >= 500,
          response.status,
        );
      }
      if (!envelope || !["production", "demo"].includes(envelope.profile)) {
        throw new ApiError("invalid_response", "サーバーの応答を確認できません", mutation);
      }
      return envelope;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        "disconnected",
        "サーバーとの接続を確認できません。起動状態を確認してから、記録を再読込してください",
        mutation,
      );
    } finally {
      clearTimeout(timeout);
    }
  };
}

export function actionBinding(task, action) {
  if (action === "approve" || action === "start")
    return {
      taskSpecHash: task.result.task_spec_hash,
      taskFileHash: task.result.task_file_hash,
      sequence: task.result.observation_seq,
    };
  if (action === "ack") {
    const receipt = task.handshakes.terminal_result;
    if (!receipt)
      throw new ApiError("terminal_result_missing", "受領する終了結果の記録がありません");
    return {
      eventId: receipt.eventId,
      payloadSha256: receipt.payloadSha256,
      sequence: receipt.sequence,
    };
  }
  return {};
}

/** Sequence comparison only; the client never invents a lifecycle transition. */
export function chooseSnapshot(current, incoming, selectedId) {
  if (!incoming || incoming.summary.requestId !== selectedId) return current;
  if (
    current?.summary.requestId === selectedId &&
    current.result.observation_seq > incoming.result.observation_seq
  )
    return current;
  // ResultSpec is immutable at terminal state; ACK has its own handshake and no result revision.
  // Retain observed delivery evidence only when both snapshots name that exact terminal payload.
  const priorTerminal = current?.handshakes?.terminal_result;
  const nextTerminal = incoming.handshakes?.terminal_result;
  if (
    current?.summary.requestId === selectedId &&
    current.result.observation_seq === incoming.result.observation_seq &&
    current.result.task_spec_hash === incoming.result.task_spec_hash &&
    current.result.task_file_hash === incoming.result.task_file_hash &&
    current.result.status === incoming.result.status &&
    TERMINAL.has(incoming.result.status) &&
    current.handshakes?.result_ack &&
    current.delivery?.acknowledged &&
    priorTerminal &&
    nextTerminal &&
    ["eventId", "payloadSha256", "sequence", "requestId", "taskSpecHash", "runId"].every(
      (key) => priorTerminal[key] === nextTerminal[key],
    ) &&
    current.delivery.payloadSha256 === incoming.delivery?.payloadSha256
  ) {
    return {
      ...incoming,
      summary: chooseSummary(current.summary, incoming.summary),
      handshakes: { ...incoming.handshakes, result_ack: current.handshakes.result_ack },
      delivery: current.delivery,
    };
  }
  return incoming;
}

/** Summary has no delivery revision; a terminal UUID/run/sequence is immutable server-side. */
export function chooseSummary(current, incoming) {
  if (!current || current.requestId !== incoming.requestId) return incoming;
  if (current.sequence > incoming.sequence) return current;
  if (
    current.sequence === incoming.sequence &&
    current.runId === incoming.runId &&
    current.status === incoming.status &&
    TERMINAL.has(incoming.status) &&
    current.deliveryAcknowledged &&
    !incoming.deliveryAcknowledged
  )
    return { ...incoming, deliveryAcknowledged: true };
  return incoming;
}

export function capabilityFor(bootstrap, task, name) {
  return (
    task?.capabilities?.[name] ||
    bootstrap?.capabilities?.[name] || {
      enabled: false,
      reason: "サーバーの機能をまだ確認できません",
    }
  );
}

function capabilityText(raw) {
  const translated = {
    "Production execution and approval authority are unconfigured; validation and inspection remain available":
      "実行アダプターと承認機関が未構成です。検証と記録の確認は利用できます",
    "This task belongs to another configured runtime session; read-only inspection is available":
      "別の実行セッションに属する依頼です。記録の確認だけが利用できます",
    "Only tasks awaiting approval may receive a grant": "承認待ちの依頼にだけ承認を発行できます",
    "An unconsumed detached approval is required before start":
      "開始には未使用の承認記録が必要です",
    "A start intent is already consumed; reconcile this UUID and never reexecute it":
      "開始記録は使用済みです。同じ依頼IDで記録を照合してください",
    "Terminal result is immutable": "終了した依頼の結果は変更できません",
    "No dispatch intent exists to reconcile": "まだ開始記録がないため、実行の照合は不要です",
    "A persisted terminal event and its exact payload hash are required":
      "終了結果の記録と、その内容に一致するハッシュが必要です",
    "Explicit detached approval for the inspected hashes":
      "確認した原文のハッシュに結び付く承認を発行します",
    "One authorized start per immutable request UUID": "承認された依頼IDにつき、一度だけ開始します",
    "Persist cancellation and reconcile the same execution identity":
      "停止要求を保存し、同じ実行の停止状態を確認します",
    "Observe the existing run only; never reexecute":
      "既存の実行を照合します。新しい実行は開始しません",
  };
  return translated[raw] || raw;
}

export function readableError(error) {
  const prefix = {
    authentication_required: "認証情報が無効です。起動URLから開き直してください",
    capability_unavailable: "このサーバーでは操作が有効になっていません",
    unauthorized: "認証情報が無効です。起動URLから開き直してください",
    token_missing: "起動URLの認証情報がありません",
    stale_task_snapshot: "表示後に記録が更新されました。再読込して最新の内容を確認してください",
    stale_snapshot: "表示後に記録が更新されました。再読込して最新の内容を確認してください",
    stale_observation: "記録が更新されました。再読込してから確認してください",
    request_id_conflict: "同じ依頼IDに別の内容が保存されています。新しいUUIDで取り込んでください",
    task_not_found: "依頼が見つかりません。依頼一覧を再読込してください",
    profile_mismatch: "サーバーのプロファイルが変わりました。起動URLから開き直してください",
    invalid_request: "送信内容がAPIの形式と一致しません。下書きと検証結果を確認してください",
    capability_disabled: "このサーバーでは操作が有効になっていません",
    validation_failed: "依頼の内容を検証できませんでした",
  }[error.code];
  const text = prefix
    ? `${prefix}。${error.message}`
    : `操作を完了できませんでした。${error.message || "記録を再読込して確認してください"}`;
  return `${text}${error.code ? ` [${error.code}]` : ""}${error.uncertain ? "。操作が保存されたかは未確認です。自動再送せず、記録を再読込してください" : ""}`;
}

export async function markdownHash(markdown, cryptoApi = globalThis.crypto) {
  const digest = await cryptoApi.subtle.digest("SHA-256", new TextEncoder().encode(markdown));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function boot() {
  let storage;
  try {
    storage = window.sessionStorage;
  } catch {
    /* Storage may be disabled by the host. */
  }
  const token = consumeToken(window.location, window.history, storage);
  const api = createApiClient(token);
  const params = new URLSearchParams(window.location.search);
  const compact = params.get("view") === "dock";
  document.body.classList.toggle("compact", compact);
  const $ = (id) => document.getElementById(id);
  const state = {
    bootstrap: null,
    task: null,
    selectedId: params.get("task") || "",
    selectionEpoch: 0,
    readEpoch: 0,
    connected: false,
    uncertain: false,
    pending: false,
    cancelPending: false,
    refreshing: false,
    tab: ["approval", "payload", "evidence", "recovery"].includes(params.get("tab"))
      ? params.get("tab")
      : "approval",
    draft: { rawSpec: "", taskMarkdown: "", revision: 0, validatedRevision: -1, validation: null },
  };
  const text = (id, value) => {
    $(id).textContent = value ?? "—";
  };
  const json = (value) => JSON.stringify(value ?? null, null, 2);
  const statusInfo = (status) => STATUS[status] || ["未確認", "", "記録を確認してください"];
  const time = (value) =>
    value ? new Date(value).toLocaleString("ja-JP", { hour12: false }) : "未取得";
  const shortTime = (value) =>
    value
      ? new Date(value).toLocaleTimeString("ja-JP", {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
        })
      : "";
  const tell = (message, danger = false) => {
    text("message", message);
    $("message").className = `notice ${danger ? "danger" : "info"} state-message`;
  };
  const badge = (id, status) => {
    const [label, tone] = statusInfo(status);
    text(id, label);
    $(id).className = `badge ${tone}`;
  };
  const isDemo = () => state.bootstrap?.profile === "demo";
  const isBusy = () => state.pending || state.cancelPending;
  const blockedReason = (action) =>
    (action === "cancel" ? state.cancelPending : isBusy())
      ? "処理中です。応答を確認しています"
      : !state.connected
        ? "接続を確認し、記録を再読込してください"
        : state.uncertain
          ? "前の操作の結果が未確認です。まず記録を再読込してください"
          : "";
  const can = (name, task = true) =>
    !blockedReason(name) && capabilityFor(state.bootstrap, task ? state.task : null, name).enabled;
  const reason = (name, task = true) =>
    blockedReason(name) ||
    capabilityText(capabilityFor(state.bootstrap, task ? state.task : null, name).reason);
  const setButton = (id, action, reasonId) => {
    $(id).disabled =
      !state.task || !can(action) || (action === "ack" && !!state.task.handshakes.result_ack);
    $(id).title =
      blockedReason(action) || capabilityFor(state.bootstrap, state.task, action).reason;
    if (reasonId)
      text(
        reasonId,
        action === "ack" && state.task?.handshakes.result_ack
          ? "この結果は受領済みです"
          : reason(action),
      );
  };
  const assertProfile = (response) => {
    if (state.bootstrap && response.profile !== state.bootstrap.profile)
      throw new ApiError("profile_mismatch", "プロファイルが異なる応答を受信しました", true);
  };
  function updateSummary(task) {
    if (!state.bootstrap) return;
    const index = state.bootstrap.tasks.findIndex(
      (item) => item.requestId === task.summary.requestId,
    );
    if (index < 0) state.bootstrap.tasks.unshift(task.summary);
    else state.bootstrap.tasks[index] = chooseSummary(state.bootstrap.tasks[index], task.summary);
  }
  function adopt(response, selectedId = state.selectedId) {
    assertProfile(response);
    updateSummary(response.task);
    state.task = chooseSnapshot(state.task, response.task, selectedId);
  }
  function displayTab(name, navigate = false) {
    if (navigate && compact) {
      const url = new URL(window.location.href);
      url.search = new URLSearchParams({
        view: "detail",
        tab: name,
        ...(state.selectedId ? { task: state.selectedId } : {}),
      }).toString();
      url.hash = "";
      window.location.assign(url.pathname + url.search);
      return;
    }
    state.tab = name;
    for (const button of document.querySelectorAll("[data-tab]")) {
      const selected = button.dataset.tab === name;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    for (const panel of document.querySelectorAll(".tab-panel"))
      panel.hidden = panel.id !== `panel-${name}`;
    if (navigate) {
      $("task-main").scrollIntoView({ block: "start" });
      $(`tab-${name}`).focus();
    }
  }
  function renderControls() {
    $("refresh").disabled = isBusy() || state.refreshing;
    $("new-task").disabled = !can("import", false);
    $("empty-import").disabled = !can("import", false);
    $("new-demo").hidden = !isDemo();
    $("new-demo").disabled = !can("demo", false);
    $("copy-draft").disabled = !state.task || !can("import", false);
    $("task-select").disabled = !state.bootstrap?.tasks.length;
    for (const [id, action, reasonId] of [
      ["approve", "approve", "approve-reason"],
      ["start", "start", "start-reason"],
      ["cancel", "cancel", "cancel-reason"],
      ["dock-stop", "cancel", null],
      ["ack-result", "ack", "ack-reason"],
      ["reconcile", "reconcile", "reconcile-reason"],
    ])
      setButton(id, action, reasonId);
    $("demo-simulations").hidden = !isDemo();
    for (const button of document.querySelectorAll("[data-observation]"))
      button.disabled =
        !state.task ||
        !can("demo") ||
        !["running", "cancel_requested", "unknown"].includes(state.task.result.status);
    text(
      "demo-reason",
      blockedReason() || "実行中または状況不明のデモ依頼にだけ観測を入力できます",
    );
    const productionReasons = !isDemo()
      ? [reason("approve"), reason("start")]
          .filter((v, i, a) => v && a.indexOf(v) === i)
          .join(" / ")
      : "";
    text(
      "action-explain",
      blockedReason() ||
        productionReasons ||
        (isDemo()
          ? "デモ用アダプターでコアの処理を確認します。外部プロセスは起動しません"
          : "内容・ハッシュ・観測番号をこの操作へ結び付けます"),
    );
    for (const id of ["draft-spec", "draft-md", "import-spec", "import-md", "new-uuid", "bind-md"])
      $(id).disabled = isBusy();
    $("validate-draft").disabled = !can("validate", false) || !state.draft.rawSpec;
    $("import-draft").disabled =
      !can("import", false) ||
      !state.draft.validation?.valid ||
      state.draft.validatedRevision !== state.draft.revision;
    $("close-draft").disabled = isBusy();
  }
  function renderDiagnostics() {
    const bootstrap = state.bootstrap;
    if (!bootstrap) return;
    text("session-profile", isDemo() ? "デモ専用" : "本番");
    text(
      "session-authority",
      bootstrap.diagnostics.approvalConfigured ? (isDemo() ? "模擬" : "構成済み") : "未構成",
    );
    text(
      "session-executor",
      bootstrap.diagnostics.executionEnabled ? (isDemo() ? "模擬" : "構成済み") : "未構成",
    );
    text("diagnostics-json", json(bootstrap.diagnostics));
    const items = Object.entries(bootstrap.capabilities).map(([key, value]) => {
      const row = document.createElement("div"),
        dt = document.createElement("dt"),
        dd = document.createElement("dd");
      dt.textContent = ACTION_NAMES[key] || key;
      dd.textContent = `${value.enabled ? "利用可" : "利用不可"} · ${value.reason}`;
      row.append(dt, dd);
      return row;
    });
    $("capabilities").replaceChildren(...items);
  }
  function render() {
    const bootstrap = state.bootstrap,
      task = state.task;
    text("connection", state.connected ? (isBusy() ? "処理中" : "ローカル接続中") : "接続未確認");
    $("connection").className =
      `connection ${state.connected ? "connection-ok" : "connection-error"}`;
    if (bootstrap) {
      $("profile-banner").className = `demo-note profile-banner${isDemo() ? " demo" : ""}`;
      text("profile-label", isDemo() ? "デモ専用" : "ローカル · 本番");
      text(
        "profile-description",
        isDemo()
          ? "模擬アダプターを使う独立したデモ環境です。結果は synthetic として記録され、外部プロセスは起動しません"
          : "保存された依頼を確認・検証するローカル操作画面です。利用できる操作はサーバーの構成から確認します",
      );
      const options = bootstrap.tasks.map((item) => {
        const option = document.createElement("option");
        option.value = item.requestId;
        option.textContent = `${statusInfo(item.status)[0]} · ${item.title} · ${item.requestId.slice(0, 8)}`;
        return option;
      });
      if (!options.length) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "保存された依頼はありません";
        options.push(option);
      }
      $("task-select").replaceChildren(...options);
      $("task-select").value = state.selectedId;
      text("task-count", `${bootstrap.tasks.length} 件`);
      renderDiagnostics();
    }
    $("task-main").setAttribute("aria-busy", String(isBusy() || state.refreshing));
    $("empty-task").hidden = !!task;
    $("task-detail").hidden = !task;
    $("empty-import").hidden = !bootstrap || !!bootstrap.tasks.length;
    if (!task) {
      text(
        "empty-title",
        state.selectedId ? "依頼を読み込んでいます" : "ここから依頼を確認できます",
      );
      text(
        "empty-description",
        bootstrap
          ? "JSON と Markdown を取り込み、依頼の許可範囲・受け渡し・結果をひとつの画面で確認します。取り込みだけでは開始しません"
          : "サーバーが表示した起動URLから開いてください。接続後、保存された記録を表示します",
      );
      text("dock-title", state.selectedId ? "依頼を確認中" : "依頼を選んでください");
      text("dock-status", "未確認");
      $("dock-status").className = "badge";
      text("dock-reason", blockedReason() || "依頼を取り込むと、保存された状態を表示します");
      text("dock-destination", isDemo() ? "デモ専用 · synthetic" : "ローカル記録");
      text("dock-mode", "");
      text("dock-time", "");
      text("dock-id", "");
      text("dock-result-title", "結果の記録");
      text("dock-result-detail", "依頼は未選択です");
      text("dock-result-icon", "·");
      text("dock-footer", isDemo() ? "デモ専用 · 実プロセスなし" : "記録の取得待ち");
      $("dock-result").disabled = true;
      renderControls();
      return;
    }
    const { spec, result, summary } = task;
    badge("main-status", result.status);
    badge("dock-status", result.status);
    text("task-id", `依頼 ${summary.requestId} · JSON + MD`);
    text("task-title", summary.title);
    for (const mode of document.querySelectorAll("[data-mode]")) {
      const active = mode.dataset.mode === spec.approval.tier;
      mode.classList.toggle("active", active);
      mode.setAttribute("aria-label", `${mode.textContent}${active ? " · 選択中" : ""}`);
    }
    text("mode-copy", MODE_COPY[spec.approval.tier] || "依頼に保存された承認方式を確認します");
    const approval = task.approvals.at(-1);
    const envelope = approval?.envelope;
    text(
      "receipt-badge",
      envelope
        ? approval.consumed
          ? "使用済み"
          : envelope.decision === "approved"
            ? "承認記録あり"
            : "許可なし"
        : "未発行",
    );
    $("receipt-badge").className = `badge ${envelope?.decision === "approved" ? "done" : "wait"}`;
    text(
      "receipt-summary",
      envelope
        ? "サーバーに保存された承認記録です。開始時に期限と内容を再検証します"
        : "この依頼の承認記録は発行されていません",
    );
    text("approval-hash", result.task_spec_hash);
    text("receipt-id", envelope?.approval_id || "未発行");
    text(
      "receipt-policy",
      envelope?.preauthorization
        ? `${envelope.preauthorization.policy_id} · v${envelope.preauthorization.policy_version}`
        : spec.approval.preauthorization
          ? `${spec.approval.preauthorization.policy_id} · v${spec.approval.preauthorization.policy_version}（依頼の参照）`
          : "事前許可の参照なし",
    );
    text("receipt-expiry", envelope ? time(envelope.expires_at) : "未発行");
    text("scope-description", `${spec.mode} · タスクネットワーク ${spec.task_network}`);
    text("policy-repo", spec.repo);
    text("policy-agent", `${spec.agent} / ${spec.requested_model}`);
    text(
      "policy-paths",
      spec.allowed_paths.length
        ? spec.allowed_paths
            .map((path) => `${path.path} · ${path.scope} · ${path.permissions.join(", ")}`)
            .join("\n")
        : "許可されたパスなし",
    );
    text(
      "policy-commands",
      spec.allowed_commands.length
        ? `${spec.allowed_commands.length} 件（原文で確認）`
        : "許可されたコマンドなし",
    );
    text(
      "policy-validity",
      `実行 ${spec.timeout.run_seconds} 秒 / 停止猶予 ${spec.timeout.cancel_grace_seconds} 秒 / 開始 ${spec.approval.max_starts} 回`,
    );
    text(
      "approval-notice",
      isDemo()
        ? "デモ用の承認・観測を保存します。synthetic の結果は実際の実行証跡としては扱いません"
        : reason("approve") || "事前確認は参考情報です。実行の許可そのものではありません",
    );
    text(
      "preflight-summary",
      `参考情報 · ${task.preflight.ready ? "事前確認の条件を満たしています" : "未確認または満たしていない条件があります"}。実行承認とは別に判定します`,
    );
    $("preflight-errors").replaceChildren(
      ...(task.preflight.errors || []).map((error) => {
        const item = document.createElement("li");
        item.textContent = error;
        return item;
      }),
    );
    text("preflight-json", json(task.preflight));
    text("approval-json", json(task.approvals));
    text(
      "delivery-status",
      task.handshakes.receipt_ack ? "受信ACKを記録済み" : "受信ACKの記録なし",
    );
    text("payload-agent", `依頼先 ${spec.agent} / ${spec.requested_model}`);
    text("file-md", spec.task_file);
    text("task-md", task.taskMarkdown);
    text("task-json", task.rawSpec);
    text("md-hash", result.task_file_hash);
    text("json-hash", result.task_spec_hash);
    text("evidence-origin", result.synthetic ? "synthetic · 模擬記録" : "保存された記録");
    $("evidence-origin").className = `badge ${result.synthetic ? "wait" : ""}`;
    for (const [key, id] of [
      ["receipt_ack", "hs-received"],
      ["start_receipt", "hs-started"],
      ["terminal_result", "hs-result"],
      ["result_ack", "hs-ack"],
    ]) {
      const handshake = task.handshakes[key];
      $(id).classList.toggle("confirmed", !!handshake);
      $(id).querySelector("small").textContent = handshake
        ? `観測 #${handshake.sequence}`
        : "未記録";
    }
    text(
      "evidence-execution",
      result.synthetic ? "模擬実行" : result.started_at ? "開始記録あり" : "開始記録なし",
    );
    text(
      "evidence-execution-detail",
      result.synthetic
        ? "外部プロセスなし"
        : result.started_at
          ? time(result.started_at)
          : "まだ実行を確認していません",
    );
    text("evidence-status", statusInfo(result.status)[0]);
    text("evidence-seq", `観測 #${result.observation_seq}`);
    text(
      "result-ack",
      task.handshakes.result_ack
        ? "受領済み"
        : task.handshakes.terminal_result
          ? "未受領"
          : "結果待ち",
    );
    text("result-time", result.finished_at ? time(result.finished_at) : "終了時刻は未取得");
    text("evidence-run", result.run_id || "未発行");
    text(
      "evidence-identity",
      `${result.actual_agent || "agent 未取得"} / ${result.actual_model || "model 未取得"}`,
    );
    text(
      "evidence-receipt",
      result.receipt?.receipt_id || (result.synthetic ? "合成記録のため発行なし" : "未発行"),
    );
    text("evidence-verification", result.verification.state);
    $("timeline").replaceChildren(
      ...[...task.events].reverse().map((event) => {
        const item = document.createElement("div"),
          title = document.createElement("strong"),
          seq = document.createElement("small"),
          detail = document.createElement("p");
        item.className = "event";
        title.textContent = statusInfo(event.status)[0];
        seq.textContent = `#${event.observation_seq} · ${time(event.observed_at)}`;
        detail.textContent = event.error
          ? `${event.error.code} · ${event.error.message}`
          : statusInfo(event.status)[2];
        item.append(title, seq, detail);
        return item;
      }),
    );
    text("result-json", json(result));
    text("handshake-json", json({ handshakes: task.handshakes, delivery: task.delivery }));
    text("intent-json", json(task.intent));
    text(
      "recovery-report",
      result.status === "unknown"
        ? "証跡が不足しているため、状況不明を保持しています。記録の照合は追加の実行を開始しません"
        : `${statusInfo(result.status)[0]} · ${statusInfo(result.status)[2]}`,
    );
    text("recovery-fence", `${result.fencing_token} · 観測 #${result.observation_seq}`);
    text("dock-title", summary.title);
    text("dock-time", shortTime(result.observed_at));
    text("dock-destination", result.synthetic ? `デモ · ${spec.agent}` : spec.agent);
    text(
      "dock-mode",
      { manual: "依頼ごとに確認", automatic: "受付時に条件判定", bypass: "事前許可に照合" }[
        spec.approval.tier
      ],
    );
    text(
      "dock-reason",
      !state.connected
        ? "接続未確認。表示は最後に取得した記録です"
        : state.uncertain
          ? "前の操作の結果が未確認です。詳細から記録を再読込してください"
          : statusInfo(result.status)[2],
    );
    text("dock-id", `ID ${summary.requestId}`);
    $("dock-result").disabled = false;
    text(
      "dock-result-icon",
      result.status === "succeeded" ? "✓" : result.status === "failed" ? "!" : "·",
    );
    text(
      "dock-result-title",
      TERMINAL.has(result.status)
        ? `${statusInfo(result.status)[0]}の記録を見る`
        : "現在の実行記録を見る",
    );
    text(
      "dock-result-detail",
      `${task.handshakes.result_ack ? "結果受領済み" : result.outcome_known ? "結果確認待ち" : "結果未確定"} · 観測 #${result.observation_seq}`,
    );
    text(
      "dock-footer",
      result.synthetic ? "デモ専用 · 実プロセスなし" : "保存された記録 · 自動再実行なし",
    );
    renderControls();
    displayTab(state.tab);
  }
  async function selectTask(id) {
    const epoch = ++state.selectionEpoch;
    state.selectedId = id;
    state.task = null;
    render();
    if (!id) return;
    try {
      const response = await api(`/api/tasks/${encodeURIComponent(id)}`);
      if (epoch !== state.selectionEpoch || state.selectedId !== id) return;
      adopt(response);
      state.connected = true;
      render();
    } catch (error) {
      if (epoch === state.selectionEpoch) {
        state.connected = false;
        tell(readableError(error), true);
        render();
      }
    }
  }
  async function refresh(manual = false) {
    if (isBusy() || state.refreshing) return;
    const epoch = ++state.readEpoch,
      selectedEpoch = state.selectionEpoch;
    state.refreshing = true;
    renderControls();
    try {
      const bootstrap = await api("/api/bootstrap");
      if (epoch !== state.readEpoch) return;
      assertProfile(bootstrap);
      const priorSummaries = new Map(
        (state.bootstrap?.tasks || []).map((task) => [task.requestId, task]),
      );
      bootstrap.tasks = bootstrap.tasks.map((task) =>
        chooseSummary(priorSummaries.get(task.requestId), task),
      );
      state.bootstrap = bootstrap;
      state.connected = true;
      const selectedId = state.selectedId;
      if (selectedEpoch === state.selectionEpoch) {
        if (selectedId && bootstrap.tasks.some((task) => task.requestId === selectedId)) {
          const response = await api(`/api/tasks/${encodeURIComponent(selectedId)}`);
          if (epoch !== state.readEpoch) return;
          if (selectedEpoch === state.selectionEpoch && selectedId === state.selectedId)
            adopt(response);
        } else if (bootstrap.tasks.length && !selectedId) {
          await selectTask(bootstrap.tasks[0].requestId);
        } else if (selectedId && !bootstrap.tasks.some((task) => task.requestId === selectedId)) {
          state.selectedId = "";
          state.task = null;
          ++state.selectionEpoch;
          tell("選択していた依頼を一覧で確認できません。別の依頼を選んでください", true);
        }
      }
      if (manual && state.connected) {
        state.uncertain = false;
        if (state.connected)
          tell("保存された記録を再読込しました。操作の再送・再実行は行っていません");
      }
      text("last-updated", `最終読込 ${time(new Date().toISOString())}`);
    } catch (error) {
      if (epoch !== state.readEpoch) return;
      state.connected = false;
      tell(readableError(error), true);
    } finally {
      if (epoch === state.readEpoch) {
        state.refreshing = false;
        render();
      }
    }
  }
  async function mutate(path, body, options = {}) {
    const cancellation = options.action === "cancel";
    if (blockedReason(options.action)) return;
    const selectedEpoch = state.selectionEpoch;
    if (cancellation) state.cancelPending = true;
    else state.pending = true;
    ++state.readEpoch;
    state.refreshing = false;
    text("draft-error", "");
    render();
    try {
      const response = await api(path, body);
      assertProfile(response);
      if (response.task) {
        updateSummary(response.task);
        if (options.select && selectedEpoch === state.selectionEpoch) {
          state.selectedId = response.task.summary.requestId;
          ++state.selectionEpoch;
          state.task = response.task;
        } else if (state.selectedId === response.task.summary.requestId) {
          state.task = chooseSnapshot(state.task, response.task, state.selectedId);
        }
      }
      state.connected = true;
      tell(options.message || "サーバーが操作を受け付けました。保存された記録を表示しています");
      options.success?.(response);
    } catch (error) {
      if (error.uncertain) {
        state.uncertain = true;
        state.connected = false;
      }
      if (error.status === 401 || error.code === "profile_mismatch") state.connected = false;
      tell(readableError(error), true);
      text("draft-error", readableError(error));
    } finally {
      if (cancellation) state.cancelPending = false;
      else state.pending = false;
      render();
    }
  }
  function resetValidation() {
    state.draft.revision++;
    state.draft.validation = null;
    state.draft.validatedRevision = -1;
    $("validation-output").hidden = true;
    text("draft-state", "変更後の内容は未検証です");
    text("draft-error", "");
    renderControls();
  }
  function openDraft(copy = false) {
    if (copy && state.task) {
      if (
        (state.draft.rawSpec || state.draft.taskMarkdown) &&
        !window.confirm("現在の下書きを、この依頼のコピーで置き換えますか？")
      )
        return;
      const spec = JSON.parse(state.task.rawSpec);
      spec.request_id = crypto.randomUUID();
      state.draft.rawSpec = `${JSON.stringify(spec, null, 2)}\n`;
      state.draft.taskMarkdown = state.task.taskMarkdown;
      resetValidation();
    }
    $("draft-spec").value = state.draft.rawSpec;
    $("draft-md").value = state.draft.taskMarkdown;
    $("draft-dialog").showModal();
    renderControls();
  }
  function showValidation(response) {
    state.draft.validation = response;
    state.draft.validatedRevision = state.draft.revision;
    $("validation-output").hidden = false;
    $("validation-output").className =
      `notice ${response.valid ? "info" : "danger"} validation-output`;
    text(
      "validation-title",
      response.valid
        ? "内容の検証を通過しました（実行の許可とは別です）"
        : "確認が必要な項目があります",
    );
    text(
      "draft-state",
      response.valid
        ? "この原文を検証済みです。編集すると再検証が必要です"
        : "検証を通過していません",
    );
    $("validation-errors").replaceChildren(
      ...response.errors.map((error) => {
        const item = document.createElement("li");
        item.textContent = error;
        return item;
      }),
    );
    text("validation-spec-hash", response.taskSpecHash || "未確定");
    text("validation-md-hash", response.taskFileHash || "未確定");
  }
  async function importFile(event, field, limit) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > limit) {
      text("draft-error", `ファイルが大きすぎます（上限 ${limit} bytes）`);
      event.target.value = "";
      return;
    }
    const revision = state.draft.revision;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (isBusy() || revision !== state.draft.revision) {
        text("draft-error", "読込中に下書きが変わりました。もう一度ファイルを選んでください");
        return;
      }
      if (
        (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) ||
        (bytes[0] === 0xff && bytes[1] === 0xfe) ||
        (bytes[0] === 0xfe && bytes[1] === 0xff)
      )
        throw new Error("BOM なしの UTF-8 ファイルを選んでください");
      state.draft[field] = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      $(field === "rawSpec" ? "draft-spec" : "draft-md").value = state.draft[field];
      resetValidation();
    } catch (error) {
      text("draft-error", `ファイルを読み込めません。${error.message}`);
    } finally {
      event.target.value = "";
    }
  }
  $("refresh").addEventListener("click", () => refresh(true));
  $("task-select").addEventListener("change", (event) => selectTask(event.target.value));
  $("new-task").addEventListener("click", () => openDraft());
  $("empty-import").addEventListener("click", () => openDraft());
  $("copy-draft").addEventListener("click", () => openDraft(true));
  $("close-draft").addEventListener("click", () => $("draft-dialog").close());
  $("draft-dialog").addEventListener("cancel", (event) => {
    if (isBusy()) event.preventDefault();
  });
  $("new-demo").addEventListener("click", () => {
    if (can("demo", false))
      void mutate(
        "/api/demo/tasks",
        {
          title: "依頼の承認と結果を確認",
          taskMarkdown:
            "承認、開始、模擬観測、停止要求、結果の受領を確認します。外部プロセスは起動しません。",
        },
        { select: true, message: "デモ専用の依頼を作成しました。承認・開始を順に確認できます" },
      );
  });
  $("draft-spec").addEventListener("input", (event) => {
    state.draft.rawSpec = event.target.value;
    resetValidation();
  });
  $("draft-md").addEventListener("input", (event) => {
    state.draft.taskMarkdown = event.target.value;
    resetValidation();
  });
  $("import-spec").addEventListener("change", (event) => importFile(event, "rawSpec", 256 * 1024));
  $("import-md").addEventListener("change", (event) =>
    importFile(event, "taskMarkdown", 1024 * 1024),
  );
  $("new-uuid").addEventListener("click", () => {
    try {
      const spec = JSON.parse(state.draft.rawSpec);
      if (!spec || Array.isArray(spec) || typeof spec !== "object")
        throw new Error("JSON object が必要です");
      spec.request_id = crypto.randomUUID();
      state.draft.rawSpec = `${JSON.stringify(spec, null, 2)}\n`;
      $("draft-spec").value = state.draft.rawSpec;
      resetValidation();
    } catch {
      text("draft-error", "TaskSpec のJSONを先に入力してください。解析できるJSON objectが必要です");
    }
  });
  $("bind-md").addEventListener("click", async () => {
    const revision = state.draft.revision;
    try {
      const spec = JSON.parse(state.draft.rawSpec);
      if (!spec || Array.isArray(spec) || typeof spec !== "object")
        throw new Error("JSON object が必要です");
      const hash = await markdownHash(state.draft.taskMarkdown);
      if (isBusy() || revision !== state.draft.revision) return;
      spec.task_file_hash = hash;
      state.draft.rawSpec = `${JSON.stringify(spec, null, 2)}\n`;
      $("draft-spec").value = state.draft.rawSpec;
      resetValidation();
      text(
        "draft-state",
        "MD の生バイト SHA-256 を反映しました。JSON の書式も更新したため、内容を検証してください",
      );
    } catch {
      text(
        "draft-error",
        "TaskSpec のJSONを先に入力してください。本文ハッシュを反映できませんでした",
      );
    }
  });
  $("validate-draft").addEventListener("click", () => {
    if (can("validate", false))
      void mutate(
        "/api/validate",
        { rawSpec: state.draft.rawSpec, taskMarkdown: state.draft.taskMarkdown },
        { message: "下書きを検証しました。検証結果を確認してください", success: showValidation },
      );
  });
  $("import-draft").addEventListener("click", () => {
    if (
      !can("import", false) ||
      !state.draft.validation?.valid ||
      state.draft.validatedRevision !== state.draft.revision
    )
      return;
    void mutate(
      "/api/tasks",
      { rawSpec: state.draft.rawSpec, taskMarkdown: state.draft.taskMarkdown },
      {
        select: true,
        message: "依頼を取り込みました。実行はまだ開始していません",
        success: () => {
          $("draft-dialog").close();
          state.draft = {
            rawSpec: "",
            taskMarkdown: "",
            revision: 0,
            validatedRevision: -1,
            validation: null,
          };
          $("validation-output").hidden = true;
        },
      },
    );
  });
  for (const [id, action] of [
    ["approve", "approve"],
    ["start", "start"],
    ["cancel", "cancel"],
    ["dock-stop", "cancel"],
    ["reconcile", "reconcile"],
    ["ack-result", "ack"],
  ])
    $(id).addEventListener("click", () => {
      if (!state.task || !can(action)) return;
      try {
        void mutate(
          `/api/tasks/${encodeURIComponent(state.task.summary.requestId)}/${action}`,
          actionBinding(state.task, action),
          { action },
        );
      } catch (error) {
        tell(readableError(error), true);
      }
    });
  for (const button of document.querySelectorAll("[data-observation]"))
    button.addEventListener("click", () => {
      if (state.task && isDemo() && can("demo"))
        void mutate(
          `/api/tasks/${encodeURIComponent(state.task.summary.requestId)}/demo-observation`,
          { outcome: button.dataset.observation },
        );
    });
  const tabs = [...document.querySelectorAll("[data-tab]")];
  tabs.forEach((button, index) => {
    button.addEventListener("click", () => displayTab(button.dataset.tab));
    button.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      displayTab(tabs[next].dataset.tab);
      tabs[next].focus();
    });
  });
  for (const button of document.querySelectorAll("[data-open]"))
    button.addEventListener("click", () => displayTab(button.dataset.open, true));
  for (const button of document.querySelectorAll("[data-file]"))
    button.addEventListener("click", () => {
      for (const item of document.querySelectorAll("[data-file]"))
        item.setAttribute("aria-pressed", String(item === button));
      $("task-md").hidden = button.dataset.file !== "md";
      $("task-json").hidden = button.dataset.file !== "json";
    });
  $("show-diagnostics").addEventListener("click", () => {
    $("diagnostics").open = true;
    $("diagnostics").scrollIntoView({ block: "start" });
    $("diagnostics").querySelector("summary").focus();
  });
  render();
  void refresh();
  // Read-only observations, never a mutation retry. Explicit refresh clears an uncertain POST.
  setInterval(() => {
    if (!document.hidden && !isBusy() && !state.uncertain && token) void refresh();
  }, 10000);
}

if (typeof window !== "undefined" && typeof document !== "undefined") boot();
