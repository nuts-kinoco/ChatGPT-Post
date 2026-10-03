/** Secondary manual composer. Edits invalidate previews; issue uses immutable server-owned bytes. */
export function mountComposer({ api, document, presentation }) {
  const node = (id) => document.getElementById(id),
    el = (tag, text) => {
      const e = document.createElement(tag);
      e.textContent = text ?? "";
      return e;
    };
  let setup = null,
    preview = null,
    revision = 0,
    pending = false,
    uncertain = false;
  let promptFormats = [];
  const targets = [];
  const message = (text) => {
    node("composer-message").textContent = text;
  };
  const changed = () => {
    revision++;
    preview = null;
    node("composer-issue").disabled = true;
    node("composer-preview-bytes").replaceChildren();
    controls();
  };
  const modeState = () => {
    const bound = targets.map((target) =>
      promptFormats.some(
        (entry) =>
          entry.destinationId === target.destination.value &&
          entry.modelId === target.model.value &&
          entry.promptFormat?.readiness === "registered-pre-approval" &&
          entry.promptFormat?.codec === "bridge-task-brief-1",
      ),
    );
    return { anyBound: bound.some(Boolean), allBound: bound.length > 0 && bound.every(Boolean) };
  };
  const updateModes = () => {
    const { anyBound, allBound } = modeState();
    const select = node("composer-mode");
    for (const option of select.children)
      option.disabled = option.value === "legacy-verbatim" ? anyBound : !allBound;
    if (!anyBound) select.value = "legacy-verbatim";
    node("composer-brief-fields").hidden = select.value === "legacy-verbatim";
    node("composer-format-note").textContent = allBound
      ? "登録された形式です。回答・レビュー・変更を明示的に選んでください。承認・試行・出力契約はプレビューでは未確定です"
      : anyBound
        ? "共通形式と従来形式の宛先は同じ下書きに混在できません"
        : "従来の自由記述をそのまま使います。依頼の種類は推測しません";
  };
  const controls = () => {
    updateModes();
    const { anyBound, allBound } = modeState();
    const modeReady = node("composer-mode").value === "legacy-verbatim" ? !anyBound : allBound;
    node("composer-preview").disabled = pending || uncertain || !setup || !!preview || !modeReady;
    node("composer-add-target").disabled = pending || targets.length >= 4 || !setup;
    node("composer-issue").disabled = pending || uncertain || !preview;
  };
  function addTarget() {
    if (!setup || targets.length >= 4) return;
    const row = el("div"),
      destination = el("select"),
      model = el("select"),
      remove = el("button", "削除");
    row.className = "composer-target";
    destination.setAttribute("aria-label", `宛先 ${targets.length + 1}`);
    model.setAttribute("aria-label", `モデル ${targets.length + 1}`);
    remove.type = "button";
    remove.className = "text-button";
    for (const entry of setup.destinations.value) {
      const option = el("option", `${entry.destinationId} · ${entry.route}`);
      option.value = entry.destinationId;
      option.disabled = !!entry.unavailableReason;
      destination.append(option);
    }
    const target = { row, destination, model };
    targets.push(target);
    const models = () => {
      const entry = setup.destinations.value.find(
        (value) => value.destinationId === destination.value,
      );
      model.replaceChildren(
        ...(entry?.modelIds ?? []).map((id) => {
          const option = el("option", id);
          option.value = id;
          return option;
        }),
      );
      changed();
    };
    destination.addEventListener("change", models);
    model.addEventListener("change", changed);
    remove.addEventListener("click", () => {
      const index = targets.indexOf(target);
      if (index >= 0) targets.splice(index, 1);
      row.remove();
      changed();
      controls();
    });
    row.append(destination, model, remove);
    node("composer-targets").append(row);
    models();
    controls();
  }
  node("open-composer").addEventListener("click", async () => {
    if (!node("composer-dialog").open) node("composer-dialog").showModal();
    if (setup || pending) return;
    pending = true;
    controls();
    try {
      const [catalogue, capability] = await Promise.all([api("/api/setup"), api("/api/composer")]);
      if (
        !capability.capability.enabled ||
        catalogue.setup.registry.state !== "available" ||
        catalogue.setup.destinations.state !== "available"
      )
        throw new Error(capability.capability.reason);
      setup = catalogue.setup;
      promptFormats =
        capability.promptFormats?.version === "bridge-composer-prompt-formats-1"
          ? capability.promptFormats.formats
          : [];
      node("composer-project").replaceChildren(
        ...setup.registry.value.projects.map((project) => {
          const option = el("option", `${project.displayName} · ${project.repoId}`);
          option.value = project.projectId;
          return option;
        }),
      );
      addTarget();
      message("登録された範囲で下書きを作ります。まず正確なJSON/MDを確認してください");
    } catch {
      message(
        "登録済みプロジェクト・宛先・信頼済みテンプレートが必要です。設定から構成を確認してください。秘密情報は入力しません",
      );
    } finally {
      pending = false;
      controls();
    }
  });
  node("close-composer").addEventListener("click", () =>
    presentation.closeDialog("composer-dialog"),
  );
  node("composer-add-target").addEventListener("click", addTarget);
  for (const id of [
    "composer-project",
    "composer-title",
    "composer-instruction",
    "composer-mode",
    "composer-constraints",
    "composer-deliverables",
    "composer-acceptance",
  ])
    node(id).addEventListener(
      id === "composer-project" || id === "composer-mode" ? "change" : "input",
      changed,
    );
  node("composer-preview").addEventListener("click", async () => {
    if (pending || uncertain || !setup || preview || node("composer-preview").disabled) return;
    const captured = revision;
    pending = true;
    controls();
    try {
      const response = await api("/api/composer/preview", {
        registryRevision: setup.registry.value.revision,
        projectId: node("composer-project").value,
        destinations: targets.map((target) => ({
          destinationId: target.destination.value,
          modelId: target.model.value,
        })),
        title: node("composer-title").value,
        instruction: node("composer-instruction").value,
        ...(node("composer-mode").value === "legacy-verbatim"
          ? { mode: "legacy-verbatim" }
          : {
              mode: "bridge-task-brief-1",
              taskKind: node("composer-mode").value,
              constraints: node("composer-constraints")
                .value.split("\n")
                .filter((line) => line.trim()),
              deliverables: node("composer-deliverables")
                .value.split("\n")
                .filter((line) => line.trim()),
              acceptance: node("composer-acceptance")
                .value.split("\n")
                .filter((line) => line.trim()),
            }),
      });
      if (captured !== revision) return;
      preview = response;
      node("composer-preview-bytes").replaceChildren();
      for (const child of preview.preview.children) {
        const section = el("section"),
          title = el("h3", `${child.destinationId} · ${child.requestId}`),
          hash = el("p", `JSON ${child.taskSpecHash}\nMD ${child.taskFileHash}`),
          json = el("pre", child.rawSpec),
          md = el("pre", child.taskMarkdown);
        hash.className = "mono";
        json.className = md.className = "editor source-pre";
        section.append(title, hash, json, md);
        if (child.promptPreview) {
          const label = el(
              "p",
              "承認前の表示用プレビュー（non-dispatch-preview）。送信の証明ではありません。承認・試行・出力契約は未確定、セッションとbootstrapはこのブラウザー経路では対象外です",
            ),
            metadata = el("pre", JSON.stringify(child.promptFormat, null, 2)),
            formatted = el("pre", child.promptPreview.preview.text);
          label.className = "notice info";
          metadata.className = formatted.className = "editor source-pre";
          section.append(label, metadata, formatted);
        }
        node("composer-preview-bytes").append(section);
      }
      message(
        "このUUID・JSON・MDを固定して渡します。依頼の発行と受信・開始・成果物受領は別々に記録されます",
      );
    } catch {
      message("プレビューを作れません。入力、登録revision、宛先とモデルを確認してください");
    } finally {
      pending = false;
      controls();
    }
  });
  node("composer-issue").addEventListener("click", async () => {
    if (pending || uncertain || !preview) return;
    const fixed = preview;
    pending = true;
    controls();
    try {
      const response = await api("/api/composer/issue", {
        previewId: fixed.preview.previewId,
        previewSha256: fixed.previewSha256,
      });
      message(
        `送信記録 ${response.issued.commit}。依頼ID: ${response.issued.requestIds.join(", ")}。受信・開始・成果物受領は一覧から別途確認してください`,
      );
      preview = null;
    } catch (error) {
      if (
        error.uncertain === false &&
        [
          "composer_registry_stale",
          "composer_destination_stale",
          "composer_prompt_format_stale",
          "composer_prompt_format_unavailable",
          "composer_prompt_format_binding_invalid",
          "composer_preview_expired",
        ].includes(error.code)
      ) {
        setup = null;
        promptFormats = [];
        targets.splice(0);
        node("composer-targets").replaceChildren();
        changed();
        message(
          "登録またはプレビューが変わったため発行しませんでした。入力は保持しています。閉じてから開き直し、新しい登録とプレビューを確認してください",
        );
      } else {
        uncertain = true;
        message(
          `送信結果が未確認です。自動再送しません。元の依頼ID ${fixed.preview.children.map((child) => child.requestId).join(", ")} を一覧またはCLIで確認してください。入力を変えて再依頼する前に元の記録を確認してください`,
        );
      }
    } finally {
      pending = false;
      controls();
    }
  });
  controls();
}
