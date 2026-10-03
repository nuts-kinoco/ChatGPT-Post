/** Reviewed composition example. Import alone has no side effects. Run only after explicit operator approval.
 * This file never stores private signing keys, reads tokens, logs in, or retries an SDK query. */
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { cloneClaudeSdkHostProfile, probeClaudeSdkHost } from '../dist/adapters/claude-sdk-profile.js';
import { sdkProfileDigest } from '../dist/adapters/claude-sdk-text.js';
import { GitHubConnectorStore } from '../dist/adapters/github-connector-store.js';
import { StdioGitHubConnectorHost } from '../dist/adapters/github-connector-stdio.js';
import { GitHubTaskBus, SignedBusCodec } from '../dist/adapters/github-transport.js';
import { GitHubSdkTextBus } from '../dist/adapters/sdk-text-bus.js';
import { createSdkTextDeployment, generateSdkTextRequest } from '../dist/adapters/sdk-text-deployment.js';
import { publishImmutableFiles, rootIdentity, syncDirectory } from '../dist/archive/durable.js';
import { checkedDirectory, readOwnedFile, writeNewFile } from '../dist/archive/paths.js';
import { parseProjectRegistry } from '../dist/contracts/project-registry.js';
import { parseStrictJsonBytes, sha256Bytes } from '../dist/contracts/task.js';
import { ProjectRegistry } from '../dist/state/project-registry.js';

export async function openDeployment(startup = undefined) {
  if (startup?.signal.aborted) throw new Error('sdk_text_stopping');
  if (process.env.BRIDGE_SDK_TRIAL_APPROVAL !== 'one-haiku-query-and-two-ephemeral-signing-keys')
    throw new Error('sdk_text_trial_approval_required');
  const configPath = process.env.BRIDGE_SDK_TRIAL_CONFIG;
  if (!configPath || !isAbsolute(configPath)) throw new Error('sdk_text_trial_config_required');
  const rawConfig = readOwnedFile(configPath, 32768);
  const config = parseStrictJsonBytes(rawConfig);
  if (!config || Array.isArray(config) || Object.keys(config).sort().join(',') !==
      'privateRoot,profile,registry,requesterId,schema' || config.schema !== 'sdk-text-one-shot-configuration-1' ||
      typeof config.requesterId !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(config.requesterId))
    throw new Error('sdk_text_trial_config_invalid');
  const profile = cloneClaudeSdkHostProfile(config.profile);
  const snapshot = parseProjectRegistry(Buffer.from(JSON.stringify(config.registry)));
  if (snapshot.revision !== 1 || snapshot.projects.length !== 1 || !snapshot.defaultOutputRoot ||
      !snapshot.projects[0].githubDestination || config.requesterId === profile.recipientId)
    throw new Error('sdk_text_trial_config_invalid');
  const project = snapshot.projects[0], destination = project.githubDestination;
  const root = config.privateRoot;
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root)
    throw new Error('sdk_text_trial_config_invalid');
  checkedDirectory(root, {}, true);
  checkedDirectory(snapshot.defaultOutputRoot, {}, true);
  if (project.outputRootOverride) throw new Error('sdk_text_trial_config_invalid');
  const input = join(root, 'trial-input');
  const args = process.argv.slice(2);
  if (args[0] === 'sdk-text') args.shift();
  if (args.length !== 5 || args[0] !== '--deployment' || args[2] !== 'trial' ||
      resolve(args[3]) !== join(input, 'request.json') || resolve(args[4]) !== join(input, 'task.md'))
    throw new Error('sdk_text_trial_command_required');
  // A prior key intent is never silently regenerated, including after crash before query or delivery.
  const intentPath = join(root, 'trial-key-intent.json');
  if (existsSync(intentPath) || existsSync(input) || existsSync(join(root, 'registry.db')))
    throw new Error('sdk_text_trial_already_admitted');
  // The exact approved existing account context must succeed before any test keys or Git writes exist.
  // The CLI may still be opening this module when it receives a stop signal.
  // Observe that same startup window before any first key or storage effect.
  let startupStopped = false;
  const stopStartup = () => { startupStopped = true; };
  process.on('SIGINT', stopStartup);
  process.on('SIGTERM', stopStartup);
  try {
    await probeClaudeSdkHost(profile);
    if (startupStopped || startup?.signal.aborted) throw new Error('sdk_text_stopping');
  } finally {
    process.off('SIGINT', stopStartup);
    process.off('SIGTERM', stopStartup);
  }
  const rootPin = rootIdentity(root);
  writeNewFile(intentPath, Buffer.from(JSON.stringify({schema:'sdk-text-key-intent-1',
    configSha256:sha256Bytes(rawConfig), trialId:randomUUID(), keys:2, persistentPrivateKeys:false})));
  syncDirectory(root);
  const keys = { requester:generateKeyPairSync('ed25519'), recipient:generateKeyPairSync('ed25519') };
  const identities = [
    {actorId:config.requesterId,roles:['requester'],publicKeyPem:keys.requester.publicKey.export({type:'spki',format:'pem'}).toString()},
    {actorId:profile.recipientId,roles:['recipient'],publicKeyPem:keys.recipient.publicKey.export({type:'spki',format:'pem'}).toString()},
  ];
  const registry = new ProjectRegistry(join(root, 'registry.db'));
  const host = new StdioGitHubConnectorHost(process.stdin, process.stdout);
  let runtime;
  try {
    registry.configure(snapshot, 0);
    const [owner, repository] = destination.repositoryFullName.split('/');
    const git = new GitHubConnectorStore({owner,repository,branch:destination.branch,namespace:destination.namespace},host);
    const makeBus = (role, actorId) => new GitHubSdkTextBus(new GitHubTaskBus(git,
      new SignedBusCodec(identities,{actorId,sign:async bytes=>sign(null,bytes,keys[role].privateKey)}),
      destination.namespace,{},registry));
    const requesterBus = makeBus('requester',config.requesterId), recipientBus = makeBus('recipient',profile.recipientId);
    const generated = generateSdkTextRequest(requesterBus,profile,project.repoId);
    const expected = {requestId:generated.request.requestId,requestSha256:generated.requestSha256,
      profileSha256:sdkProfileDigest(profile),approverId:profile.approverId};
    const authority = {approve:async value=>{
      if (Object.entries(expected).some(([key,v])=>value[key]!==v) || value.maxStarts!==1 ||
          Date.parse(value.expiresAt)<=Date.now() || Date.parse(value.expiresAt)>Date.parse(generated.request.expiresAt))
        throw new Error('sdk_text_trial_authority_denied');
      return {requestId:expected.requestId,requestSha256:expected.requestSha256,
        approverId:expected.approverId,expiresAt:value.expiresAt};
    }};
    publishImmutableFiles(root,'trial-input',[
      {relativePath:'request.json',bytes:Buffer.from(generated.rawRequest)},
      {relativePath:'task.md',bytes:Buffer.from(generated.markdown)},
      {relativePath:'public-identities.json',bytes:Buffer.from(JSON.stringify(identities))},
    ],rootPin);
    runtime = await createSdkTextDeployment({requesterBus,recipientBus,profile:()=>profile,privateRoot:root,authority});
    const close = runtime.close.bind(runtime);
    let closed=false;
    return {...runtime,close:async()=>{
      if(closed)return;
      await close(); // On pending drain retain the same registry, signer closures and relay.
      host.close();registry.close();closed=true;
    }};
  } catch(error) {
    if(runtime) await runtime.close();
    host.close();registry.close();
    throw error;
  }
}
