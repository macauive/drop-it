import { test } from "node:test";
import assert from "node:assert/strict";
import { poolTone } from "../web/pool-colors.js";

test("pool colors avoid palette collisions and do not depend on list order or capitalization", () => {
  const pools = ["Operations", "Uncategorized", "Design", "Travel", "Recipes", "Projects", "Research", "Reading"];
  assert.equal(new Set(pools.map((name) => poolTone(name, pools))).size, 8);
  for (const name of pools) {
    assert.equal(poolTone(name, pools), poolTone(` ${name.toUpperCase()} `, [...pools].reverse()));
    assert.equal(poolTone(name, pools), poolTone(name, [...pools, name.toLowerCase()]));
  }
});

test("large libraries reuse pool colors evenly and standalone details have a valid color", () => {
  const pools = Array.from({ length: 24 }, (_, i) => `Pool ${i}`);
  const counts = new Map<string, number>();
  for (const name of pools) {
    const tone = poolTone(name, pools);
    counts.set(tone, (counts.get(tone) ?? 0) + 1);
  }
  assert.equal(counts.size, 8);
  assert.ok([...counts.values()].every((count) => count === 3));
  assert.match(poolTone("Operations", []), /^category-tone-[0-7]$/);
});
