/** Compiled bus entrypoint smoke; local inert ports only, no signer/provider/network. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {describeChild,readMarker,waitForChild} from './child-diagnostics.mjs';
const root=await mkdtemp(join(process.cwd(),'.issuer-cli-'));
const id='00000000-0000-4000-8000-000000000001';
let count=0;
try {
  const module=join(root,'inert.mjs');
  await writeFile(module,`
import {writeFileSync} from 'node:fs';
const state={opened:0,closed:0,calls:[]};
const save=()=>writeFileSync(process.env.ISSUER_TEST_MARKER,JSON.stringify(state));
export async function openDeployment(){state.opened++;save();if(process.env.ISSUER_TEST_MODE==='open-error')throw new Error('credential_example_value');const invoke=(method,...args)=>{state.calls.push({method,args});save();return {method,reexecute:false};};return {bus:{},issuer:process.env.ISSUER_TEST_UNCONFIGURED?undefined:{catalogue:()=>invoke('catalogue'),template:(...args)=>invoke('template',...args),prepare:(...args)=>invoke('prepare',...args),issue:raw=>invoke('issue',Buffer.from(raw).toString('base64')),result:(raw,id)=>invoke('result',Buffer.from(raw).toString('base64'),id),acknowledge:(raw,id,hash)=>invoke('acknowledge',Buffer.from(raw).toString('base64'),id,hash)},close:()=>{state.closed++;save();if(process.env.ISSUER_TEST_MODE==='close-error')throw new Error('credential_example_value');}};}
`,{mode:0o600});
  const signedPreparationBase64=Buffer.from('opaque-fixture').toString('base64');
  const cases=[
    ['issuer-catalogue',undefined,'catalogue'],
    ['issuer-template',{projectId:id,destinationId:'destination-a'},'template'],
    ['issuer-prepare',{identities:{fixture:true},request:{}},'prepare'],
    ['issuer-issue',{signedPreparationBase64},'issue'],
    ['issuer-result',{signedPreparationBase64,requestId:id},'result'],
    ['issuer-ack',{signedPreparationBase64,requestId:id,payloadSha256:'a'.repeat(64)},'acknowledge'],
    ['issuer-issue',{signedPreparationBase64,deployment:'/untrusted.mjs'},null],
    ['issuer-template','invalid JSON',null],
    ['issuer-catalogue',undefined,null,'unconfigured'],
    ['issuer-catalogue',undefined,null,'extra-arg'],
    ['issuer-catalogue',undefined,'catalogue','close-error'],
    ['issuer-catalogue',undefined,null,'open-error'],
  ];
  for (const [command,input,method,mode] of cases) {
    const marker=join(root,`case-${count}.json`),args=[resolve('dist/cli/bus.js'),'--deployment',module,command,...(mode==='extra-arg'?['/not-allowed']:[])];
    const child=spawn(process.execPath,args,{cwd:process.cwd(),env:{...process.env,ISSUER_TEST_MARKER:marker,ISSUER_TEST_MODE:mode??'',...(mode==='unconfigured'?{ISSUER_TEST_UNCONFIGURED:'1'}:{})},stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',b=>{stdout+=b;});child.stderr.on('data',b=>{stderr+=b;});
    const waiting=waitForChild(child);
    child.stdin.on('error',()=>{});child.stdin.end(input===undefined?'':typeof input==='string'?input:JSON.stringify(input));
    const result=await waiting.result,timedOut=result.timedOut;
    // Read the marker only after the child has ended; report the first cause before any assertion hides it.
    const markerRead=await readMarker(marker),expectedCode=method&&mode!=='close-error'?0:1;
    if(result.spawnError||timedOut||result.signal!==null||result.code!==expectedCode||markerRead.state!=='ok')throw new Error(describeChild({label:`${command}/${mode??method??'invalid-input'}`,spawnError:result.spawnError,code:result.code,signal:result.signal,timedOut,marker:markerRead,stderr}));
    assert.equal(result.signal,null);assert.equal(result.code,expectedCode);
    const state=markerRead.value;
    assert.equal(state.opened,1);assert.equal(state.closed,mode==='open-error'?0:1);assert.equal(state.calls.length,method?1:0);
    if(method&&mode!=='close-error'){assert.equal(state.calls[0].method,method);assert.equal(JSON.parse(stdout).method,method);}
    else {assert.equal(JSON.parse(stderr).reexecute,false);assert(!stderr.includes('/untrusted.mjs'));assert(!stderr.includes('credential_example_value'));}
    console.log(`PASS ${command}/${mode??method??'invalid-input'}`);count++;
  }
  console.log(`${count} compiled issuer CLI cases passed; inert ports only`);
} finally {await rm(root,{recursive:true,force:true});}
