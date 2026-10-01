import { test } from "node:test";
import assert from "node:assert/strict";
import { downloadOriginal } from "../web/download.js";
import type { App } from "@modelcontextprotocol/ext-apps";

type Host = Pick<App, "getHostCapabilities" | "downloadFile">;
const original = Buffer.from("Synthetic original, unchanged.\n");
const data = `data:text/plain;base64,${original.toString("base64")}`;

test("hosts without downloads can open the authenticated same-drop browser fallback", async () => {
  const id = "d60167ef-fda0-4e94-9a35-2a80db4023d3";
  let opened = "";
  const host = {
    getHostCapabilities: () => ({openLinks:{}}),
    downloadFile: async () => { throw new Error("Direct download must not be called"); },
    openLink: async ({url}:{url:string}) => {opened=url; return {};},
  };
  assert.equal(await downloadOriginal(host,data,"source.txt",`https://synthetic.example.test/?drop=${id}`,id),"browser");
  assert.equal(opened,`https://synthetic.example.test/?drop=${id}`);
  opened="";
  for(const url of [`http://synthetic.example.test/?drop=${id}`,`https://synthetic.example.test/?drop=${id}&redirect=https://other.test`,`https://user:secret@synthetic.example.test/?drop=${id}`,`https://synthetic.example.test/other?drop=${id}`])
    await assert.rejects(downloadOriginal(host,data,"source.txt",url,id));
  assert.equal(opened,"");
  host.openLink=async()=>({isError:true});
  await assert.rejects(downloadOriginal(host,data,"source.txt",`https://synthetic.example.test/?drop=${id}`,id),/cancelled or declined/);
});

test("widget downloads preserve original bytes through the host with a safe filename", async () => {
  let calls = 0;
  const host: Host = {
    getHostCapabilities: () => ({ downloadFile: {} }),
    downloadFile: async (request) => {
      calls++;
      assert.deepEqual(request, { contents: [{ type: "resource", resource: {
        uri: "file:///synthetic%20source.txt", mimeType: "text/plain", blob: original.toString("base64"),
      } }] });
      return {};
    },
  };
  await downloadOriginal(host, data, "synthetic source.txt");
  assert.equal(calls, 1);
});

test("unsupported hosts receive no file and show a browser fallback", async () => {
  await assert.rejects(downloadOriginal({
    getHostCapabilities: () => ({}),
    downloadFile: async () => { throw new Error("Must not be called"); },
  }, data, "source.txt"), /does not support.*browser/);
});

test("widget download rejects external URLs, executable types, malformed data and path filenames", async () => {
  let calls = 0;
  const host: Host = {
    getHostCapabilities: () => ({ downloadFile: {} }),
    downloadFile: async () => { calls++; return {}; },
  };
  for (const [content, name] of [
    ["https://example.test/private.txt", "source.txt"],
    ["data:text/html;base64,PGgxPng8L2gxPg==", "source.html"],
    ["data:text/plain;base64,%%%", "source.txt"],
    [data, "../source.txt"], [data, "folder\\source.txt"],
    [data, "source\n.txt"], [data, "source.png"],
    [data, "x".repeat(256) + ".txt"],
  ]) await assert.rejects(downloadOriginal(host, content, name), /could not be downloaded/);
  assert.equal(calls, 0);
});

test("declined and failed host downloads never report success or leak transport errors", async () => {
  const host: Host = {
    getHostCapabilities: () => ({ downloadFile: {} }),
    downloadFile: async () => ({ isError: true }),
  };
  await assert.rejects(downloadOriginal(host, data, "source.txt"), /cancelled or declined/);
  host.downloadFile = async () => { throw new Error("sensitive transport detail"); };
  await assert.rejects(downloadOriginal(host, data, "source.txt"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /could not start/);
    assert.doesNotMatch(error.message, /sensitive/);
    return true;
  });
});
