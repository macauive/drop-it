import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readSidebarCollapsed, rememberSidebarCollapsed, SidebarToggle } from "../web/sidebar.js";

test("sidebar preference defaults expanded, validates stored values and handles blocked storage", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  try {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    } });
    assert.equal(readSidebarCollapsed(), false);
    rememberSidebarCollapsed(true);
    assert.equal(readSidebarCollapsed(), true);
    rememberSidebarCollapsed(false);
    assert.equal(readSidebarCollapsed(), false);
    assert.deepEqual([...values.keys()], ["drop-it.sidebar-collapsed.v1"]);
    for (const invalid of ["1", "TRUE", "invalid", ""]) {
      values.set("drop-it.sidebar-collapsed.v1", invalid);
      assert.equal(readSidebarCollapsed(), false);
    }
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("Storage blocked"); } });
    assert.equal(readSidebarCollapsed(), false);
    assert.doesNotThrow(() => rememberSidebarCollapsed(true));
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("sidebar toggle announces its action, controlled panel and expanded state", () => {
  for (const collapsed of [true, false]) {
    const html = renderToStaticMarkup(React.createElement(SidebarToggle, { collapsed, onToggle: () => {} }));
    const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
    assert.ok(html.includes(`aria-label="${label}"`));
    assert.ok(html.includes(`title="${label}"`));
    assert.ok(html.includes(`aria-expanded="${!collapsed}"`));
    assert.ok(html.includes('aria-controls="library-sidebar"'));
    assert.ok(html.includes('type="button"'));
  }
});
