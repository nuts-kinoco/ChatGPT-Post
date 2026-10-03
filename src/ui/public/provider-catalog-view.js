/** Cached metadata only. Never registers a task model or opens a login flow. */
const REASONS = {
  unconfigured: "ホストにメタデータ確認が登録されていません",
  disabled: "メタデータ確認は無効です",
  demo_disabled: "デモではメタデータ確認を行いません",
  platform_unsupported: "このホストではメタデータ確認を利用できません",
  auth_required:
    "隔離した確認用環境ではモデル一覧を取得できませんでした。通常のAntigravityアカウントのログイン状態は不明です",
  format_unverified: "一覧の出力形式を検証できていないため、モデル名とIDは未確認です",
  ownership_unknown: "前の確認処理の終了を確認できません。ホスト側の確認が必要です",
  context_changed: "保存済み記録とホストの登録が一致しません",
  storage_invalid: "保存済み記録を検証できません",
  storage_untrusted: "保存領域を検証できません",
  storage_unavailable: "確認記録を安全に保存できません",
  clock_rollback: "ホストの時刻を確認してください",
  timeout: "メタデータ確認が制限時間に達しました",
  process_failed: "メタデータ確認に失敗しました。原因は未確認です",
  binary_untrusted: "登録された実行ファイルを検証できません",
  version_unsupported: "このCLIのバージョンには未対応です",
  shutting_down: "ホストを終了しています",
};
export function metadataCopy(view) {
  return {
    context:
      "Antigravity · 空のHOMEを使う隔離メタデータ環境。通常アカウントの利用可否・料金は不明です",
    status: view?.refreshing
      ? "メタデータを確認中です"
      : view?.reason
        ? (REASONS[view.reason] ?? "メタデータの状態は未確認です")
        : "保存済みメタデータを表示しています",
    observation: `最終取得: ${view?.catalog?.fetchedAt ?? "未取得"} · 出典: ${view?.catalog?.catalog?.source?.kind ?? "未確認"} · 状態: ${view?.catalog?.state ?? "unknown"}${view?.catalog?.stale ? "（期限切れ・再確認待ち）" : ""}`,
    schedule: `次回確認可能: ${view?.nextAllowedAt ?? "未設定"} · ホスト稼働中の24時間ごとの確認: ${view?.backgroundRefresh ? "有効" : "無効"}`,
    models: view?.catalog?.catalog?.options?.length
      ? view.catalog.catalog.options
          .map((row) => `${row.label} · ID: ${row.providerModelId ?? "未確認"}`)
          .join("\n")
      : "利用できるモデル・モデル別のeffortは未確認です",
  };
}
export function mountProviderCatalog({ api, document }) {
  const node = (name) => document.getElementById(`provider-catalog-${name}`);
  let epoch = 0,
    pending = false,
    uncertain = false,
    destroyed = false;
  let current = null;
  const render = (view) => {
    current = view;
    const copy = metadataCopy(view);
    for (const name of ["context", "status", "observation", "schedule", "models"])
      node(name).textContent = copy[name];
    node("refresh").disabled = pending || uncertain || view?.refreshAllowed !== true;
  };
  const read = async () => {
    if (destroyed) return;
    const serial = ++epoch;
    try {
      const response = await api("/api/provider-catalog");
      if (destroyed || serial !== epoch) return;
      uncertain = false;
      render(response.metadata);
    } catch {
      if (destroyed || serial !== epoch) return;
      node("status").textContent = "記録を読み込めませんでした。再読込してください";
      node("refresh").disabled = true;
    }
  };
  const refresh = async () => {
    if (destroyed || pending || uncertain || current?.refreshAllowed !== true) return;
    pending = true;
    const serial = ++epoch;
    render(current);
    try {
      const response = await api("/api/provider-catalog/refresh", {
        version: "bridge-antigravity-metadata-host-1",
      });
      if (destroyed || serial !== epoch) return;
      current = response.metadata;
    } catch {
      if (destroyed) return;
      uncertain = true;
    } finally {
      pending = false;
      // A newer GET may have supplied current while this POST was pending. Re-enable
      // its controls after drain, but never replace it with an older POST observation.
      if (!destroyed) {
        render(current);
        if (uncertain)
          node("status").textContent =
            "応答を確認できません。記録を再読込してください。自動で再送しません";
      }
    }
  };
  const toggle = () => {
    if (node("panel").open) void read();
    else epoch++;
  };
  node("panel").addEventListener("toggle", toggle);
  node("read").addEventListener("click", read);
  node("refresh").addEventListener("click", refresh);
  render(null);
  return {
    read,
    refresh,
    destroy() {
      destroyed = true;
      epoch++;
      node("panel").removeEventListener("toggle", toggle);
      node("read").removeEventListener("click", read);
      node("refresh").removeEventListener("click", refresh);
    },
  };
}
