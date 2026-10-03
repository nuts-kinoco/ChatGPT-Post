import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createNotificationSafeStorageCipher } from "../dist/main/notification-safe-storage.js";
import {
  createNotificationCredentialController, notificationCredentialSubmission, validateNotificationCredentialView,
  NOTIFICATION_CREDENTIAL_URL, NOTIFICATION_CREDENTIAL_SCHEME, NOTIFICATION_CREDENTIAL_CHANNELS,
  NOTIFICATION_CREDENTIAL_SESSION_MS,
} from "../dist/main/notification-credential-controller.js";
import { createNotificationCredentialDialog } from "../dist/main/notification-credential-window.js";
import { notificationCredentialResource, NOTIFICATION_CREDENTIAL_SCRIPT_URL, NOTIFICATION_CREDENTIAL_STYLE_URL } from "../dist/main/notification-credential-page.js";

const view = {label: "Synthetic destination", channel: "discord", hasRecord: false, expectedTarget: null, leaseLifetimeMs: 8 * 60 * 60 * 1000};
const syntheticSecret = "https://discord.com/api/webhooks/123456/SYNTHETIC_NOT_A_TOKEN";
function cipherFixture(overrides = {}) {
  const calls = [];
  const native = {
    getSelectedStorageBackend() { calls.push("backend"); return "gnome_libsecret"; },
    isEncryptionAvailable() { calls.push("available"); return true; },
    encryptString(value) { calls.push("seal"); return Buffer.from(`opaque-fixture:${value}`); },
    decryptString(value) { calls.push("open"); return value.toString().slice("opaque-fixture:".length); },
    ...overrides.native,
  };
  const cipher = createNotificationSafeStorageCipher({platform: overrides.platform ?? "linux", isReady: () => overrides.ready ?? true,
    getSafeStorage() { calls.push("get"); return native; }});
  return {cipher, calls};
}

test("safe-storage adapter is lazy and only explicit operations use an allowlisted native backend", () => {
  const {cipher, calls} = cipherFixture();
  assert.deepEqual(calls, []);
  const encrypted = cipher.seal("SYNTHETIC_INPUT");
  assert.deepEqual(calls, ["get", "backend", "available", "seal"]);
  assert.equal(cipher.open(encrypted), "SYNTHETIC_INPUT");
  assert.deepEqual(calls.slice(4), ["get", "backend", "available", "open"]);
  for (const backend of ["kwallet", "kwallet5", "kwallet6"]) assert.ok(cipherFixture({native: {getSelectedStorageBackend: () => backend}}).cipher.seal("SYNTHETIC_INPUT"));
});

test("native denial, unsupported platform, invalid bounds and malformed outputs fail without echo", () => {
  for (const options of [{ready:false}, {platform:"win32"}, {platform:"freebsd"}]) {
    const {cipher, calls} = cipherFixture(options);
    assert.throws(() => cipher.seal("SYNTHETIC_INPUT"), /^Error: notification_native_storage_unavailable$/);
    assert.deepEqual(calls, []);
  }
  for (const backend of ["basic_text", "unknown", "unrecognized"]) {
    const {cipher, calls} = cipherFixture({native: {getSelectedStorageBackend: () => backend}});
    assert.throws(() => cipher.seal("SYNTHETIC_INPUT"));
    assert.equal(calls.includes("seal"), false);
  }
  for (const native of [
    {isEncryptionAvailable: () => false},
    {encryptString: () => { throw new Error("SYNTHETIC_INPUT"); }},
    {encryptString: () => "SYNTHETIC_INPUT"}, {encryptString: () => new Uint8Array(32769)},
    {encryptString: () => new Uint8Array(0)},
  ]) assert.throws(() => cipherFixture({native}).cipher.seal("SYNTHETIC_INPUT"), /^Error: notification_native_storage_unavailable$/);
  for (const value of ["", "x".repeat(8193), "\ud800", null]) {
    const {cipher, calls} = cipherFixture(); assert.throws(() => cipher.seal(value)); assert.deepEqual(calls, []);
  }
  for (const value of [new Uint8Array(0), new Uint8Array(32769), "bad"]) {
    const {cipher, calls} = cipherFixture(); assert.throws(() => cipher.open(value)); assert.deepEqual(calls, []);
  }
  for (const decrypted of ["", "x".repeat(8193), "\ud800", 123]) assert.throws(() => cipherFixture({native:{decryptString: () => decrypted}}).cipher.open(new Uint8Array([1])));
  const {cipher, calls} = cipherFixture({platform:"darwin", native:{getSelectedStorageBackend: () => {throw new Error("must not inspect Linux backend");}}});
  assert.ok(cipher.seal("SYNTHETIC_INPUT")); assert.equal(calls.includes("backend"), false);
});

