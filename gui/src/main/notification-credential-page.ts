import { NOTIFICATION_CREDENTIAL_SCHEME, NOTIFICATION_CREDENTIAL_URL } from "./notification-credential-controller.js";

export const NOTIFICATION_CREDENTIAL_SCRIPT_URL = `${NOTIFICATION_CREDENTIAL_SCHEME}://dialog/page.js`;
export const NOTIFICATION_CREDENTIAL_STYLE_URL = `${NOTIFICATION_CREDENTIAL_SCHEME}://dialog/page.css`;
export const NOTIFICATION_CREDENTIAL_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'none'; font-src 'none'; form-action 'none'; frame-src 'none'; child-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>通知用の認証情報</title><link rel="stylesheet" href="${NOTIFICATION_CREDENTIAL_STYLE_URL}"></head>
<body><main><h1>通知用の認証情報</h1><p id="label"></p><p id="lifetime"></p>
<p>この専用のローカル画面では、認証情報を暗号化してこのコンピューターに保存し、上記の時間だけアプリのメモリ内で利用できる状態にします。登録・保存やロック解除の操作時に、OSの認証情報ストアの初期設定やロック解除を求められる場合があります。</p>
<p>トレイメニューの「通知用の認証情報をロック」で、メモリ内の認証情報の利用を停止できます。スリープ時や、対応している画面・セッションのロックを検知した場合もロックします。Linuxではデスクトップやキーリングのロックを自動検知できないため、トレイからロックするか、有効期限が切れるまでお待ちください。復帰しても自動ではロック解除しません。</p>
<p>OSの確認画面が表示されている間、アプリが応答しなくなる場合があります。キャンセルやロックは、アプリが操作を検知してから有効になります。未処理のクリックでOSの確認画面を中断することはできません。この画面の有効期限は10分です。</p>
<p id="expected"></p><label for="secret" id="secret-label">認証情報</label>
<input id="secret" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="8192">
<p id="target" aria-live="polite"></p>
<label id="consent-row" hidden><input id="consent" type="checkbox"> 表示された送信先、認証情報を暗号化してこのコンピューターに保存すること、および人による確認を求める定型文、依頼ID、正規のChatGPT会話URL（該当する場合）、テスト用の定型文だけを送信することに同意します。</label>
<p>認証情報を保存するだけでは、自動通知はONにならず、テスト送信も行いません。通知設定の保存とテスト送信は、それぞれ別の操作です。</p>
<p id="status" role="status"></p><div class="buttons"><button id="cancel" type="button">キャンセル</button><button id="unlock" type="button" hidden>保存済みの認証情報のロックを解除</button><button id="submit" type="button" disabled>登録して保存</button></div>
</main><script src="${NOTIFICATION_CREDENTIAL_SCRIPT_URL}"></script></body></html>`;
const CSS = `:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0}main{max-width:680px;margin:auto;padding:24px}h1{font-size:1.4rem}p{line-height:1.45;font-size:.9rem}label{display:block;margin:12px 0}#secret{box-sizing:border-box;width:100%;padding:10px;font:inherit}#consent-row{line-height:1.45;font-size:.9rem}#consent-row input{margin-right:8px}.buttons{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:10px;margin-top:20px}button{padding:10px 14px;font:inherit}#target,#expected{overflow-wrap:anywhere}#status{min-height:1.4em}[hidden]{display:none!important}`;
// This script is fixed packaged text. Only safe metadata and the typed secret exist in this renderer.
const SCRIPT = `"use strict";
(() => {
  const element = id => document.getElementById(id);
  const secret = element("secret"), consent = element("consent"), submit = element("submit"), unlock = element("unlock");
  let view = null, used = false;
  const clear = () => { secret.value = ""; consent.checked = false; };
  const discordTarget = value => { const match = /^https:\\/\\/discord\\.com\\/api\\/webhooks\\/([0-9]{1,24})\\/[A-Za-z0-9_-]{1,128}$/.exec(value); return match ? match[1] : null; };
  const update = () => {
    if (!view || used) return;
    const target = view.channel === "discord" ? discordTarget(secret.value) : view.expectedTarget;
    element("target").textContent = target ? "送信先：" + target : "有効な認証情報を入力して、送信先を確認してください";
    submit.disabled = !secret.value || (view.channel === "discord" && !target) || (!view.hasRecord && !consent.checked);
  };
  secret.addEventListener("input", () => { consent.checked = false; update(); });
  consent.addEventListener("change", update);
  const send = async mode => {
    if (!view || used || (mode !== "unlock" && submit.disabled)) return;
    used = true; submit.disabled = true; unlock.disabled = true;
    const value = mode === "unlock" ? {mode} : {mode, secret: secret.value, ...(mode === "register" ? {consent: consent.checked} : {})};
    clear();
    try { if (!await window.bridgeNotificationCredential.submit(value)) element("status").textContent = "認証情報の操作は受け付けられませんでした。この画面を閉じ、設定からやり直してください。"; }
    catch { element("status").textContent = "認証情報の操作を完了できませんでした。設定で操作の状態を確認してください。"; }
    finally { if ("secret" in value) value.secret = ""; }
  };
  submit.addEventListener("click", () => { void send(view && view.hasRecord ? "replace" : "register"); });
  unlock.addEventListener("click", () => { void send("unlock"); });
  element("cancel").addEventListener("click", () => { used = true; clear(); void window.bridgeNotificationCredential.cancel().catch(() => {}); });
  window.addEventListener("pagehide", clear);
  window.bridgeNotificationCredential.view().then(value => {
    if (!value || used) return;
    view = value;
    element("label").textContent = value.label;
    element("lifetime").textContent = "ロック解除の有効時間：" + (value.leaseLifetimeMs / 60000) + "分（固定・自動延長なし）";
    element("expected").textContent = value.expectedTarget ? "承認済みの送信先：" + value.expectedTarget : "登録する前に、以下の送信先を確認してください";
    element("secret-label").textContent = value.channel === "discord" ? "DiscordのWebhook URL" : "設定済みの送信元の認証情報";
    element("consent-row").hidden = value.hasRecord;
    unlock.hidden = !value.hasRecord;
    submit.textContent = value.hasRecord ? "入れ替えて保存" : "登録して保存";
    update();
  }).catch(() => { element("status").textContent = "認証情報の設定画面を利用できません"; });
})();`;

export function notificationCredentialResource(request: {method: string; url: string}, actualSession: unknown, expectedSession: unknown): Response {
  if (!actualSession || actualSession !== expectedSession || request.method !== "GET") return new Response("Not found", {status: 404});
  let body: string, type: string;
  switch (request.url) {
    case NOTIFICATION_CREDENTIAL_URL: body = HTML; type = "text/html; charset=utf-8"; break;
    case NOTIFICATION_CREDENTIAL_SCRIPT_URL: body = SCRIPT; type = "text/javascript; charset=utf-8"; break;
    case NOTIFICATION_CREDENTIAL_STYLE_URL: body = CSS; type = "text/css; charset=utf-8"; break;
    default: return new Response("Not found", {status: 404});
  }
  return new Response(body, {headers: {"Content-Type": type, "Content-Security-Policy": NOTIFICATION_CREDENTIAL_CSP, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer"}});
}

export function isNotificationCredentialResource(url: string, resourceType: string): boolean {
  return (url === NOTIFICATION_CREDENTIAL_URL && resourceType === "mainFrame")
    || (url === NOTIFICATION_CREDENTIAL_SCRIPT_URL && resourceType === "script")
    || (url === NOTIFICATION_CREDENTIAL_STYLE_URL && resourceType === "stylesheet");
}
