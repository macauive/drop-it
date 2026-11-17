import test from "node:test";
import assert from "node:assert/strict";
import { adMeasurementReference, reportAdConversion } from "../server/ad-measurement.js";

const cookie = "__Host-oai-ad-measurement=0f174cf3-b16f-4bc2-9deb-9e13f6f8d14b~test.click_A-2=";
const config = { pixelId: "test_source", apiKey: "synthetic-key" };

test("measurement requires one bounded reference and honors Global Privacy Control", async () => {
  let calls = 0;
  const unused = async () => { calls++; return new Response(null, { status: 204 }); };
  for (const reference of [
    adMeasurementReference(null, null),
    adMeasurementReference(cookie, "1"),
    adMeasurementReference(cookie + "; " + cookie, null),
    adMeasurementReference(cookie + "%0A", null),
  ]) {
    assert.equal(reference, undefined);
    await reportAdConversion(config, reference, "registration_completed", unused);
  }
  await reportAdConversion({}, adMeasurementReference(cookie, null), "registration_completed", unused);
  assert.equal(calls, 0);
});

test("only outcome and ad reference are sent to OpenAI, with stable deduplication", async () => {
  const reference = adMeasurementReference("session=private; " + cookie, null);
  let captured: { url: string; init?: RequestInit } | undefined;
  await reportAdConversion(config, reference, "registration_completed", async (url, init) => {
    captured = { url: String(url), init };
    return new Response(null, { status: 204 });
  });
  assert.ok(captured);
  const { url, init } = captured;
    assert.equal(url, "https://bzr.openai.com/v1/events?pid=test_source");
    assert.equal(init?.redirect, "error");
    const event = JSON.parse(String(init?.body)).events[0];
    assert.ok(Number.isInteger(event.timestamp_ms));
    delete event.timestamp_ms;
    assert.deepEqual(event, {
      id: "0f174cf3-b16f-4bc2-9deb-9e13f6f8d14b", oppref: "test.click_A-2=",
      type: "registration_completed", source_url: "https://dontdropit.app/about", action_source: "web", data: { type: "customer_action" },
    });
});
