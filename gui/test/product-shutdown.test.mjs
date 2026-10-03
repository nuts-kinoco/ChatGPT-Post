import assert from "node:assert/strict";
import test from "node:test";
import { createProductShutdown } from "../dist/main/product-shutdown.js";
const settle = async () => { for (let i=0;i<5;i++) await new Promise(resolve => setImmediate(resolve)); };
test("quit waits for one drain before allowing native exit", async () => {
  let release, closed=0, ready=0, failed=0, prevented=0;
  const future = new Promise(resolve => { release=resolve; });
  const state=createProductShutdown({ close: async()=>{closed++;await future;}, ready:()=>{ready++;}, failed:()=>{failed++;} });
  const event={preventDefault(){prevented++;}};
  state.beforeQuit(event);state.beforeQuit(event);await settle();
  assert.equal(closed,1);assert.equal(ready,0);assert.equal(prevented,2);
  release();await settle();assert.equal(ready,1);assert.equal(failed,0);
  state.beforeQuit(event);assert.equal(prevented,2);assert.equal(closed,1);
});
test("failed drain retains the app and a later explicit quit can retry", async () => {
  let calls=0,ready=0,failed=0;
  const state=createProductShutdown({close:async()=>{calls++;if(calls===1)throw new Error("private token URL");},ready:()=>{ready++;},failed:()=>{failed++;}});
  const event={preventDefault(){}};
  state.beforeQuit(event);await settle();assert.equal(failed,1);assert.equal(ready,0);
  state.beforeQuit(event);await settle();assert.equal(calls,2);assert.equal(ready,1);
});
