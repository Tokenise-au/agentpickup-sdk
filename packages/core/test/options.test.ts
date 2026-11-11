import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseOptions, cleanDietaryNote, describeGroup, lineLabel, sameOptions, type ItemOptionGroup } from "../src/index.js";

const money = (c: number) => `A$${(c / 100).toFixed(2)}`;
const milk: ItemOptionGroup = {
  id: "milk",
  name: "milk",
  min: 1,
  max: 1,
  options: [
    { id: "full", name: "Full cream", priceCents: 0, default: true },
    { id: "oat", name: "Oat milk", priceCents: 80 },
    { id: "soy", name: "Soy milk", priceCents: 80, soldOut: true },
  ],
};
const extras: ItemOptionGroup = {
  id: "extras",
  name: "extras",
  min: 0,
  max: null,
  options: [
    { id: "shot", name: "Extra shot", priceCents: 50 },
    { id: "hot", name: "Extra hot", priceCents: 0 },
  ],
};

test("options: chosen ones are priced, a group with none takes its default", () => {
  const r = chooseOptions("Flat white", [milk, extras], ["oat", "shot"], money);
  assert.deepEqual(r, { ok: true, options: [{ id: "oat", name: "Oat milk", priceCents: 80 }, { id: "shot", name: "Extra shot", priceCents: 50 }], extraCents: 130 });
  const plain = chooseOptions("Flat white", [milk, extras], [], money);
  assert.deepEqual(plain, { ok: true, options: [{ id: "full", name: "Full cream", priceCents: 0 }], extraCents: 0 });
  assert.deepEqual(chooseOptions("Banana bread", undefined, undefined, money), { ok: true, options: [], extraCents: 0 });
});

test("options: unknown, sold out, too many, and a required choice with no default are errors that say what to pick", () => {
  const unknown = chooseOptions("Flat white", [milk], ["almond"], money);
  assert.equal(unknown.ok, false);
  assert.match(!unknown.ok ? unknown.error : "", /almond isn't an option for Flat white\. Its options: milk \(pick one\): Full cream \(default\), Oat milk \+A\$0\.80/);
  assert.match((chooseOptions("Flat white", [milk], ["soy"], money) as { error: string }).error, /Soy milk is sold out/);
  assert.match((chooseOptions("Flat white", [milk], ["full", "oat"], money) as { error: string }).error, /takes one milk/);
  const required = { ...milk, options: milk.options.map((o) => ({ ...o, default: false })) };
  assert.match((chooseOptions("Flat white", [required], [], money) as { error: string }).error, /^Choose a milk for Flat white: milk \(pick one\): Full cream, Oat milk \+A\$0\.80\.$/);
  assert.match((chooseOptions("Banana bread", undefined, ["oat"], money) as { error: string }).error, /has no options/);
  assert.equal(describeGroup(extras, money), "extras (pick any): Extra shot +A$0.50, Extra hot");
});

test("options: labels, matching lines, and dietary notes kept as plain text", () => {
  assert.equal(lineLabel({ name: "Flat white", options: [{ id: "oat", name: "Oat milk", priceCents: 80 }] }), "Flat white · Oat milk");
  assert.equal(lineLabel({ name: "Banana bread" }), "Banana bread");
  assert.ok(sameOptions({ options: [{ id: "a", name: "A", priceCents: 0 }, { id: "b", name: "B", priceCents: 0 }] }, { options: [{ id: "b", name: "B", priceCents: 0 }, { id: "a", name: "A", priceCents: 0 }] }));
  assert.ok(!sameOptions({ options: [{ id: "a", name: "A", priceCents: 0 }] }, {}));
  assert.equal(cleanDietaryNote("  Nut\nallergy\t please  "), "Nut allergy please");
  assert.equal(cleanDietaryNote("   "), null);
  assert.equal(cleanDietaryNote(42), null);
  assert.equal(cleanDietaryNote("x".repeat(300))?.length, 200);
});
