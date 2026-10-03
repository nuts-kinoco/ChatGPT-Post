import assert from "node:assert/strict";
import test from "node:test";
import { isProductAction, ProductWindowState } from "../dist/main/product-window-state.js";
function fixture() {
  const activations=[], prepared=[], preferences=[];
  let focused=false;
  const state=new ProductWindowState({prepare:async mode=>{prepared.push(mode);},activate:mode=>{activations.push(mode);},preferencesChanged:value=>{preferences.push(value);},anyFocused:()=>focused});
  return {state,activations,prepared,preferences,setFocused:value=>{focused=value;}};
}
test("starts collapsed and only explicit actions expand; settings updates do not show a window", async()=>{
  const f=fixture();assert.equal(f.state.snapshot().mode,"collapsed");
  f.state.applyPreferences({...f.state.snapshot().preferences,theme:"dark",completionNotifications:false});
  assert.deepEqual(f.activations,[]);
  await f.state.action("expand");await f.state.action("collapse");
  assert.deepEqual(f.activations,["expanded","collapsed"]);
});
test("hide/inactive and tray restore retain the previous view",async()=>{
  const f=fixture();await f.state.action("expand");
  f.state.applyPreferences({...f.state.snapshot().preferences,hideWhenInactive:true});
  f.setFocused(true);await f.state.inactive();assert.equal(f.state.snapshot().mode,"expanded");
  f.setFocused(false);await f.state.inactive();assert.equal(f.state.snapshot().mode,"hidden");
  await f.state.action("restore");assert.equal(f.state.snapshot().mode,"expanded");
  await f.state.action("minimize");assert.equal(f.state.snapshot().mode,"collapsed");
  f.state.applyPreferences({...f.state.snapshot().preferences,minimizeToTray:true});
  await f.state.action("minimize");assert.equal(f.state.snapshot().mode,"hidden");
  await f.state.action("restore");assert.equal(f.state.snapshot().mode,"collapsed");
});
test("late window preparation cannot undo a newer collapse/hide intent",async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;}),activations=[];
  const state=new ProductWindowState({prepare:async mode=>{if(mode==="expanded")await gate;},activate:mode=>activations.push(mode),preferencesChanged:()=>{},anyFocused:()=>false});
  const expanding=state.action("expand");await state.action("hide");release();await expanding;
  assert.deepEqual(activations,["hidden"]);assert.equal(state.snapshot().mode,"hidden");
});
test("settings is a separate presentation intent and actions cannot invoke task or filesystem work",async()=>{
  const f=fixture();await f.state.action("settings");assert.equal(f.state.snapshot().settingsRevision,1);
  await f.state.action("restore");assert.equal(f.state.snapshot().settingsRevision,1);
  for(const invalid of ["start","exec","delete","open-file",{},null])assert.equal(isProductAction(invalid),false);
});

test("option A expands down within the same 440px frame and clamps smaller displays", async () => {
  const { productBounds, initialProductAnchor } = await import("../dist/main/product-geometry.js");
  for (const area of [{x:0,y:0,width:1920,height:1080},{x:0,y:0,width:1280,height:720},{x:0,y:0,width:2194,height:1234}]) {
    const anchor=initialProductAnchor(area);
    const bar=productBounds(anchor,area,false), panel=productBounds(anchor,area,true);
    assert.deepEqual([bar.width,bar.height],[440,46]);
    assert.deepEqual([panel.width,panel.height],[440,604]);
    assert.equal(bar.x,panel.x);assert.equal(bar.y,panel.y);
  }
  assert.deepEqual(productBounds({x:0,y:0},{x:0,y:0,width:320,height:400},true),{x:0,y:0,width:320,height:400});
  assert.deepEqual(productBounds({x:-900,y:700},{x:-1280,y:0,width:1280,height:720},true),{x:-900,y:116,width:440,height:604});
});


test("every emitted native state has a monotonic revision distinct from settings intents",async()=>{
  const f=fixture(),seen=[];const initial=f.state.snapshot();f.state.subscribe(state=>seen.push(state));
  await f.state.action("expand");f.state.applyPreferences({...f.state.snapshot().preferences,theme:"dark"});await f.state.action("hide");await f.state.action("restore");
  assert.equal(initial.revision,0);assert.deepEqual(seen.map(state=>state.revision),[1,2,3,4]);assert.deepEqual(seen.map(state=>state.settingsRevision),[0,0,0,0]);
});
