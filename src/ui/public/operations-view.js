/** Route-neutral monitor. Stored observations are evidence, never inferred liveness or delivery. */
const ROUTES = {
  local_execution: "CLI / ローカル実行",
  hosted_delivery: "通常チャット / 受け渡し",
  fanout: "まとめて依頼",
};
const ACTIONS = {
  approve: "この内容を承認",
  start: "開始",
  cancel: "停止を要求",
  reconcile: "記録を照合",
  ack: "成果物を検証して受領",
  archive: "成果物を収集",
};
const STATES = {
  queued: "待機",
  awaiting_approval: "承認待ち",
  approved: "承認済み",
  running: "実行中",
  unknown: "状況不明",
  completed: "応答あり",
  succeeded: "完了",
  failed: "失敗",
  cancelled: "取消済み",
  blocked_auth: "認証の確認が必要",
};
export function operationIdentity(value) {
  return value.kind === "fanout"
    ? `fanout:${value.fanoutId}`
    : `${value.kind}:${value.binding.requestId}`;
}
export function chooseOperation(current, incoming) {
  if (!current || operationIdentity(current) !== operationIdentity(incoming)) return incoming;
  const revision = (value) =>
    value.kind === "hosted_delivery"
      ? value.binding.revision
      : value.kind === "local_execution"
        ? value.binding.sequence
        : 0;
  if (revision(incoming) < revision(current)) return current;
  if (current.delivery?.fullDeliverySufficient && !incoming.delivery?.fullDeliverySufficient)
    return current;
  return incoming;
}
export function mountOperations({
  api,
  document,
  onLocal,
  selectedLocalId = () => null,
  onImport,
  onDemo,
  isDemo,
  onOperation = () => {},
  observationGeneration = () => 0,
  onHostedObserved = () => {},
  agentLabel = (value) => value,
}) {
  const node = (id) => document.getElementById(id);
  let overview = null,
    setup = null,
    selected = null,
    selectedKey = "",
    epoch = 0,
    reading = false;
  const mutationStates = new Map();
  const mutationState = (key) =>
    mutationStates.get(key) ?? { pending: false, cancelPending: false, uncertain: false };
  let cursors = {};
  const localDeliveryPending = new Set();
  const el = (tag, text, className) => {
    const element = document.createElement(tag);
    element.textContent = text ?? "";
    if (className) element.className = className;
    return element;
  };
  const tell = (message, error = false) => {
    node("operations-message").textContent = message;
    node("operations-message").className = `notice ${error ? "danger" : "info"}`;
  };
  const source = (value) => (value?.state === "available" ? value.value : null);
  const home = (page = "monitor") => {
    document.body.classList.toggle("operations-home", true);
    node("operations-monitor").hidden = page !== "monitor";
    node("operations-setup").hidden = page !== "setup";
    node("operations-detail").hidden = true;
    node("operations-home-title").textContent =
      page === "setup" ? "接続と登録の確認" : "進行と結果";
  };
  const entry = (value) => {
    const title =
      value.kind === "fanout" ? `まとめて依頼 · ${value.total}件` : value.presentation.title;
    const button = el("button", "", "operation-row");
    button.type = "button";
    button.append(
      el("span", ROUTES[value.kind], "micro"),
      el("strong", title),
      el(
        "span",
        value.kind === "fanout"
          ? `${value.available}/${value.total} 応答あり · ${value.fullDeliverySufficient}件 受領確認`
          : `${STATES[value.status ?? value.state] ?? value.status ?? value.state} · ${value.delivery.fullDeliverySufficient ? "成果物受領を確認済み" : "受領の証明は未完了"}`,
        "small muted",
      ),
    );
    button.addEventListener(
      "click",
      () =>
        void select(value.kind, value.kind === "fanout" ? value.fanoutId : value.binding.requestId),
    );
    return button;
  };
  function renderOverview() {
    node("operations-list").replaceChildren();
    let count = 0;
    for (const [lane, title] of [
      ["local", "CLI"],
      ["hosted", "通常チャット"],
      ["fanout", "まとめて依頼"],
    ]) {
      const group = el("section", "", "operation-lane");
      group.append(el("h3", title));
      const page = source(overview?.[lane]);
      if (!page) group.append(el("p", overview?.[lane]?.reason ?? "記録を確認中", "small muted"));
      else {
        for (const item of page.items) {
          const value = source(item);
          if (value) {
            group.append(entry(value));
            count++;
          } else group.append(el("p", item.reason, "small muted"));
        }
        if (!page.items.length) group.append(el("p", "保存された依頼はありません", "small muted"));
        if (page.next) {
          const more = el("button", "次の記録", "btn subtle");
          more.type = "button";
          more.addEventListener("click", () => {
            cursors = { ...cursors, [`${lane}After`]: page.next };
            void refresh(true);
          });
          group.append(more);
        }
      }
      node("operations-list").append(group);
    }
    node("operations-empty").hidden = count > 0;
    node("operations-demo").hidden = !isDemo();
  }
  function renderSetup() {
    node("operations-setup-content").replaceChildren();
    const registry = source(setup?.registry),
      destinations = source(setup?.destinations),
      quotas = source(setup?.quotas);
    const section = (title) => {
      const card = el("section", "", "card");
      card.append(el("h3", title));
      node("operations-setup-content").append(card);
      return card;
    };
    const projects = section("登録されたプロジェクト");
    if (registry) {
      projects.append(el("p", `登録 revision ${registry.revision}`, "small muted"));
      for (const project of registry.projects)
        projects.append(el("p", `${project.displayName} · ${project.repoId}`, "small"));
      if (!registry.projects.length) projects.append(el("p", "登録なし", "small muted"));
    } else projects.append(el("p", setup?.registry?.reason ?? "未確認", "small muted"));
    const routes = section("誰へ・どの経路で渡すか");
    if (destinations) {
      for (const destination of destinations)
        routes.append(
          el(
            "p",
            `${destination.destinationId} → ${destination.recipientActorId} / ${destination.route} / ${agentLabel(destination.providerId)} / ${destination.modelIds.join(", ")} · ${destination.unavailableReason ?? "登録済み。実行時の権限確認は別途必要"}`,
            "small",
          ),
        );
      if (!destinations.length) routes.append(el("p", "構成済みの宛先はありません", "small muted"));
    } else routes.append(el("p", setup?.destinations?.reason ?? "未確認", "small muted"));
    const quota = section("利用枠の観測");
    if (quotas) {
      for (const item of quotas)
        quota.append(
          el(
            "p",
            `${item.providerId}: ${item.remainingPercent === null ? "残量不明" : `${item.remainingPercent}%（観測値）`} · source ${item.source} · ${item.observedAt ?? "観測時刻不明"} · ${item.freshness} / ${item.verification}`,
            "small",
          ),
        );
    } else quota.append(el("p", setup?.quotas?.reason ?? "未確認", "small muted"));
    if (quotas)
      for (const item of quotas)
        quota.append(
          el(
            "p",
            item.boundedFallback
              ? `利用枠が不明な場合の設定上限: 開始 ${item.boundedFallback.maxStarts}回 / 1回 ${item.boundedFallback.maxRunSeconds}秒 / 事前許可 ${item.boundedFallback.preauthorized ? "あり" : "なし"}。ポリシーと残り枠の両方を実行時に再確認します`
              : "不明な利用枠で継続する有限の設定は未確認です",
            "small muted",
          ),
        );
    quota.append(
      el(
        "p",
        "公式枠と手動設定は区別します。プロバイダー名だけでは、この依頼と同じアカウント・課金経路かは未確認です。料金の見積もりや無制限の実行許可には使いません",
        "small muted",
      ),
    );
  }
  function renderDetail() {
    if (!selected) return;
    onOperation(selected);
    const { pending, cancelPending, uncertain } = mutationState(operationIdentity(selected));
    const view = node("operations-detail-content");
    view.replaceChildren();
    view.append(el("p", ROUTES[selected.kind], "eyebrow"));
    if (selected.kind === "fanout") {
      view.append(
        el("h2", `応答 ${selected.available}/${selected.total}`),
        el(
          "p",
          `受領を確認済み ${selected.fullDeliverySufficient} / 未着 ${selected.pending}`,
          "small",
        ),
      );
      for (const child of selected.children) {
        const card = el("article", "", "card");
        card.append(
          el("strong", `${ROUTES[child.kind]} · ${child.state}`),
          el("p", child.requestId, "mono"),
          el(
            "p",
            `${child.outcome ?? "結果未確認"} · ${child.fullDeliverySufficient ? "成果物受領を確認済み" : "受領証明未完了"}`,
            "small",
          ),
        );
        const openChild = el("button", "この依頼を見る", "btn subtle");
        openChild.type = "button";
        openChild.addEventListener("click", () => void select(child.kind, child.requestId));
        card.append(openChild);
        const result = source(child.result);
        if (result?.kind === "hosted_delivery" && result.markdown)
          card.append(el("pre", result.markdown, "editor source-pre"));
        view.append(card);
      }
      return;
    }
    view.append(
      el("h2", selected.presentation.title),
      el("p", selected.binding.requestId, "mono"),
      el(
        "p",
        `${selected.context.requesterId ?? "依頼元不明"} → ${selected.context.recipientActorId ?? "宛先未確認"} → ${selected.context.project.displayName ?? selected.context.project.repoId}`,
        "small",
      ),
      el(
        "p",
        `${STATES[selected.state] ?? selected.state} · 最終観測 ${selected.presentation.observedAt ?? "不明"}`,
        "small",
      ),
    );
    view.append(
      el(
        "p",
        `モデル要求 ${selected.presentation.requestedModel ?? "不明"} / 実際 ${selected.presentation.actualModel ?? "不明"}`,
        "small",
      ),
    );
    view.append(el("p", selected.delivery.reason, "notice info"));
    if (selected.kind === "hosted_delivery") {
      view.append(
        el(
          "p",
          "これは通常チャットの応答状態です。ローカルプロセスの実行成功や停止を示しません",
          "small muted",
        ),
      );
      view.append(
        el(
          "p",
          `attempt ${selected.binding.attemptId ?? "未開始"} / revision ${selected.binding.revision}`,
          "mono",
        ),
      );
      if (selected.cancelRequestedAt)
        view.append(
          el("p", `停止要求 ${selected.cancelRequestedAt}。チャット側の停止は未確定です`, "notice"),
        );
    }
    const evidence = el("details", "", "progressive"),
      summary = el("summary", "正確な依頼と受け渡しの証跡");
    evidence.append(summary);
    evidence.append(
      el(
        "p",
        `TaskSpec SHA-256 ${selected.binding.taskSpecHash} / policy ${selected.policyHash}`,
        "mono",
      ),
    );
    evidence.append(
      el("h3", "TaskSpec JSON（受理済み原文）"),
      el("pre", selected.rawSpec, "editor source-pre"),
      el("h3", "task.md（受理済み原文）"),
      el("pre", selected.taskMarkdown, "editor source-pre"),
    );
    evidence.append(
      el(
        "p",
        `terminal ${selected.terminal?.eventId ?? "未観測"} / payload ${selected.terminal?.payloadSha256 ?? "未観測"}`,
        "mono",
      ),
      el(
        "p",
        `frame raw ${selected.frame?.rawSha256 ?? "未取得"} / body ${selected.frame?.bodySha256 ?? "未取得"}`,
        "mono",
      ),
      el(
        "p",
        `materialization receipt ${selected.delivery.materializationReceiptSha256 ?? "未確認"}`,
        "mono",
      ),
    );
    const provenance = source(selected.source),
      archive = source(selected.archive);
    evidence.append(
      el(
        "p",
        provenance
          ? `conversation ${provenance.conversationId} / user turn ${provenance.userTurnId} / assistant turn ${provenance.assistantTurnId}`
          : "元の会話・ターンは未確認です",
        "mono",
      ),
      el(
        "p",
        archive
          ? `archive ${archive.state} / manifest ${archive.manifestSha256 ?? "未取得"}`
          : "成果物の保存状態は未確認です",
        "mono",
      ),
    );
    view.append(evidence);
    if (selected.responseMarkdown !== null) {
      view.append(
        el("h3", "取得したチャット応答"),
        el("pre", selected.responseMarkdown, "editor source-pre"),
      );
    } else view.append(el("p", "応答本文の正確な取得記録は未確認です", "small muted"));
    const actions = el("div", "", "operation-actions");
    for (const [action, label] of Object.entries(ACTIONS)) {
      const capability = selected.capabilities[action];
      const button = el("button", label, "btn subtle");
      button.type = "button";
      button.disabled =
        !capability?.enabled ||
        uncertain ||
        (action === "cancel" ? cancelPending : pending || cancelPending);
      button.title = uncertain
        ? "前の操作が未確認です。記録を再読込してください"
        : (capability?.reason ?? "利用できません");
      button.addEventListener("click", () => void mutate(action));
      actions.append(button);
      if (!capability?.enabled)
        actions.append(el("p", capability?.reason ?? "未構成", "small muted"));
    }
    view.append(actions);
  }
  async function select(kind, id) {
    if (kind === "local_execution") {
      const read = ++epoch;
      selectedKey = "";
      selected = null;
      document.body.classList.toggle("operations-home", false);
      node("local-operations-context").replaceChildren(
        el("p", "記録を確認しています", "small muted"),
      );
      await onLocal(id);
      try {
        const response = await api(`/api/operations/local_execution/${id}`);
        if (read !== epoch || selectedLocalId() !== id) return;
        const operation = source(response.operation);
        if (!operation) throw new Error("unavailable");
        const context = operation.context,
          view = node("local-operations-context");
        view.dataset.requestId = id;
        view.replaceChildren();
        view.append(
          el(
            "p",
            `${context.requesterId ?? "依頼元不明"} → ${context.recipientActorId ?? "宛先不明"} → ${context.project.displayName ?? context.project.repoId}`,
            "small",
          ),
        );
        view.append(
          el(
            "p",
            `登録 ${context.project.state} / revision ${context.project.reference?.registryRevision ?? "不明"}`,
            "small muted",
          ),
        );
        view.append(el("h3", "配送経路の成果物受領"));
        view.append(
          el(
            "p",
            operation.delivery.fullDeliverySufficient
              ? "署名付き配送記録: 成果物受領を確認済み"
              : "署名付き配送記録: 成果物受領の証明は未完了",
            "small",
          ),
        );
        view.append(
          el(
            "p",
            "ローカル実行台帳への反映は配送ホストの受信確認後です。ここで再実行しません",
            "small muted",
          ),
        );
        const deliveryAction = el("button", "配送先の成果物を検証して受領", "btn subtle");
        deliveryAction.type = "button";
        deliveryAction.disabled =
          !operation.capabilities.ack.enabled || localDeliveryPending.has(id);
        deliveryAction.title = operation.capabilities.ack.reason;
        deliveryAction.addEventListener("click", async () => {
          if (localDeliveryPending.has(id) || selectedLocalId() !== id || read !== epoch) return;
          localDeliveryPending.add(id);
          deliveryAction.disabled = true;
          try {
            const terminal = operation.task.handshakes.terminal_result;
            if (!terminal) throw new Error("terminal_unavailable");
            await api("/api/operations/actions", {
              version: "bridge-operations-1",
              action: "ack",
              binding: operation.binding,
              terminal: { eventId: terminal.eventId, payloadSha256: terminal.payloadSha256 },
            });
            if (read === epoch && selectedLocalId() === id) {
              localDeliveryPending.delete(id);
              await select("local_execution", id);
            }
          } catch {
            if (read === epoch && selectedLocalId() === id)
              view.append(
                el(
                  "p",
                  "受領操作の結果を確認できません。再送せず配送記録を再読込してください",
                  "notice danger",
                ),
              );
          } finally {
            localDeliveryPending.delete(id);
          }
        });
        const rereadDelivery = el("button", "配送記録を再読込", "btn subtle");
        rereadDelivery.type = "button";
        rereadDelivery.addEventListener("click", () => {
          if (selectedLocalId() === id && !localDeliveryPending.has(id))
            void select("local_execution", id);
        });
        view.append(deliveryAction, rereadDelivery);
        const dependencies = source(context.dependencies);
        view.append(el("h3", "依存関係"));
        if (dependencies) {
          for (const dependency of dependencies)
            view.append(
              el(
                "p",
                `${dependency.requestId} · ${dependency.requireAck ? "成果物受領の証明が必要" : "結果条件を照合"}`,
                "mono",
              ),
            );
          if (!dependencies.length) view.append(el("p", "依存する依頼なし", "small muted"));
        } else view.append(el("p", "依存関係を確認できません", "small muted"));
        const resources = source(operation.resources);
        view.append(el("h3", "このセッションの実行枠とロック"));
        if (resources) {
          view.append(
            el(
              "p",
              `開始 ${resources.session.starts} / ポリシー上限 ${resources.limits.maxStarts ?? "不明"} · 予約 ${resources.session.reserved} · 期限 ${resources.limits.deadlineAt ?? "不明"}`,
              "small",
            ),
            el(
              "p",
              `停止 ${resources.session.stopped ? "あり" : "なし"} / 一時停止 ${resources.session.paused ? "あり" : "なし"} / 予約秒 ${resources.session.reservedSeconds} / 最大秒 ${resources.limits.maxReservedSeconds ?? "不明"}`,
              "small",
            ),
          );
          for (const lock of resources.locks)
            view.append(el("p", `lock ${lock.resourceId} → ${lock.requestId}`, "mono"));
        } else view.append(el("p", "実行枠は未確認。無制限とは判断しません", "small muted"));
      } catch {
        if (read === epoch)
          node("local-operations-context").replaceChildren(
            el("p", "追加の運用記録を確認できません。操作権限は変更していません", "small muted"),
          );
      }
      return;
    }
    const key = `${kind}:${id}`,
      read = ++epoch;
    selectedKey = key;
    selected = null;
    home();
    node("operations-monitor").hidden = true;
    node("operations-detail").hidden = false;
    node("operations-detail-content").replaceChildren(el("p", "記録を確認しています"));
    try {
      const response = await api(`/api/operations/${kind}/${id}`);
      if (read !== epoch || selectedKey !== key) return;
      const value = source(response.operation);
      if (!value) throw new Error("unavailable");
      selected = value;
      renderDetail();
    } catch {
      if (read === epoch) tell("依頼の記録を確認できません。再読込で確認してください", true);
    }
  }
  async function refresh(manual = false) {
    if (reading) return;
    reading = true;
    const read = epoch,
      notificationReadGeneration = observationGeneration();
    try {
      const [page, settings] = await Promise.all([
        Object.keys(cursors).length
          ? api("/api/operations/query", { limit: 32, ...cursors })
          : api("/api/operations"),
        api("/api/setup"),
      ]);
      overview = page.operations;
      const hosted = source(overview.hosted);
      if (hosted)
        onHostedObserved(
          hosted.items.map(source).filter(Boolean),
          notificationReadGeneration,
          overview.readStartedAt,
        );
      setup = settings.setup;
      renderOverview();
      renderSetup();
      if (selectedKey && read === epoch) {
        const [kind, id] = selectedKey.split(":");
        const response = await api(`/api/operations/${kind}/${id}`);
        if (read === epoch) {
          const value = source(response.operation);
          if (value) {
            selected = chooseOperation(selected, value);
            if (manual) {
              const flags = mutationStates.get(selectedKey);
              if (flags) flags.uncertain = false;
            }
            renderDetail();
          }
        }
      }
      if (manual) tell("保存記録を再読込しました。操作を再送していません");
    } catch {
      tell("接続を確認できません。最後の観測を保持しています", true);
    } finally {
      reading = false;
    }
  }
  async function mutate(action) {
    const task = selected;
    if (!task || task.kind === "fanout") return;
    const key = operationIdentity(task),
      flags = mutationState(key),
      read = epoch;
    if (
      flags.uncertain ||
      !task.capabilities[action]?.enabled ||
      (action === "cancel" ? flags.cancelPending : flags.pending || flags.cancelPending)
    )
      return;
    mutationStates.set(key, flags);
    if (action === "cancel") flags.cancelPending = true;
    else flags.pending = true;
    renderDetail();
    try {
      const response = await api("/api/operations/actions", {
        version: "bridge-operations-1",
        action,
        binding: task.binding,
        ...(action === "ack" ? { terminal: task.terminal } : {}),
      });
      const value = source(response.operation);
      if (!value) flags.uncertain = true;
      if (read === epoch && selectedKey === key) {
        if (value) selected = chooseOperation(selected, value);
        tell("操作の記録を確認しました。再実行は自動で行いません");
      }
    } catch (error) {
      flags.uncertain = error.uncertain !== false;
      if (read === epoch && selectedKey === key)
        tell("操作結果を確認できません。再送せず記録を再読込してください", true);
    } finally {
      if (action === "cancel") flags.cancelPending = false;
      else flags.pending = false;
      if (!flags.pending && !flags.cancelPending && !flags.uncertain) mutationStates.delete(key);
      if (selectedKey === key) renderDetail();
    }
  }
  node("operations-home").addEventListener("click", () => {
    ++epoch;
    selectedKey = "";
    selected = null;
    home();
    void refresh();
  });
  node("operations-open-setup").addEventListener("click", () => {
    home("setup");
    void refresh();
  });
  node("operations-back").addEventListener("click", () => home());
  node("operations-refresh").addEventListener("click", () => void refresh(true));
  node("operations-import").addEventListener("click", onImport);
  node("operations-demo").addEventListener("click", onDemo);
  let registrySettings = null,
    registryBase = null,
    registryPending = false,
    registryDirty = false,
    registryUncertain = false,
    registryReadEpoch = 0,
    registryEditEpoch = 0,
    registrySelection = "";
  const field = (id) => node(`project-${id}`);
  const editFields = [
    "default-root",
    "display-name",
    "repo-id",
    "storage-slug",
    "root",
    "github-repo",
    "github-branch",
    "github-namespace",
  ];
  const projectMessage = (message) => {
    node("project-settings-status").textContent = message;
  };
  const registryControls = () => {
    const unavailable = !registrySettings?.configurable;
    for (const id of [...editFields, "settings-select", "add"])
      field(id).disabled = registryPending || unavailable;
    field("settings-save").disabled =
      registryPending || unavailable || !registryBase || !registryDirty || registryUncertain;
    field("settings-reset").disabled =
      registryPending || !registrySettings || registrySettings.state !== "available";
  };
  const markRegistryDirty = () => {
    registryDirty = true;
    registryEditEpoch++;
    registryControls();
  };
  const fillProject = (project) => {
    field("display-name").value = project?.displayName ?? "";
    field("repo-id").value = project?.repoId ?? "";
    field("storage-slug").value = project?.storageSlug ?? "";
    field("id").value = project?.projectId ?? "";
    field("root").value = project?.outputRootOverride ?? "";
    field("repo-id").readOnly = !!project;
    field("storage-slug").readOnly = !!project;
    for (const [id, key] of [
      ["github-repo", "repositoryFullName"],
      ["github-branch", "branch"],
      ["github-namespace", "namespace"],
    ])
      field(id).value = project?.githubDestination?.[key] ?? "";
    registrySelection = project?.projectId ?? "";
    field("settings-select").value = registrySelection;
  };
  const fillRegistry = (settings, selected = registrySelection) => {
    registryBase = JSON.parse(JSON.stringify(settings));
    const projects = settings.snapshot?.projects ?? [];
    field("settings-select").replaceChildren(
      ...projects.map((project) => {
        const option = el("option", project.displayName);
        option.value = project.projectId;
        return option;
      }),
    );
    field("default-root").value = settings.snapshot?.defaultOutputRoot ?? "";
    fillProject(projects.find((project) => project.projectId === selected) ?? projects[0]);
    registryDirty = false;
    registryUncertain = false;
    registryControls();
  };
  async function loadRegistry() {
    if (registryPending) return;
    const read = ++registryReadEpoch,
      editing = registryEditEpoch;
    try {
      const response = await api("/api/settings/projects");
      if (read !== registryReadEpoch) return;
      const incoming = response.settings;
      if (
        registrySettings?.state === "available" &&
        incoming.state === "available" &&
        incoming.revision < registrySettings.revision
      )
        return;
      registrySettings = incoming;
      if (incoming.state === "available") {
        if (!registryDirty && editing === registryEditEpoch) fillRegistry(incoming);
        else {
          if (registryUncertain && registryBase?.revision === incoming.revision)
            registryUncertain = false;
          projectMessage(
            `登録 revision ${incoming.revision} を確認しました。未保存の入力は保持しています（下書き revision ${registryBase?.revision ?? "未取得"}）`,
          );
        }
      } else projectMessage(incoming.reason ?? "登録を利用できません");
      if (!registryDirty && incoming.state === "available")
        projectMessage(`登録 revision ${incoming.revision}。保存先の実機検証は未実施です`);
      registryControls();
    } catch {
      if (read === registryReadEpoch) projectMessage("登録を取得できません。入力は保持しています");
    }
  }
  for (const id of editFields) field(id).addEventListener("input", markRegistryDirty);
  node("operations-project-settings").addEventListener("click", () => {
    if (!node("project-settings-dialog").open) node("project-settings-dialog").showModal();
    void loadRegistry();
  });
  node("close-project-settings").addEventListener("click", () =>
    node("project-settings-dialog").close(),
  );
  field("settings-reload").addEventListener("click", () => void loadRegistry());
  field("settings-reset").addEventListener("click", () => {
    if (registryPending || registrySettings?.state !== "available") return;
    ++registryReadEpoch;
    ++registryEditEpoch;
    fillRegistry(registrySettings);
    projectMessage("編集を取り消し、確認済みの登録へ戻しました");
  });
  field("settings-select").addEventListener("change", () => {
    if (registryDirty) {
      field("settings-select").value = registrySelection;
      projectMessage(
        "未保存の入力を保持しています。保存または編集の取り消し後に別のプロジェクトを選んでください",
      );
      return;
    }
    fillProject(
      registryBase?.snapshot?.projects.find(
        (project) => project.projectId === field("settings-select").value,
      ),
    );
  });
  field("add").addEventListener("click", () => {
    if (registryPending || !registrySettings?.configurable) return;
    if (registryDirty) {
      projectMessage("未保存の入力を保持しています。先に保存するか編集を取り消してください");
      return;
    }
    fillProject(null);
    field("id").value = crypto.randomUUID();
    markRegistryDirty();
    field("display-name").focus();
  });
  field("settings-save").addEventListener("click", async () => {
    if (
      registryPending ||
      !registrySettings?.configurable ||
      !registryBase ||
      !registryDirty ||
      registryUncertain
    )
      return;
    registryPending = true;
    ++registryReadEpoch;
    const editing = registryEditEpoch;
    registryControls();
    try {
      const previous = registryBase.snapshot ?? {
        schema: "bridge-project-registry-1",
        projects: [],
      };
      const github = [
        field("github-repo").value,
        field("github-branch").value,
        field("github-namespace").value,
      ];
      const project = {
        projectId: field("id").value,
        repoId: field("repo-id").value,
        storageSlug: field("storage-slug").value,
        displayName: field("display-name").value,
        outputRootOverride: field("root").value || null,
        githubDestination: github.some(Boolean)
          ? { repositoryFullName: github[0], branch: github[1], namespace: github[2] }
          : null,
      };
      const projects = previous.projects.filter((row) => row.projectId !== project.projectId);
      if (project.projectId) projects.push(project);
      const response = await api("/api/settings/projects", {
        expectedRevision: registryBase.revision,
        snapshot: {
          schema: "bridge-project-registry-1",
          revision: registryBase.revision + 1,
          defaultOutputRoot: field("default-root").value || null,
          projects,
        },
      });
      registrySettings = response.settings;
      if (editing === registryEditEpoch) fillRegistry(registrySettings, project.projectId);
      else registryUncertain = true;
      projectMessage(
        editing === registryEditEpoch
          ? "保存しました。既存依頼の登録と実行権限は変更していません"
          : "保存中に入力が変わりました。新しい入力は未保存で保持しています。登録を再読込して確認してください",
      );
      void refresh();
    } catch (error) {
      registryUncertain = error.uncertain || error.status === 409;
      projectMessage(
        "保存を確認できません。入力は保持しています。登録を再読込してrevisionを確認してください。自動再送はしません",
      );
    } finally {
      registryPending = false;
      registryControls();
    }
  });
  registryControls();
  home();
  void refresh();
  setInterval(() => {
    if (!document.hidden) void refresh();
  }, 3000);
  return {
    refresh,
    showHome: home,
    isLocalSelected: () => selectedKey === "",
    currentBinding: () => selected?.binding ?? null,
    selectLocal: (id) => select("local_execution", id),
  };
}
