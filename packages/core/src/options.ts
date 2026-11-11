// Item options (modifiers): checking a line's chosen options against the item's groups, pricing them, and the
// label everything shows ("Flat white · Oat milk, Extra shot").
import type { ChosenOption, ItemOptionGroup, OrderItem } from "./types.js";

export type OptionsResult = { ok: true; options: ChosenOption[]; extraCents: number } | { ok: false; error: string };

/**
 * The options for one line: the ids the customer chose, checked against the item's groups. A group they chose
 * nothing in takes its defaults (the POS's own); a required group with no default and no choice is an error that
 * lists what to pick from. Unknown, sold-out, or too many choices are errors too.
 */
export function chooseOptions(
  itemName: string,
  groups: ItemOptionGroup[] | undefined,
  chosenIds: readonly string[] | undefined,
  money: (cents: number) => string,
): OptionsResult {
  const ids = [...new Set((chosenIds ?? []).map((id) => String(id)))];
  const all = groups ?? [];
  if (!all.length) {
    return ids.length ? { ok: false, error: `${itemName} has no options.` } : { ok: true, options: [], extraCents: 0 };
  }
  const groupOf = new Map<string, ItemOptionGroup>();
  for (const g of all) for (const o of g.options) groupOf.set(o.id, g);
  const unknown = ids.filter((id) => !groupOf.has(id));
  if (unknown.length) {
    return { ok: false, error: `${unknown.join(", ")} isn't an option for ${itemName}. Its options: ${describeGroups(all, money)}.` };
  }
  const chosen: ChosenOption[] = [];
  for (const g of all) {
    let picks = g.options.filter((o) => ids.includes(o.id));
    if (!picks.length) picks = g.options.filter((o) => o.default && !o.soldOut);
    const out = picks.find((o) => o.soldOut);
    if (out) return { ok: false, error: `${out.name} is sold out for ${itemName}.` };
    if (picks.length < g.min) {
      return { ok: false, error: `Choose ${g.min === 1 ? "a" : g.min} ${g.name} for ${itemName}: ${describeGroup(g, money)}.` };
    }
    if (g.max !== null && picks.length > g.max) {
      return { ok: false, error: `${itemName} takes ${g.max === 1 ? "one" : `up to ${g.max}`} ${g.name}: ${picks.map((o) => o.name).join(", ")} is too many.` };
    }
    for (const o of picks) chosen.push({ id: o.id, name: o.name, priceCents: o.priceCents });
  }
  return { ok: true, options: chosen, extraCents: chosen.reduce((sum, o) => sum + o.priceCents, 0) };
}

/** "Milk (pick one): Full cream, Oat milk +A$0.80" */
export function describeGroup(g: ItemOptionGroup, money: (cents: number) => string): string {
  const rule = g.max === 1 ? (g.min >= 1 ? "pick one" : "pick one, optional") : g.min >= 1 ? `pick ${g.min}+` : "pick any";
  const opts = g.options
    .filter((o) => !o.soldOut)
    .map((o) => `${o.name}${o.priceCents ? ` +${money(o.priceCents)}` : ""}${o.default ? " (default)" : ""}`);
  return `${g.name} (${rule}): ${opts.join(", ")}`;
}

export function describeGroups(groups: ItemOptionGroup[], money: (cents: number) => string): string {
  return groups.map((g) => describeGroup(g, money)).join("; ");
}

/** "Oat milk, Extra shot", or "" for a line with none. */
export function optionsLabel(item: Pick<OrderItem, "options">): string {
  return (item.options ?? []).map((o) => o.name).join(", ");
}

/** "Flat white · Oat milk, Extra shot": the line's name with its options, for staff, passes and emails. */
export function lineLabel(item: Pick<OrderItem, "name" | "options">): string {
  const opts = optionsLabel(item);
  return opts ? `${item.name} · ${opts}` : item.name;
}

/** Same options on two lines (order doesn't matter): such lines can be combined. */
export function sameOptions(a: Pick<OrderItem, "options">, b: Pick<OrderItem, "options">): boolean {
  const ka = (a.options ?? []).map((o) => o.id).sort().join(",");
  const kb = (b.options ?? []).map((o) => o.id).sort().join(",");
  return ka === kb;
}

/** A dietary note as it's kept: plain text, one line, at most 200 characters; empty is none. */
export function cleanDietaryNote(note: unknown): string | null {
  if (typeof note !== "string") return null;
  const text = note.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  return text || null;
}
