/** Real compiled entrypoints with a synthetic deployment only. Never imports/query-runs a provider SDK. */
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp,readFile,writeFile,rm} from "node:fs/promises";
import {join,resolve} from "node:path";
const root=await mkdtemp(join(process.cwd(),".sdk-cli-lifecycle-"));
const id="00000000-0000-4000-8000-000000000001",hash="a".repeat(64);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
let count=0;
try{
 const deployment=join(root,"fake.mjs");
 await writeFile(deployment,`
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
const marker=process.env.SDK_TEST_MARKER,mode=process.env.SDK_TEST_MODE;
let state={opens:0,started:false,cancelled:false,aborted:false,settled:false,closed:false,closes:0};
const save=()=>writeFileSync(marker,JSON.stringify(state));let release;
const settle=()=>{state.settled=true;save();release?.({state:'unknown'});};
export async function openDeployment(){state.opens++;save();
 return {recipient:{get:()=>({requestSha256:'${hash}'}),start:async(_id,signal)=>{
  state.started=true;save();
  if(mode==='pending'){setTimeout(settle,300);return {state:'unknown'};}
  signal?.addEventListener('abort',()=>{state.aborted=true;save();setTimeout(settle,100);},{once:true});
  return new Promise(resolve=>release=resolve);
 },cancel:()=>{state.cancelled=true;save();setTimeout(settle,100);return {state:'unknown'};}},close:async()=>{
   state.closes++;save();if(!state.settled)throw new Error('sdk_text_drain_pending');state.closed=true;save();
 }};
}
`,{mode:0o600});
 for(const entry of ["main","sdk-text"]){
  for(const mode of ["pending","SIGTERM","SIGINT"]){
   const marker=join(root,`${entry}-${mode}.json`);
   const args=[resolve(`dist/cli/${entry}.js`),...(entry==="main"?["sdk-text"]:[]),"--deployment",deployment,"start",id,hash];
   const child=spawn(process.execPath,args,{cwd:process.cwd(),env:{...process.env,SDK_TEST_MARKER:marker,SDK_TEST_MODE:mode},stdio:["ignore","pipe","pipe"]});
   let output="",errors="";child.stdout.on("data",b=>{output+=b;});child.stderr.on("data",b=>{errors+=b;});
   const ended=new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",(code,signal)=>resolve({code,signal}));});
   const timeout=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");},8000);
   try{
    if(mode!=="pending"){
     let ready=false;for(let i=0;i<200;i++){try{ready=JSON.parse(await readFile(marker,"utf8")).started;}catch{}if(ready)break;await pause(10);}
     assert(ready,"synthetic start readiness");assert(child.kill(mode));
    }
    const result=await ended,state=JSON.parse(await readFile(marker,"utf8"));
    assert.equal(result.signal,null,`${entry}/${mode} did not retain signal handler`);assert.equal(state.opens,1,"same runtime retained");
    assert.equal(state.settled,true,"must wait for controlled settlement");assert.equal(state.closed,true,"same runtime must close after settlement");
    if(mode==="pending"){assert(state.closes>=2);assert(errors.includes("sdk_text_drain_pending"));}
    else{assert.equal(state.cancelled,true);assert.equal(state.aborted,true);}
    assert(output.includes('"state":"unknown"'));console.log(`PASS ${entry}/${mode}: same owner drained before exit`);count++;
   }finally{clearTimeout(timeout);if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");}
  }
 }
 console.log(`${count} compiled CLI lifecycle cases passed; fake deployment only`);
}finally{await rm(root,{recursive:true,force:true});}
