import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
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