function controllerFixture(overrides = {}) {
  const session = {}, frame = {url: NOTIFICATION_CREDENTIAL_URL}, sender = {session, mainFrame: frame};
  let now = 1000, mono = 1000, cancelled = 0, disposed = 0;
  const submissions = [];
  const controller = createNotificationCredentialController({sender, session, mainFrame: frame,
    request: {view: {...view, ...overrides.view}, submit: value => {submissions.push(value); overrides.submit?.(value);}, cancel: () => {cancelled++; overrides.cancel?.();}},
    wallNow: () => now, monotonicNow: () => mono, dispose: () => {disposed++;},
  });
  return {controller, event: {sender, senderFrame:frame}, frame, session, submissions,
    setNow: value => {now = value;}, setMono: value => {mono = value;},
    get cancelled() {return cancelled;}, get disposed() {return disposed;}};
}

test("credential controller binds exact sender, dedicated session, main frame, URL and no extra arguments", () => {
  const fixture = controllerFixture(), {controller, event} = fixture;
  assert.deepEqual(controller.view(event, []), view);
  const events = [
    {...event, sender: {...event.sender}}, {...event, senderFrame: {...event.senderFrame}}, {...event, senderFrame:null},
  ];
  for (const bad of events) { assert.equal(controller.view(bad, []), null); assert.equal(controller.submit(bad, [{mode:"register", secret:syntheticSecret, consent:true}]), false); }
  assert.equal(controller.view(event, ["extra"]), null);
  fixture.frame.url = NOTIFICATION_CREDENTIAL_URL + "?query=1"; assert.equal(controller.view(event, []), null);
  fixture.frame.url = NOTIFICATION_CREDENTIAL_URL;
  event.sender.session = {}; assert.equal(controller.view(event, []), null);
  event.sender.session = fixture.session; event.sender.mainFrame = {}; assert.equal(controller.view(event, []), null);
  controller.close(); assert.equal(fixture.disposed, 1); assert.equal(fixture.cancelled, 0);
});

test("strict submit schemas, one-shot entry, callback errors and modes never echo input", () => {
  const invalid = [null, [], {mode:"register",secret:syntheticSecret}, {mode:"register",secret:syntheticSecret,consent:false},
    {mode:"register",secret:syntheticSecret,consent:true,actionId:"attacker"}, {mode:"register",secret:"x".repeat(8193),consent:true},
    {mode:"register",secret:"line\nbreak",consent:true}, {mode:"unlock"}, {mode:"replace",secret:syntheticSecret}];
  for (const value of invalid) assert.equal(notificationCredentialSubmission(value, false), null);
  for (const value of [{mode:"unlock",secret:syntheticSecret}, {mode:"unlock",consent:true}, {mode:"register",secret:syntheticSecret,consent:true}]) assert.equal(notificationCredentialSubmission(value, true), null);
  const fixture = controllerFixture(), value = {mode:"register",secret:syntheticSecret,consent:true};
  assert.equal(fixture.controller.submit(fixture.event,[value, "extra"]),false);
  assert.equal(fixture.controller.submit(fixture.event,[value]),true);
  assert.equal(fixture.controller.submit(fixture.event,[value]),false);
  assert.equal(fixture.controller.view(fixture.event,[]),null);
  assert.equal(fixture.submissions.length,1); assert.equal(fixture.disposed,1);
  for (const mode of ["unlock", "replace"]) {
    const f = controllerFixture({view:{hasRecord:true,expectedTarget:"123456"}});
    assert.equal(f.controller.submit(f.event, [mode === "unlock" ? {mode} : {mode, secret:syntheticSecret}]), true);
  }
  const throwing = controllerFixture({submit: () => {throw new Error(syntheticSecret);}, cancel: () => {throw new Error(syntheticSecret);}});
  assert.equal(throwing.controller.submit(throwing.event,[value]),false);
  assert.equal(throwing.cancelled,1); assert.equal(throwing.disposed,1);
});

