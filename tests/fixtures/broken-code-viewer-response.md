20260928T191455Z-ddbb140c

前回ZIPのコード本体は添付に含まれていないため、以下は**末尾の設計説明と、添付された既存APIから再構成した実装**です。target単位の単一FIFO、IME・restoreの編集障壁、保存済みcheckpoint、明示的な再試行、recovery\_requiredの契約を維持しています。 context

## 1\. emakinoco/ui/bridge\_receive.py 全文

Python

実行

"""UI-loop-owned, one-FIFO-per-target TAGKINOCO receive coordination.

  

Receives only append. Composition/restore barriers may prepend, but cannot

reorder receives. Only \_drain saves, adopts, acknowledges and removes a head.

"""

  

from \_\_future\_\_ import annotations

  

import copy

import logging

import uuid

import weakref

from collections import deque

from collections.abc import Callable, Mapping

from dataclasses import dataclass, field

from typing import Any, Literal

  

from emakinoco.core import project as project\_mod

from emakinoco.core.bridge\_models import BridgeApplyResult, BridgePromptCommand

from emakinoco.core.bridge\_receipts import PendingBridgeInbox

  

\_LOG \= logging.getLogger(\_\_name\_\_)

Block \= Literal\["composing", "restore\_dialog", "failed\_head", "pending\_target", "recovery\_required"\]

  

  

@dataclass(frozen\=True)

class DraftTarget:

root\_id: str

dir\_name: str

  

def as\_dict(self) -> dict\[str, str\]:

return {"root\_id": self.root\_id, "dir\_name": self.dir\_name}

  

  

@dataclass(frozen\=True)

class CompositionToken:

## 2\. emakinoco/core/bridge\_receipts.py 全文

Python

実行

"""Atomic, target-explicit inbox. Owned by the UI-loop coordinator."""

  

from \_\_future\_\_ import annotations

  

import copy

import json

import os

import tempfile

import threading

from pathlib import Path

from typing import Any

  

from . import config as config\_mod

from .bridge\_models import BridgePromptCommand, PromptPatch

  

  

class InboxError(ValueError):

"""Corruption or a receipt/target conflict; never interpret this as empty."""

  

  

class PendingBridgeInbox:

"""One process/one coordinator owns this file; no cross-process locking."""

  

\_STATUSES \= {"pending\_target", "pending\_composition", "pending\_edit", "applied", "failed"}

  

def \_\_init\_\_(self, path: Path | None \= None) -> None:

self.path \= path if path is not None else config\_mod.APP\_DATA\_DIR / "bridge\_inbox.json"

self.\_lock \= threading.RLock()

  

@staticmethod

def command\_dict(command: BridgePromptCommand) -> dict\[str, Any\]:

\# Do not deepcopy/asdict a MappingProxyType used for command.meta.

