import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { addPublicPages, publicSiteSchema } from '../server/public-pages.js';

test('public pages require real configuration and escape publisher input', async () => {
  for (const configured of [false,true]) {
    const app=express();
    addPublicPages(app,configured ? publicSiteSchema.parse({publisher:'Synthetic <script>alert(1)</script>', supportEmail:'support@example.test', backupRetentionDays:3}) : undefined);
    const server=app.listen(0,'127.0.0.1'); await once(server,'listening');
    const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    try {
      for (const path of ['/about','/support','/privacy','/terms']) {
        const response=await fetch(origin+path); const body=await response.text();
        assert.equal(response.status,configured?200:503);
        assert.ok(!body.includes('<script>'));
        if (configured) assert.ok(body.includes('&lt;script&gt;'));
        if (path==='/privacy' && configured) assert.ok(body.includes('up to 3 days'));
      }
    } finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
  }
});

test('review video exposes only the fixed synthetic asset and supports seeking', async () => {
  const app = express();
  addPublicPages(app, { publisher: 'Synthetic', supportEmail: 'support@example.test', backupRetentionDays: 7 });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const path = '/review/walkthrough-2026-10-03.mp4';
  try {
    const expected = await readFile(new URL('../release/review/walkthrough-2026-10-03.mp4', import.meta.url));
    const response = await fetch(origin + path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^video\/mp4/);
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
    const range = await fetch(origin + path, { headers: { Range: 'bytes=0-15' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-range'), `bytes 0-15/${expected.length}`);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), expected.subarray(0, 16));
    assert.equal((await fetch(origin + path, { method: 'HEAD' })).headers.get('content-length'), String(expected.length));
    for (const unknown of ['/review/', '/review/capture.json', '/review/other.mp4', '/private/.env']) {
      assert.equal((await fetch(origin + unknown)).status, 404);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  const disabled = express();
  addPublicPages(disabled);
  const disabledServer = disabled.listen(0, '127.0.0.1');
  await once(disabledServer, 'listening');
  try {
    const url = `http://127.0.0.1:${(disabledServer.address() as { port: number }).port}${path}`;
    assert.equal((await fetch(url)).status, 404);
  } finally {
    disabledServer.closeAllConnections();
    await new Promise<void>(resolve => disabledServer.close(() => resolve()));
  }
});
