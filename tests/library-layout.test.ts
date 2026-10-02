import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { layouts, readLayout, rememberLayout, LayoutSwitcher } from "../web/library-layout.js";

test("library layout stores only valid display preferences and tolerates unavailable storage", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  try {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    } });
    assert.equal(readLayout(), "standard");
    for (const layout of layouts) {
      rememberLayout(layout);
      assert.equal(readLayout(), layout);
    }
    assert.deepEqual([...values.keys()], ["drop-it.library-layout"]);
    values.set("drop-it.library-layout", "invalid");
    assert.equal(readLayout(), "standard");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("Storage blocked"); } });
    assert.equal(readLayout(), "standard");
    assert.doesNotThrow(() => rememberLayout("icon"));
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("layout controls expose named buttons, tooltips, and exactly one selected view", () => {
  for (const layout of layouts) {
    const html = renderToStaticMarkup(React.createElement(LayoutSwitcher, { value: layout, onChange: () => {} }));
    assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1);
    for (const label of ["Standard view", "Compact view", "Icon view"]) {
      assert.ok(html.includes(`aria-label="${label}"`));
      assert.ok(html.includes(`title="${label}"`));
    }
  }
});