test("expiry, clock regression, cancellation and unexpected navigation revoke callbacks once", () => {
  for (const axis of ["setNow", "setMono"]) {
    const f = controllerFixture(); f[axis](1000 + NOTIFICATION_CREDENTIAL_SESSION_MS);
    assert.equal(f.controller.view(f.event, []), null); assert.equal(f.cancelled,1); assert.equal(f.disposed,1);
    f.controller.cancel(); f.controller.close(); assert.equal(f.cancelled,1);
    const regressed = controllerFixture(); regressed[axis](999); assert.equal(regressed.controller.active(),false); assert.equal(regressed.cancelled,1);
  }
  const f = controllerFixture(); f.setNow(17_000); f.setMono(17_000);
  assert.deepEqual(f.controller.view(f.event,[]),view); // Human wait exceeds HTTP/transport timeouts.
  assert.equal(f.controller.cancelFrom(f.event,[]),true);
  assert.equal(f.controller.submit(f.event,[{mode:"register",secret:syntheticSecret,consent:true}]),false);
  const navigation = controllerFixture(); navigation.controller.didNavigate(NOTIFICATION_CREDENTIAL_URL,navigation.frame);
  navigation.controller.didNavigate(NOTIFICATION_CREDENTIAL_URL,navigation.frame); assert.equal(navigation.cancelled,1);
  const wrong = controllerFixture(); wrong.controller.didNavigate("https://example.invalid",wrong.frame); assert.equal(wrong.cancelled,1);
});

