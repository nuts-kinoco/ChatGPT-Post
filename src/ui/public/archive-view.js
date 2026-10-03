/** Explicit artifact inspection/export. No arbitrary path or file-content endpoint exists. */
export function mountArchive({ api, document, presentation, currentBinding }) {
  const node = (id) => document.getElementById(id),
    el = (tag, text) => {
      const n = document.createElement(tag);
      n.textContent = text ?? "";
      return n;
    };
  let binding = null,
    capability = null,
    ready = false,
    download = null,
    epoch = 0;
  const pending = new Set();
  const key = (value) => (value ? `${value.kind}:${value.requestId}` : "");
  const controls = () => {
    const busy = pending.has(key(binding));
    node("archive-collect").disabled = !binding || !ready || !capability?.collectEnabled || busy;
    node("archive-export").disabled = !binding || !ready || !capability?.enabled || busy;
    node("archive-download").disabled = !download;
  };
  const message = (text) => {
    node("archive-message").textContent = text;
  };
  const body = () => ({ version: "bridge-operations-1", binding });
  const render = (view) => {
    binding = view.binding;
    node("archive-state").textContent =
      `${view.state} · 必須一覧 ${view.requiredSetKnown ? "確認済み" : "不明"} · ${view.complete ? "保存内容を確認済み" : "保存未完了"}`;
    node("archive-pin").textContent =
      `登録 revision ${view.registryRevision} / ${view.pinnedRoot ?? "保存先不明"} / ${view.relativeDirectory ?? ""}`;
    node("archive-manifest-hash").textContent = view.manifestSha256 ?? "manifest未作成";
    node("archive-items").replaceChildren(
      ...view.items.map((item) => {
        const card = el("article");
        card.className = "card";
        card.append(
          el("strong", `${item.logicalName} · ${item.required ? "必須" : "任意"}`),
          el("p", `${item.state} · ${item.sizeBytes ?? "不明"} bytes`),
          el("p", item.contentSha256 ?? item.unavailableReason ?? "未確認"),
        );
        return card;
      }),
    );
  };
  async function open() {
    const read = ++epoch;
    capability = null;
    ready = false;
    const selected = currentBinding();
    binding = selected;
    download = null;
    node("archive-download").disabled = true;
    node("archive-collect").disabled = true;
    node("archive-export").disabled = true;
    node("archive-items").replaceChildren();
    node("archive-export-preview").textContent = "";
    node("archive-pin").textContent = "";
    node("archive-state").textContent = "";
    node("archive-manifest-hash").textContent = "";
    if (!selected) {
      message("依頼を1件選んでから成果物を確認してください");
      if (!node("archive-dialog").open) node("archive-dialog").showModal();
      return;
    }
    binding = selected;
    download = null;
    node("archive-download").disabled = true;
    if (!node("archive-dialog").open) node("archive-dialog").showModal();
    message("固定された依頼と成果物を照合しています");
    try {
      const responseCapability = await api("/api/archive");
      if (read !== epoch) return;
      capability = responseCapability.capability;
      controls();
      if (!capability.enabled) {
        message("成果物アダプターが未構成です。構成済みのhost archiveOperationsが必要です");
        return;
      }
      const response = await api("/api/archive/inspect", body());
      if (read !== epoch) return;
      render(response.archive);
      ready = true;
      controls();
      message("sender側の保存とrequester側の全成果物受領は別々に確認します");
    } catch {
      if (read === epoch)
        message("成果物アダプター、登録pin、またはこの依頼の保存記録を確認できません");
    }
  }
  node("open-archive").addEventListener("click", () => void open());
  node("close-archive").addEventListener("click", () => presentation.closeDialog("archive-dialog"));
  for (const [id, path] of [
    ["archive-collect", "collect"],
    ["archive-export", "export"],
  ])
    node(id).addEventListener("click", async () => {
      if (!binding || pending.has(key(binding)) || node(id).disabled) return;
      const actionKey = key(binding);
      pending.add(actionKey);
      const read = epoch;
      controls();
      try {
        const response = await api(`/api/archive/${path}`, body());
        if (read !== epoch) return;
        if (path === "collect") {
          render(response.archive);
          message("成果物保存の記録を再確認しました。新しい実行は開始していません");
        } else {
          download = response.diagnostic;
          node("archive-export-preview").textContent = download.content;
          node("archive-download").disabled = false;
          message(`診断JSONを用意しました。SHA-256 ${download.sha256}。保存前に内容を確認できます`);
        }
      } catch {
        if (read === epoch)
          message(
            "操作結果を確認できません。未構成・古い依頼状態・保存先権限を確認してください。再実行はしていません",
          );
      } finally {
        pending.delete(actionKey);
        controls();
      }
    });
  node("archive-download").addEventListener("click", () => {
    if (!download) return;
    const blob = new Blob([download.content], { type: "application/json" }),
      url = URL.createObjectURL(blob),
      link = el("a");
    link.href = url;
    link.download = download.filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  });
  let probeAvailable = false,
    probePending = false,
    probeEpoch = 0;
  const probeControls = () => {
    node("project-probe").disabled = probePending || !probeAvailable;
  };
  probeControls();
  node("operations-project-settings").addEventListener("click", async () => {
    const read = ++probeEpoch;
    try {
      const response = await api("/api/archive");
      if (read !== probeEpoch) return;
      probeAvailable = response.capability.enabled;
      node("project-probe").title = probeAvailable
        ? "一時ファイルの作成と削除だけを確認します"
        : "保存先を確認するアダプターが未構成です";
    } catch {
      if (read === probeEpoch) {
        probeAvailable = false;
        node("project-probe").title = "アダプターの接続を確認できません";
      }
    } finally {
      probeControls();
    }
  });
  const probe = async () => {
    const root = node("project-default-root").value;
    if (!root || probePending || !probeAvailable) return;
    const read = probeEpoch;
    probePending = true;
    probeControls();
    try {
      await api("/api/archive/probe", { root });
      if (read !== probeEpoch) return;
      node("project-settings-status").textContent =
        node("project-default-root").value === root
          ? "指定したルートへの一時ファイル作成・削除を確認しました。実行権限は変更していません"
          : "確認中に入力が変わりました。新しいルートは未確認です";
    } catch (error) {
      if (read === probeEpoch)
        node("project-settings-status").textContent =
          error.code === "archive_windows_storage_unimplemented"
            ? "Windowsの保存先ID・ACL検証プロバイダーは未実装です。この確認は利用できません"
            : "保存先を確認できません。所有権・リンク・OS対応・接続を確認してください";
    } finally {
      probePending = false;
      probeControls();
    }
  };
  node("project-probe").addEventListener("click", () => void probe());
  return { open };
}
