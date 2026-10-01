import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { openDatabase, migrate } from '../server/db.js';
import { createApp } from '../server/app.js';
import { digest } from '../server/library.js';
import type { Config } from '../server/config.js';

const password = () => randomBytes(24).toString('base64url');
async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try { await run(f); } finally { await f.close(); }
}
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'drop-it-public-'));
  const db = await openDatabase({ dataDir: dir });
  await migrate(db);
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as {port: number}).port;
  const origin = `http://127.0.0.1:${port}`;
  const config: Config = {port, origin, local: true, production: false, redirectUris: [], dataDir: dir, databaseUrl: undefined, ai: undefined, publicAccounts: true, signupEnabled: true};
  const built = createApp(db, config, '<!doctype html><title>Synthetic account tests</title>');
  server.on('request', built.app);
  const request = (path: string, body?: unknown, cookie = '', overrideOrigin = origin) => fetch(origin+path, {
    method: body === undefined ? 'GET' : 'POST', headers: {Origin: overrideOrigin, Cookie: cookie, 'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {...built, db, config, request, close: async () => {
    server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); await db.close(); await rm(dir, {recursive:true, force:true});
  }};
}
test('public registration normalizes usernames, rejects extra fields, and preserves the legacy owner', () => fixture(async f => {
  const oldPassword = password();
  const oldSession = await f.auth.setup(oldPassword);
  const oldOwner = (await f.auth.sessionOwner(oldSession))!;
  const saved = await f.library.save(oldOwner, {requestId:randomUUID(), title:'Existing library', source:{originalText:'Original owner data'}});
  const newPassword = password();
  const created = await f.request('/api/register', {username:'  Alice_Test  ', password:newPassword});
  assert.equal(created.status,200);
  const cookie = created.headers.get('set-cookie')!.split(';')[0];
  assert.match(created.headers.get('set-cookie')!, /HttpOnly/);
  const owner = (await f.auth.sessionOwner(cookie.split('=')[1]))!;
  assert.notEqual(owner, oldOwner);
  assert.equal((await f.request('/api/login',{username:'ALICE_TEST', password:newPassword})).status,200);
  assert.equal((await f.request('/api/login',{username:'owner',password:oldPassword})).status,200);
  assert.equal((await f.library.get(oldOwner,saved.item.id)).item.title,'Existing library');
  assert.equal((await f.request('/api/register',{username:'alice_test', password:password()})).status,409);
  assert.equal((await f.request('/api/register',{username:'owner',password:password()})).status,409);
  assert.equal((await f.request('/api/register',{username:'other',password:password(),owner:oldOwner})).status,400);
  assert.equal((await f.request('/api/register',{username:'../../x',password:password()})).status,400);
  assert.equal((await f.request('/api/register',{username:'valid',password:password()},'', 'https://attacker.invalid')).status,403);
  assert.equal((await f.request(`/api/items/${saved.item.id}`,undefined,cookie)).status,404);
  await assert.rejects(f.library.update(owner,{id:saved.item.id,revision:saved.item.revision,title:'Denied'}));
  await assert.rejects(f.library.delete(owner,{id:saved.item.id,revision:saved.item.revision}));
  assert.equal((await f.library.export(owner)).items.length,0);
  f.config.signupEnabled=false;
  assert.equal((await f.request('/api/register',{username:'closed',password:password()})).status,403);
}));
test('recovery targets only the account owning the code and revokes only that account', () => fixture(async f => {
  const aPassword=password(), bPassword=password();
  const a=await f.auth.register('recovery_a',aPassword), b=await f.auth.register('recovery_b',bPassword);
  const owner=(await f.auth.sessionOwner(a))!;
  const result=await f.auth.createRecoveryCode(owner,a,aPassword);
  const next=password(); await f.auth.recover(result.recoveryCode,next);
  assert.equal(await f.auth.sessionOwner(a),undefined);
  assert.ok(await f.auth.sessionOwner(b));
  assert.equal(await f.auth.sessionOwner(await f.auth.login(next,undefined,'recovery_a')),owner);
  await assert.rejects(f.auth.recover(result.recoveryCode,password()));
  await assert.rejects(f.auth.login(aPassword,undefined,'recovery_a'));
}));
test('account deletion reauthenticates, removes all owned data and tokens, and preserves other users', () => fixture(async f => {
  const pass=password(); const session=await f.auth.register('delete_me',pass);
  const owner=(await f.auth.sessionOwner(session))!;
  const cookie=`drop_it_session=${session}`;
  const other=await f.auth.register('keep_me',password()); const otherOwner=(await f.auth.sessionOwner(other))!;
  const attachment=await f.library.upload(owner,Buffer.from('Synthetic file'),'text/plain','source.txt');
  await f.library.save(owner,{requestId:randomUUID(),title:'Delete me',source:{attachmentId:attachment.attachmentId,originalText:'Synthetic text'}});
  const kept=await f.library.save(otherOwner,{requestId:randomUUID(),title:'Keep me',source:{originalText:'Other owner'}});
  const access=randomBytes(32).toString('base64url');
  await f.db.query("INSERT INTO oauth_tokens(hash,family,owner,client_id,kind,scopes,resource,expires_at) VALUES($1,$2,$3,$4,'access',$5,$6,now()+interval '1 hour')",[digest(access),randomUUID(),owner,randomUUID(),['library:read'],`${f.config.origin}/mcp`]);
  assert.equal((await f.request('/api/delete-account',{currentPassword:pass,confirmation:'DELETE'})).status,401);
  assert.equal((await f.request('/api/delete-account',{currentPassword:password(),confirmation:'DELETE'},cookie)).status,401);
  assert.equal((await f.request('/api/delete-account',{currentPassword:pass,confirmation:'delete'},cookie)).status,400);
  assert.equal((await f.request('/api/delete-account',{currentPassword:pass,confirmation:'DELETE',owner:otherOwner},cookie)).status,400);
  assert.equal((await f.request('/api/delete-account',{currentPassword:pass,confirmation:'DELETE'},cookie,'https://attacker.invalid')).status,403);
  assert.equal((await f.request('/api/delete-account',{currentPassword:pass,confirmation:'DELETE'},cookie)).status,200);
  for(const table of ['items','sources','attachments','sessions','oauth_tokens','oauth_codes','save_requests','item_embeddings']) {
    assert.equal((await f.db.query(`SELECT owner FROM ${table} WHERE owner=$1`,[owner])).rows.length,0);
  }
  assert.equal(await f.auth.sessionOwner(session),undefined);
  await assert.rejects(f.auth.verifyAccessToken(access));
  assert.ok(await f.auth.sessionOwner(other));
  assert.equal((await f.library.get(otherOwner,kept.item.id)).item.title,'Keep me');
  assert.equal((await f.request('/api/delete-account',{currentPassword:pass,confirmation:'DELETE'},cookie)).status,401);
}));
test('account deletion rolls back content and sessions if the final delete fails', () => fixture(async f => {
  const pass=password(); const session=await f.auth.register('rollback',pass); const owner=(await f.auth.sessionOwner(session))!;
  const item=await f.library.save(owner,{requestId:randomUUID(),title:'Keep after failure',source:{originalText:'Rollback fixture'}});
  await f.db.query('CREATE TABLE deletion_blocker(owner uuid REFERENCES users(id))');
  await f.db.query('INSERT INTO deletion_blocker VALUES($1)',[owner]);
  await assert.rejects(f.auth.deleteAccount(owner,session,pass));
  assert.equal(await f.auth.sessionOwner(session),owner);
  assert.equal((await f.library.get(owner,item.item.id)).item.title,'Keep after failure');
  await f.db.query('DROP TABLE deletion_blocker');
  await f.auth.deleteAccount(owner,session,pass);
  assert.equal(await f.auth.sessionOwner(session),undefined);
}));

test('readiness and domain verification do not disclose internal settings', () => fixture(async f => {
  assert.equal((await f.request('/ready')).status,200);
  assert.equal((await f.request('/.well-known/openai-apps-challenge')).status,404);
  f.config.domainChallenge='public-synthetic-challenge';
  const challenge=await f.request('/.well-known/openai-apps-challenge');
  assert.equal(challenge.status,200);
  assert.equal(await challenge.text(),'public-synthetic-challenge');
  assert.match(challenge.headers.get('content-type')!,/^text\/plain/);
  const original=f.db.query;
  f.db.query=async()=>{throw new Error('Synthetic database connection failure');};
  try {
    const unavailable=await f.request('/ready');
    assert.equal(unavailable.status,503);
    assert.deepEqual(await unavailable.json(),{ok:false});
  } finally { f.db.query=original; }
}));