test("safe view excludes secrets, validates lifetimes and resources require exact URL, method and session", async () => {
  assert.equal(validateNotificationCredentialView(view),true);
  for (const changed of [{secret:syntheticSecret},{leaseLifetimeMs:59_999},{leaseLifetimeMs:86_400_001},{label:"unsafe\ntext"}]) assert.equal(validateNotificationCredentialView({...view,...changed}),false);
  const session = {};
  for (const url of [NOTIFICATION_CREDENTIAL_URL,NOTIFICATION_CREDENTIAL_SCRIPT_URL,NOTIFICATION_CREDENTIAL_STYLE_URL]) {
    const response=notificationCredentialResource({url,method:"GET"},session,session); assert.equal(response.status,200);
    assert.match(response.headers.get("content-security-policy"), /connect-src 'none'/);
    assert.equal(response.headers.get("cache-control"),"no-store");
    assert.equal(notificationCredentialResource({url,method:"POST"},session,session).status,404);
    assert.equal(notificationCredentialResource({url,method:"GET"},{},session).status,404);
  }
  for (const url of [NOTIFICATION_CREDENTIAL_URL+"?a=b",NOTIFICATION_CREDENTIAL_URL+"#a",NOTIFICATION_CREDENTIAL_URL.replace("dialog","user@dialog"),NOTIFICATION_CREDENTIAL_URL.replace("dialog","dialog:42"),NOTIFICATION_CREDENTIAL_URL.replace("index.html","../index.html"),"file:///index.html","https://example.invalid/index.html"])
    assert.equal(notificationCredentialResource({url,method:"GET"},session,session).status,404);
  const html=await notificationCredentialResource({url:NOTIFICATION_CREDENTIAL_URL,method:"GET"},session,session).text();
  assert.match(html,/type="password"/); assert.match(html,/Linuxではデスクトップやキーリングのロックを自動検知できない/); assert.match(html,/OSの確認画面が表示されている間、アプリが応答しなくなる場合/);
  assert.match(html,/lang="ja"/); assert.match(html,/<h1>通知用の認証情報<\/h1>/);
  assert.match(html,/自動通知はONにならず、テスト送信も行いません/); assert.match(html,/テスト用の定型文だけを送信することに同意します/); assert.match(html,/未処理のクリックでOSの確認画面を中断することはできません/);
  assert.doesNotMatch(html,/checked[=> ]|SYNTHETIC_NOT_A_TOKEN/);
  const script=await notificationCredentialResource({url:NOTIFICATION_CREDENTIAL_SCRIPT_URL,method:"GET"},session,session).text();
  new vm.Script(script); assert.match(script,/textContent/); assert.doesNotMatch(script,/innerHTML|fetch\(|XMLHttpRequest|localStorage|sessionStorage/);
});

function windowFixture() {
  const windows=[], handlers=new Map(), protocolHandlers=new Map();
  let options, cancelled=0; const submissions=[];
  const ipcMain={handle(channel,handler){assert.equal(handlers.has(channel),false);handlers.set(channel,handler);},removeHandler(channel){handlers.delete(channel);}};
  function createWindow(value) {
    options=value;
    const window=new EventEmitter(), session=new EventEmitter(), contents=new EventEmitter();
    session.protocol={handle(scheme,handler){protocolHandlers.set(session,handler);},unhandle(){protocolHandlers.delete(session);}};
    session.setPermissionRequestHandler=handler=>{session.permission=handler;};session.setPermissionCheckHandler=handler=>{session.permissionCheck=handler;};
    session.webRequest={onBeforeRequest:handler=>{session.request=handler;}};
    contents.session=session;contents.id=windows.length+1;contents.mainFrame={url:"about:blank"};
    contents.setWindowOpenHandler=handler=>{contents.popup=handler;};
    window.webContents=contents;window.destroyed=false;window.isDestroyed=()=>window.destroyed;
    window.destroy=()=>{if(window.destroyed)return;window.destroyed=true;contents.emit("destroyed");window.emit("closed");};
    window.show=()=>{window.shown=true;};
    window.loadURL=async url=>{window.url=url;contents.mainFrame={url};contents.emit("did-navigate",{},url);};
    windows.push(window);return window;
  }
  const dialog=createNotificationCredentialDialog({createWindow,ipcMain,preloadPath:"/compiled/notification-credential-preload.cjs"});
  const request={view,submit:value=>submissions.push(value),cancel:()=>{cancelled++;}};
  return {dialog,request,windows,handlers,protocolHandlers,submissions,get options(){return options;},get cancelled(){return cancelled;}};
}

test("window installs protocol on its actual ephemeral session and denies requests, permissions, popups, frames", async () => {
  const f=windowFixture();assert.equal(f.windows.length,0);const handle=f.dialog.open(f.request);
  await Promise.resolve();const window=f.windows[0], contents=window.webContents, session=contents.session;
  assert.equal(f.options.title,"通知用の認証情報");assert.equal(window.url,NOTIFICATION_CREDENTIAL_URL);assert.equal(window.shown,true);
  assert.equal(f.protocolHandlers.size,1);assert.ok(f.protocolHandlers.get(session));
  assert.match(f.options.webPreferences.partition,/^bridge-notification-credential-/);assert.doesNotMatch(f.options.webPreferences.partition,/persist:/);
  assert.deepEqual(Object.fromEntries(["contextIsolation","sandbox","webSecurity","nodeIntegration","nodeIntegrationInWorker","devTools","spellcheck","webviewTag"].map(key=>[key,f.options.webPreferences[key]])),{contextIsolation:true,sandbox:true,webSecurity:true,nodeIntegration:false,nodeIntegrationInWorker:false,devTools:false,spellcheck:false,webviewTag:false});
  let permission;session.permission(contents,"clipboard-read",value=>{permission=value;});assert.equal(permission,false);assert.equal(session.permissionCheck(),false);assert.deepEqual(contents.popup(),{action:"deny"});
  const req={method:"GET",url:NOTIFICATION_CREDENTIAL_URL,resourceType:"mainFrame",webContentsId:contents.id};
  for (const change of [{},{method:"POST"},{url:"https://example.invalid"},{resourceType:"subFrame"},{webContentsId:12345}]) {
    let response;session.request({...req,...change},value=>{response=value;});assert.equal(response.cancel,Object.keys(change).length>0);
  }
  const event={sender:contents,senderFrame:contents.mainFrame};
  assert.deepEqual(f.handlers.get(NOTIFICATION_CREDENTIAL_CHANNELS.view)(event),view);
  assert.throws(()=>f.dialog.open(f.request),/notification_credential_window_unavailable/);
  assert.equal(f.handlers.get(NOTIFICATION_CREDENTIAL_CHANNELS.submit)(event,{mode:"register",secret:syntheticSecret,consent:true}),true);
  assert.equal(f.submissions.length,1);assert.equal(f.handlers.size,0);assert.equal(f.protocolHandlers.size,0);assert.equal(window.destroyed,true);assert.equal(f.cancelled,0);
  handle.close();assert.equal(f.cancelled,0);
  const second=f.dialog.open(f.request);assert.notEqual(f.options.webPreferences.partition,undefined);assert.equal(f.windows.length,2);second.close();
});

test("window closes and cancels exactly once on renderer crash, navigation, download and Cancel", () => {
  for (const name of ["will-navigate","will-frame-navigate","will-redirect","will-attach-webview","did-navigate-in-page","render-process-gone","did-fail-load","download","close","cancel"]) {
    const f=windowFixture();const handle=f.dialog.open(f.request), window=f.windows[0], contents=window.webContents;
    let prevented=false;const event={preventDefault(){prevented=true;}};
    if(name==="download")contents.session.emit("will-download",event);
    else if(name==="close")window.emit("close",event);
    else if(name==="cancel")f.handlers.get(NOTIFICATION_CREDENTIAL_CHANNELS.cancel)({sender:contents,senderFrame:contents.mainFrame});
    else contents.emit(name,event);
    assert.equal(f.cancelled,1,name);assert.equal(window.destroyed,true,name);assert.equal(f.handlers.size,0,name);
    if(name.startsWith("will-")||name==="download")assert.equal(prevented,true,name);
    handle.close();assert.equal(f.cancelled,1,name);
  }
});

test("main adds one pre-ready scheme, lazy selected-root factory, native-only tray capability and lifecycle fences", async () => {
  const source=await readFile(new URL("../src/main/main.ts",import.meta.url),"utf8");
  assert.equal(source.match(/registerSchemesAsPrivileged\(/g).length,1);
  assert.ok(source.indexOf("scheme: NOTIFICATION_CREDENTIAL_SCHEME")<source.indexOf("app.whenReady()"));
  assert.match(source,/notificationProviderFactory: ProductNotificationProviderFactory = async input/);
  assert.match(source,/notification-secret-provider\.js/);
  assert.match(source,/getSafeStorage: \(\) => safeStorage/);
  assert.match(source,/startProductUi\(root, process.env, undefined, notificationProviderFactory\)/);
  for(const event of ["suspend","lock-screen","user-did-resign-active"])assert.ok(source.includes(`powerMonitor.on("${event}", lockNotificationCredentials)`));
  assert.doesNotMatch(source,/powerMonitor.on\("(?:resume|unlock-screen|user-did-become-active)"/);
  assert.match(source,/通知用の認証情報をロック", enabled: typeof productServer\?\.lockNotificationCredentials === "function"/);
  assert.match(source,/try \{ await server\?\.lockNotificationCredentials\?\.\(\); \} finally \{ await server\?\.close\(\); \}/);
  const preload=await readFile(new URL("../src/main/notification-credential-preload.cts",import.meta.url),"utf8");
  assert.equal(preload.match(/ipcRenderer.invoke\(/g).length,3);
  assert.doesNotMatch(preload,/sendSync|safeStorage|clipboard\.|shell\./);
});

async function pageFixture(metadata = view) {
  const session={}, script=await notificationCredentialResource({url:NOTIFICATION_CREDENTIAL_SCRIPT_URL,method:"GET"},session,session).text();
  const elements=new Map(), calls=[];
  function element(id) {
    if(!elements.has(id))elements.set(id,{textContent:"",value:"",checked:false,disabled:id==="submit",hidden:false,listeners:new Map(),addEventListener(name,callback){this.listeners.set(name,callback);}});
    return elements.get(id);
  }
  const window={listeners:new Map(),addEventListener(name,callback){this.listeners.set(name,callback);},bridgeNotificationCredential:{
    view:async()=>({...metadata}),submit:async value=>{calls.push(JSON.parse(JSON.stringify(value)));return true;},cancel:async()=>{calls.push("cancel");},
  }};
  vm.runInNewContext(script,{window,document:{getElementById:element}});
  await Promise.resolve();
  return {element,window,calls,async input(value){element("secret").value=value;element("secret").listeners.get("input")();},
    async click(id){element(id).listeners.get("click")();await Promise.resolve();}};
}

test("packaged page shows only target ID, requires fresh consent, displays lifetime and clears entry before one-shot submission", async () => {
  const f=await pageFixture();
  assert.equal(f.element("consent").checked,false);assert.equal(f.element("submit").disabled,true);
  assert.match(f.element("lifetime").textContent,/480分（固定・自動延長なし）/);
  await f.input(syntheticSecret);
  assert.equal(f.element("target").textContent,"送信先：123456");assert.equal(f.element("submit").disabled,true);
  assert.equal([...Object.values(Object.fromEntries(["label","lifetime","expected","target","secret-label","status"].map(id=>[id,f.element(id).textContent])))].some(text=>text.includes("SYNTHETIC_NOT_A_TOKEN")),false);
  f.element("consent").checked=true;f.element("consent").listeners.get("change")();assert.equal(f.element("submit").disabled,false);
  await f.input(syntheticSecret.replace("123456","999"));assert.equal(f.element("consent").checked,false);assert.equal(f.element("submit").disabled,true);
  f.element("consent").checked=true;f.element("consent").listeners.get("change")();
  await f.click("submit");assert.equal(f.element("secret").value,"");assert.equal(f.element("consent").checked,false);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].mode,"register");assert.equal(f.calls[0].consent,true);
  await f.click("submit");assert.equal(f.calls.length,1);
});

test("existing-secret page never reads a secret, separates Unlock from Replace and clears on Cancel/pagehide", async () => {
  const existing={...view,hasRecord:true,expectedTarget:"123456",leaseLifetimeMs:60_000};
  const unlock=await pageFixture(existing);
  assert.equal(unlock.element("secret").value,"");assert.equal(unlock.element("unlock").hidden,false);assert.equal(unlock.element("consent-row").hidden,true);
  assert.match(unlock.element("expected").textContent,/123456/);
  await unlock.click("unlock");assert.deepEqual(unlock.calls,[{mode:"unlock"}]);
  const replace=await pageFixture(existing);await replace.input(syntheticSecret);assert.equal(replace.element("submit").disabled,false);
  await replace.click("submit");assert.deepEqual(replace.calls,[{mode:"replace",secret:syntheticSecret}]);
  const cancel=await pageFixture();await cancel.input(syntheticSecret);await cancel.click("cancel");assert.equal(cancel.element("secret").value,"");assert.deepEqual(cancel.calls,["cancel"]);
  const hide=await pageFixture();await hide.input(syntheticSecret);hide.window.listeners.get("pagehide")();assert.equal(hide.element("secret").value,"");assert.deepEqual(hide.calls,[]);
});

test("dedicated preload exposes only three methods and submits at most once with injected IPC", async () => {
  const source=await readFile(new URL("../dist/main/notification-credential-preload.cjs",import.meta.url),"utf8");
  let api;const calls=[];
  vm.runInNewContext(source,{exports:{},require(name){assert.equal(name,"electron");return {contextBridge:{exposeInMainWorld(name,value){assert.equal(name,"bridgeNotificationCredential");api=value;}},ipcRenderer:{invoke(...args){calls.push(args);return Promise.resolve(true);}}};}});
  assert.deepEqual(Object.keys(api).sort(),["cancel","submit","view"]);
  await api.view();await api.submit({mode:"unlock"});assert.equal(await api.submit({mode:"unlock"}),false);await api.cancel();
  assert.deepEqual(calls.map(call=>call[0]),[NOTIFICATION_CREDENTIAL_CHANNELS.view,NOTIFICATION_CREDENTIAL_CHANNELS.submit,NOTIFICATION_CREDENTIAL_CHANNELS.cancel]);
});

test("observed close during a synchronous fake submit prevents any renderer revival", () => {
  let fixture;
  fixture=controllerFixture({submit(){fixture.controller.close();}});
  assert.equal(fixture.controller.submit(fixture.event,[{mode:"register",secret:syntheticSecret,consent:true}]),true);
  assert.equal(fixture.disposed,1);assert.equal(fixture.controller.active(),false);assert.equal(fixture.controller.view(fixture.event,[]),null);
});

test("host exceptions with secret-shaped or throwing accessors are never inspected or echoed", async () => {
  let inspections=0;
  const poisonedError={get message(){inspections++;throw new Error(syntheticSecret);},get code(){inspections++;throw new Error(syntheticSecret);},get stack(){inspections++;throw new Error(syntheticSecret);},toString(){inspections++;return syntheticSecret;}};
  for(const native of [
    {isEncryptionAvailable(){throw poisonedError;}},
    {encryptString(){throw poisonedError;}},
    {decryptString(){throw poisonedError;}},
  ]) {
    const {cipher}=cipherFixture({native});
    const operation="decryptString" in native?()=>cipher.open(new Uint8Array([1])):()=>cipher.seal("SYNTHETIC_INPUT");
    assert.throws(operation,/^Error: notification_native_storage_unavailable$/);
  }
  const lazy=createNotificationSafeStorageCipher({platform:"linux",isReady:()=>true,getSafeStorage(){throw poisonedError;}});
  assert.throws(()=>lazy.seal("SYNTHETIC_INPUT"),/^Error: notification_native_storage_unavailable$/);
  const poisonedSubmission={mode:"register",consent:true,get secret(){throw poisonedError;}};
  assert.equal(notificationCredentialSubmission(poisonedSubmission,false),null);
  assert.equal(validateNotificationCredentialView({...view,get label(){throw poisonedError;}}),false);
  const poisonedDialog=createNotificationCredentialDialog({preloadPath:"/compiled/preload.cjs",ipcMain:{handle(){},removeHandler(){}},createWindow(){throw poisonedError;}});
  assert.throws(()=>poisonedDialog.open({view,submit(){},cancel(){}}),/^Error: notification_credential_window_unavailable$/);
  let destroyed=0;
  const partial=createNotificationCredentialDialog({preloadPath:"/compiled/preload.cjs",ipcMain:{handle(){},removeHandler(){}},createWindow(){return {get webContents(){throw poisonedError;},isDestroyed:()=>false,destroy(){destroyed++;}};}});
  assert.throws(()=>partial.open({view,submit(){},cancel(){}}),/^Error: notification_credential_window_unavailable$/);
  assert.equal(destroyed,1);assert.equal(inspections,0);
});

test("configured Email view accepts opaque bounded input without inferring a Discord URL or sender", async () => {
  const f=await pageFixture({...view,channel:"email",expectedTarget:"synthetic-prebound-recipient"});
  await f.input("SYNTHETIC_OPAQUE_SENDER_INPUT");
  assert.equal(f.element("target").textContent,"送信先：synthetic-prebound-recipient");
  assert.equal(f.element("submit").disabled,true);
  f.element("consent").checked=true;f.element("consent").listeners.get("change")();
  await f.click("submit");assert.deepEqual(f.calls,[{mode:"register",secret:"SYNTHETIC_OPAQUE_SENDER_INPUT",consent:true}]);
});
