import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
const keys=['PUBLIC_URL','RENDER_EXTERNAL_URL','DATABASE_URL','NODE_ENV','ACCOUNT_MODE','ALLOW_SIGNUP','PUBLIC_PUBLISHER_NAME','PUBLIC_SUPPORT_EMAIL','BACKUP_RETENTION_DAYS','TRUST_PROXY_HOPS','OPENAI_APPS_CHALLENGE','OAUTH_REDIRECT_URIS'];
function isolated(run:()=>void) {
  const previous=keys.map(key=>[key,process.env[key]] as const);
  for(const key of keys) delete process.env[key];
  try { run(); } finally { for(const [key,value] of previous) if(value===undefined) delete process.env[key]; else process.env[key]=value; }
}
test('release configuration fails closed without durable storage or publisher facts',()=>isolated(()=>{
  assert.equal(loadConfig().signupEnabled,false);
  process.env.NODE_ENV='production'; process.env.RENDER_EXTERNAL_URL='https://synthetic.example.test';
  assert.throws(()=>loadConfig(),/DATABASE_URL/);
  process.env.DATABASE_URL='postgresql://localhost/synthetic';
  assert.equal(loadConfig().origin,'https://synthetic.example.test');
  process.env.ALLOW_SIGNUP='true'; assert.throws(()=>loadConfig(),/ACCOUNT_MODE/);
  process.env.ACCOUNT_MODE='public'; assert.throws(()=>loadConfig(),/publisher/);
  process.env.PUBLIC_PUBLISHER_NAME='Synthetic publisher'; process.env.PUBLIC_SUPPORT_EMAIL='support@example.test'; process.env.BACKUP_RETENTION_DAYS='3';
  assert.equal(loadConfig().signupEnabled,true);
  process.env.PUBLIC_URL='https://canonical.example.test'; assert.equal(loadConfig().origin,'https://canonical.example.test');
}));
test('release settings reject malformed proxy, flags, contact and challenge values',()=>isolated(()=>{
  process.env.TRUST_PROXY_HOPS='true'; assert.throws(()=>loadConfig()); delete process.env.TRUST_PROXY_HOPS;
  process.env.ALLOW_SIGNUP='yes'; assert.throws(()=>loadConfig()); delete process.env.ALLOW_SIGNUP;
  process.env.OPENAI_APPS_CHALLENGE='token\r\nheader'; assert.throws(()=>loadConfig()); delete process.env.OPENAI_APPS_CHALLENGE;
  process.env.PUBLIC_PUBLISHER_NAME='Synthetic';process.env.PUBLIC_SUPPORT_EMAIL='not-an-email';process.env.BACKUP_RETENTION_DAYS='3';assert.throws(()=>loadConfig());
}));