return {

"receipt\_id": command.receipt\_id,

"request\_id": command.request\_id,

"received\_at": command.received\_at,

## 3\. composer.py・workbench.py の変更

**基準は、添付に掲載された変更を適用済みのコードです。** 以下のdiffは添付断片に対して適用・一致確認しています。既存ファイル全体は添付されていないため、実リポジトリでは適用前にgit apply --checkを実行してください。

Diff

`--- a/emakinoco/ui/composer.py +++ b/emakinoco/ui/composer.py @@ -744,2 +744,3 @@ registry = getattr(controller, "bridge_registry", None) + bridge_ui = getattr(controller, "bridge_ui", None) client_id = str(getattr(page_client, "id", id(page_client))) @@ -747,11 +748,26 @@ registry.register(client_id, controller) - for event_name, operation in (("on_connect", "connect"), ("on_disconnect", "disconnect"), ("on_delete", "delete")): - hook = getattr(page_client, event_name, None) - if callable(hook): - # NiceGUI invokes lifecycle hooks with the client object. Keep - # the operation captured by keyword instead of treating that - # positional argument as its name. - hook(lambda _client=None, operation=operation: getattr(registry, operation)(client_id)) + + async def bridge_connected(_client=None) -> None: + registry.connect(client_id) + if bridge_ui is not None: + await bridge_ui.retry_connected(controller) + # A save can have completed while the socket was disconnected. + for name in ("sync_bridge_fields", "refresh_receive_notice", "refresh_bridge_pending"): + callback = getattr(controller, name, None) + if callable(callback): + with page_client: + callback() + resume = getattr(controller, "complete_deferred_project_switch", None) + if callable(resume): + await resume() + + page_client.on_connect(bridge_connected) + page_client.on_disconnect(lambda _client=None: registry.disconnect(client_id)) + page_client.on_delete(lambda _client=None: registry.delete(client_id)) refs: dict[str, Any] = {"detail_opener": None} field_sync = {"bridge": False} + composition_state: dict[str, Any] = {"token": None, "sender": None} + + def bridge_edits_blocked() -> bool: + return bridge_ui is not None and bridge_ui.edits_blocked(controller) seed_sync = {"active": False} @@ -1192,3 +1208,3 @@ def on_prompt(event) -> None: - if field_sync["bridge"] or controller.history.composing: + if field_sync["bridge"] or controller.history.composing or bridge_edits_blocked(): return @@ -1196,27 +1212,28 @@ - async def finish_composition(lane: str, event) -> None: + def start_composition(lane: str, event, epoch: int) -> None: + if epoch != controller.project_epoch or event.sender is not refs.get(lane): + return + if bridge_ui is None: + controller.history.set_composing(True) + return + if composition_state["token"] is not None: + return + token = bridge_ui.begin_composition(controller, lane) + if token is not None: + composition_state.update(token=token, sender=event.sender) + + async def finish_composition(lane: str, event, epoch: int) -> None: + if epoch != controller.project_epoch or event.sender is not refs.get(lane): + return snapshot = dict(getattr(event, "args", None) or {}) - value = str(snapshot.get("value") or "") - # The final DOM snapshot is the one IME edit; held bridge receives are - # intentionally drained afterwards by the coordinator-facing callback. - before = draft.to_recipe() - after = copy.deepcopy(before) - after["prompt" if lane == "prompt" else "negative_prompt"] = value - selection = { - "lane": lane, - "selection_start": snapshot.get("selectionStart", 0), - "selection_end": snapshot.get("selectionEnd", 0), - "selection_direction": snapshot.get("selectionDirection", "none"), - "scroll_top": snapshot.get("scrollTop", 0), - } - transaction = controller.history.commit( - "prompt", before, after, source={"field": lane, "ime": True}, selection=selection, - ) - persistence_failed = False - if transaction is not None: + if bridge_ui is None: + # Standalone/mock Composer keeps the legacy history API. Production + # bridge pages take only the token/coordinator branch below. + before = draft.to_recipe() + after = copy.deepcopy(before) + after[lane] = str(snapshot.get("value") or "") + controller.history.commit("prompt", before, after, source={"field": lane, "ime": True}) + controller.history.set_composing(False) project = controller.persist_active_project() if project is not None and config_mod.PROJECT_ROOT_CONFIGURED: - # The pending bridge commands must observe this exact persisted - # IME edit. Scheduling it behind the FIFO drain can overwrite - # a later staged bridge save with the older draft. try: @@ -1224,13 +1241,16 @@ except (OSError, ValueError): - persistence_failed = True - ui.notify("入力内容を保存できませんでした。受信処理を保留しました。", type="negative") - pending = controller.history.end_composition() - drain = getattr(controller, "drain_bridge_pending", None) - if callable(drain): - await drain(pending, selection=selection, blocked=persistence_failed) - restore_focus = getattr(controller, "restore_ime_focus", None) - if callable(restore_focus): - restore_focus(selection) + ui.notify("入力内容を保存できませんでした。", type="negative") + sync_bridge_fields() + return + token = composition_state["token"] + if token is None or token.lane != lane or composition_state["sender"] is not event.sender: + return + try: + outcome = await bridge_ui.finish_composition(controller, token, snapshot) + finally: + composition_state.update(token=None, sender=None) + if outcome.block == "failed_head": + ui.notify("入力内容または受信内容を保存できませんでした。保留欄から再試行してください。", type="negative") resume = getattr(controller, "complete_deferred_project_switch", None) - if callable(resume): + if callable(resume) and not bridge_ui.blocks_project_switch(controller): await resume() @@ -1443,8 +1463,13 @@ refs["negative_prompt"] = np + np_epoch = controller.project_epoch + if bridge_edits_blocked(): + np.props("readonly") np.on_value_change( lambda e: set_value("negative_prompt", e.value or "") - if not field_sync["bridge"] and not controller.history.composing else None + if np_epoch == controller.project_epoch and e.sender is refs.get("negative_prompt") + and not field_sync["bridge"] and not controller.history.composing + and not bridge_edits_blocked() else None ) - np.on("compositionstart", lambda _e: controller.history.set_composing(True), js_handler=COMPOSITION_SNAPSHOT_JS) - np.on("compositionend", lambda event: finish_composition("negative_prompt", event), js_handler=COMPOSITION_SNAPSHOT_JS) + np.on("compositionstart", lambda e: start_composition("negative_prompt", e, np_epoch), js_handler=COMPOSITION_SNAPSHOT_JS) + np.on("compositionend", lambda e: finish_composition("negative_prompt", e, np_epoch), js_handler=COMPOSITION_SNAPSHOT_JS) @ui.refreshable @@ -2115,4 +2140,6 @@ ) - prompt.on("compositionstart", lambda _e: controller.history.set_composing(True), js_handler=COMPOSITION_SNAPSHOT_JS) - prompt.on("compositionend", lambda event: finish_composition("prompt", event), js_handler=COMPOSITION_SNAPSHOT_JS) + if bridge_edits_blocked(): + prompt.props("readonly") + prompt.on("compositionstart", lambda e: start_composition("prompt", e, field_epoch), js_handler=COMPOSITION_SNAPSHOT_JS) + prompt.on("compositionend", lambda e: finish_composition("prompt", e, field_epoch), js_handler=COMPOSITION_SNAPSHOT_JS) def open_prompt_maker() -> None: @@ -2272,24 +2299,39 @@ - restore_dialog_values: dict[str, str] = {"transaction_id": "", "target": "", "before_prompt": "", "before_negative": ""} + restore_dialog_values: dict[str, Any] = {"transaction_id": "", "target": None} + + def report_restore_outcome(outcome) -> None: + if not outcome.restored: + ui.notify("受信前の内容を保存できませんでした。復元と後続受信を保留しています。", type="negative") + elif not outcome.drained: + ui.notify("受信前へ戻しました。後続の受信は保留中です。保留欄を確認してください。", type="warning") + + async def resume_project_switch() -> None: + resume = getattr(controller, "complete_deferred_project_switch", None) + if callable(resume): + await resume() async def restore_received_prompt(transaction_id: str) -> None: - nonlocal restore_dialog - if controller.history.can_undo_receive(transaction_id): - undo_history() + if bridge_ui is None: + if controller.history.can_undo_receive(transaction_id): + undo_history() return - bridge_ui = getattr(controller, "bridge_ui", None) - if bridge_ui is None: + source = controller.history.find_transaction(transaction_id) + if source is None: return + latest = controller.history.can_undo_receive(transaction_id) target = bridge_ui.begin_restore_dialog(controller, transaction_id) - source = controller.history.find_transaction(transaction_id) - if target is None or source is None: + if target is None: + ui.notify("入力確定または復元処理が保留中です。先に保留内容を確認してください。", type="warning") return - restore_dialog_values.update( - transaction_id=transaction_id, - target=target, - before_prompt=str(source.before.get("prompt") or ""), - before_negative=str(source.before.get("negative_prompt") or ""), - ) - if restore_dialog is not None: - restore_dialog.open() + if latest: + outcome = await bridge_ui.confirm_restore_dialog(controller, target, transaction_id) + report_restore_outcome(outcome) + await resume_project_switch() + return + restore_dialog_values.update(transaction_id=transaction_id, target=target) + restore_current_prompt.set_text(f"現在 PP: {controller.draft.prompt}") + restore_current_negative.set_text(f"現在 NP: {controller.draft.negative_prompt}") + restore_before_prompt.set_text(f"戻す内容 PP: {source.before.get('prompt') or ''}") + restore_before_negative.set_text(f"戻す内容 NP: {source.before.get('negative_prompt') or ''}") + restore_dialog.open() @@ -2301,4 +2343,6 @@ for receipt in reversed(controller.history.receipts): - if isinstance(receipt, dict) and isinstance(receipt.get("transaction_id"), str): - latest_tx_id = receipt["transaction_id"] + transaction_id = receipt.get("transaction_id") if isinstance(receipt, dict) else None + source = controller.history.find_transaction(transaction_id) if isinstance(transaction_id, str) else None + if source is not None and source.kind == "receive": + latest_tx_id = transaction_id break @@ -2306,5 +2350,37 @@ return + + async def restore_latest(_event=None) -> None: + # The click event must not overwrite the captured transaction ID. + await restore_received_prompt(latest_tx_id) + with ui.row().classes("w-full items-center ek-override-bar").mark("tagkinoco-receive-notice"): ui.label("TAGKINOCOから置き換えました") - ui.button("元に戻す", on_click=lambda tx_id=latest_tx_id: restore_received_prompt(tx_id)).props("flat dense no-caps") + ui.button("元に戻す", on_click=restore_latest).props("flat dense no-caps").mark("receive-restore-open") + + @ui.refreshable + def bridge_pending_bar() -> None: + snapshot = bridge_ui.snapshot_for(controller) if bridge_ui is not None else None + if snapshot is None or snapshot.drained: + return + labels = { + "composing": "入力の確定を待っています", + "restore_dialog": "元に戻す操作の確認を待っています", + "failed_head": "保存できなかった内容を先頭で保留しています", + "pending_target": "元の画面・制作フォルダでの再開を待っています", + "recovery_required": "以前の実行の保留があります。復旧確認が必要です", + } + with ui.column().classes("w-full ek-override-bar").mark("bridge-pending-notice"): + ui.label(labels.get(snapshot.block, "受信を保留しています")) + ui.label(f"保留受信 {len(snapshot.receipt_ids)} 件 / 先頭の失敗 {snapshot.attempts} 回") + ui.label(snapshot.reason).classes("ek-caption").mark("bridge-pending-reason") + + async def retry_pending(_event=None) -> None: + result = await bridge_ui.retry_target(controller, snapshot.target) + if not result.drained: + ui.notify("保留は解除されていません。表示された理由を確認してください。", type="warning") + await resume_project_switch() + + retry_button = ui.button("再試行", on_click=retry_pending).props("flat dense no-caps").mark("bridge-retry") + if snapshot.block in {"recovery_required", "composing", "restore_dialog"}: + retry_button.props("disable") @@ -2312,15 +2388,41 @@ receive_notice_bar() - controller.refresh_receive_notice = receive_notice_bar.refresh # type: ignore[attr-defined] - - def sync_bridge_fields() -> None: + bridge_pending_bar() + + def refresh_receive_notice() -> None: + if page_client.has_socket_connection: + with page_client: + receive_notice_bar.refresh() + + def refresh_bridge_pending(_snapshot=None) -> None: if not page_client.has_socket_connection: return - field_sync["bridge"] = True - try: - for name, value in (("prompt", controller.draft.prompt), ("negative_prompt", controller.draft.negative_prompt)): + with page_client: + locked = bridge_edits_blocked() + for name in ("prompt", "negative_prompt"): element = refs.get(name) - if element is not None and element.value != value: - element.set_value(value) - finally: - field_sync["bridge"] = False + if element is not None: + if locked: + element.props("readonly") + else: + element.props(remove="readonly") + br
