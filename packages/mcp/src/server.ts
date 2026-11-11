// The agentPickup MCP server: lets any MCP client (Claude, ChatGPT, Cursor, an agent framework) find pickup
// shops near someone, see what they sell, order, pay over x402, and hand its user the QR to collect with.
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import QRCode from "qrcode";
import { z } from "zod";
import { CARD_META_KEY, CARD_MIME_TYPE, passCardHtml, type PassCard, type QrBits } from "./card.js";
import { SHARE_META_KEY, shareCardHtml, type ShareCard } from "./share-card.js";
import { MENU_META_KEY, menuCardHtml, type MenuCard } from "./menu-card.js";
import { errorOf, usd, type Fetch, type Payer } from "./wallet.js";

export const VERSION = "0.7.1";

// The pickup pass card (MCP Apps). The version is in the URI so hosts that cache cards pick up a new one.
const CARD_URI = `ui://agentpickup/pass-${VERSION}.html`;
const CARD_TOOL_META = { ui: { resourceUri: CARD_URI }, "ui/resourceUri": CARD_URI };
const SHARE_URI = `ui://agentpickup/share-${VERSION}.html`;
const SHARE_TOOL_META = { ui: { resourceUri: SHARE_URI }, "ui/resourceUri": SHARE_URI };
const MENU_URI = `ui://agentpickup/menu-${VERSION}.html`;
const MENU_TOOL_META = { ui: { resourceUri: MENU_URI }, "ui/resourceUri": MENU_URI };
// What each card shows, for the model (ChatGPT reads openai/widgetDescription when a card loads), so it doesn't draw
// its own copy of the order beside the card: a copy can't update, so it would still say "awaiting payment" once paid.
const PASS_CARD_DESCRIPTION =
  "The user can see this card. It shows the order (shop, items, total); while it's unpaid, a Pay button to the shop's " +
  "checkout; once paid, the pickup QR, pickup code, collect-by time and Paid, Ready and Collected, which update by " +
  "themselves. Don't repeat the order, add another Pay button or link, or show your own summary of it: one short line is enough.";
const MENU_CARD_DESCRIPTION =
  "The user can see this card. It shows what the shop sells: each item's name, price, photo, options and labels, and what's " +
  "sold out. Don't list the items again; answer the user's question or ask what they'd like.";
const SHARE_CARD_DESCRIPTION =
  "The user can see this card. It shows a QR code and link for friends to add agentPickup to their assistant. Don't repeat the link.";
const passMeta = { ui: { prefersBorder: false }, "openai/widgetDescription": PASS_CARD_DESCRIPTION };
const shareMeta = { ui: { prefersBorder: false }, "openai/widgetDescription": SHARE_CARD_DESCRIPTION };

export interface PickupMcpOptions {
  /** The agentPickup shop this server orders from. */
  shopUrl: string;
  /**
   * Let tool calls name any agentPickup shop. Leave off for hosted servers, so callers can't point it anywhere:
   * they can still name shops on the same host (venues at /v/<slug>), as find_shops returns them.
   */
  allowOtherShops?: boolean;
  /** An agentPickup directory (<host>/directory/v1/shops). Adds find_shops: shops near someone that sell what they want. */
  directoryUrl?: string;
  /**
   * Shops on other hosts a hosted server may still order from, such as agentPickup shops its directory has checked.
   * Called with the shop's base URL.
   */
  trustedShop?: (shopBase: string) => boolean | Promise<boolean>;
  /** How requests reach the shop. Defaults to global fetch; a shop hosting its own server passes its app's fetch. */
  fetch?: Fetch;
  /** The wallet that pays. Without one, pay_order returns the price and pay link for another x402 client. */
  payer?: Payer;
  /** Notes added to the instructions agents read on connecting, e.g. which of this host's shops take what. */
  instructions?: string;
  /**
   * Card and test payments only, for connector directories that don't take crypto (Claude's, ChatGPT's): no
   * pay_order, no group orders (their shares pay in USDC), and nothing about USDC or wallets. The person pays on
   * the shop's own card checkout, so the connector itself never moves money.
   */
  cardsOnly?: boolean;
  /**
   * The page where people add agentPickup to their assistant, which share_agentpickup and the pass card's
   * "Invite a friend" link point to. Default https://agentpickup.app/add.
   */
  addPageUrl?: string;
}

type DirectoryShop = {
  name: string;
  url: string;
  location: { name: string; address?: string; hours?: string };
  currency: string;
  /** cardTest: cards in a payment provider's sandbox (its test cards pay, no real money moves). */
  payments: { x402: { network: string } | null; card: boolean; cardTest?: boolean; test: boolean };
  testOnly: boolean;
  distanceKm?: number;
  openNow: boolean | null;
  items: { id: string; name: string; priceCents: number }[];
  itemCount: number;
  order?: { via: "agentpickup" } | { via: "ucp"; profile: string } | { via: "web"; url: string };
  source?: { kind: "here" | "listed"; domain: string };
};

type Order = {
  id: string;
  status: string;
  rail?: string;
  items: { id: string; name: string; qty: number; unitCents?: number; options?: { id: string; name: string; priceCents: number }[] }[];
  /** Only in what the order's maker, staff and the shop's platform see. */
  dietaryNote?: string | null;
  /** When the customer will collect (Unix ms); absent is as soon as possible. */
  pickupAt?: number | null;
  totalCents: number;
  currency: string;
  collectBy: number | null;
  collectedAt?: number | null;
  /** When staff started it; absent while a paid order waits for the shop. */
  acceptedAt?: number | null;
};

type Pass = { order: Order; passUrl: string; pickupCode: string; qrContent: string };

// Shop names and where to collect, for the card, so polling order_status needn't read the catalog each time.
// Shared across the per-request servers a hosted endpoint makes.
const shopNames = new Map<string, string>();
const shopWhere = new Map<string, string>();
const rememberShop = (shop: string, name: unknown, location?: { name?: string; address?: string }) => {
  if (typeof name !== "string" || !name) return;
  if (shopNames.size > 500) {
    shopNames.clear();
    shopWhere.clear();
  }
  shopNames.set(shop, name);
  const where = location?.address || location?.name;
  if (where) shopWhere.set(shop, where);
};

type OptionGroup = { id: string; name: string; min: number; max: number | null; options: { id: string; name: string; priceCents: number; default?: boolean; soldOut?: boolean }[] };

// A shop's logo, colour, item photos and whether it takes dietary notes, for the cards. Read with its catalog,
// kept ten minutes, shared like the names.
type Looks = { logo?: string; brandColor?: string; images: Map<string, string>; notes: boolean; at: number };
const shopLooks = new Map<string, Looks>();
const rememberLooks = (shop: string, catalog: { merchant?: { logo?: unknown; brandColor?: unknown }; items?: { id: string; image?: unknown }[]; dietaryNotes?: unknown }) => {
  if (shopLooks.size > 500) shopLooks.clear();
  const https = (u: unknown) => (typeof u === "string" && u.startsWith("https://") ? u : undefined);
  shopLooks.set(shop, {
    logo: https(catalog.merchant?.logo),
    brandColor: typeof catalog.merchant?.brandColor === "string" && /^#[0-9a-fA-F]{6}$/.test(catalog.merchant.brandColor) ? catalog.merchant.brandColor : undefined,
    images: new Map((catalog.items ?? []).flatMap((i) => (https(i.image) ? [[i.id, https(i.image)!] as [string, string]] : []))),
    notes: catalog.dietaryNotes === true,
    at: Date.now(),
  });
};

/** "Oat milk, Extra shot" */
const optionNames = (i: { options?: { name: string }[] }) => (i.options ?? []).map((o) => o.name).join(", ");

/** "Milk (pick one): Full cream, Oat milk +A$0.80" */
function describeGroup(g: OptionGroup, money: (cents: number) => string): string {
  const rule = g.max === 1 ? (g.min >= 1 ? "pick one" : "pick one, optional") : g.min >= 1 ? `pick ${g.min}+` : "pick any";
  const opts = g.options.filter((o) => !o.soldOut).map((o) => `${o.name}${o.priceCents ? ` +${money(o.priceCents)}` : ""}${o.default ? " (default)" : ""}`);
  return `${g.name} (${rule}): ${opts.join(", ")}`;
}

/** A shop's name as the add page's ?shop= matches it: "Demo Café" -> "demo-cafe". */
const slugOf = (name: string) =>
  name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * A QR as a compact bit grid for the cards (a few hundred characters, where an SVG is several thousand): the cards
 * draw it, and the assistant that also reads structuredContent isn't handed an image's worth of path data.
 */
const qrBits = (content: string): QrBits => {
  const { modules } = QRCode.create(content, { errorCorrectionLevel: "M" });
  const n = modules.size;
  const bytes = new Uint8Array(Math.ceil((n * n) / 8));
  for (let i = 0; i < n * n; i++) if (modules.data[i]) bytes[i >> 3] |= 0x80 >> (i & 7);
  return { size: n, bits: Buffer.from(bytes).toString("base64") };
};

class ToolError extends Error {}

const INSTRUCTIONS = `agentPickup lets you buy things online for the user to collect in person.
0. find_shops (when available): shops near the user that sell what they want. Pass a shop's shop_url to the other tools.
1. get_shop: see what the shop sells, its pickup location and how it takes payment.
2. create_pickup_order: needs the user's email; the shop emails the pickup pass there too. It returns a claim:
   keep it with the order id. Pass an item's chosen options (get_shop lists them) as option ids, and the user's
   dietary note as dietary_note where the shop takes them; set_dietary_note changes it before payment. pickup_at
   orders for later ("for 5:30"), when the shop is open; leave it out for as soon as possible.
   cancel_pickup_order (with the claim) cancels an order the shop hasn't started, refunded the way it was paid.
3. pay_order: pays in USDC over x402 from the wallet set up here; with none, it hands back the pay link for the user's
   own x402 wallet. Where the shop takes cards, payment: "card" on
   create_pickup_order gives a checkout link for the user to pay on instead. Where it takes test payments (get_shop says
   so), payment: "test" runs the whole flow with no money moving. Confirm the items and total with the user first.
4. The pass: where the chat shows cards, the order appears as a card that becomes the pickup pass (QR and code)
   once it's paid and keeps itself up to date until it's collected. Otherwise give the user the pass link and pickup
   code. They show the QR at the counter, or say the code, to collect.
get_pickup_pass (with the claim) fetches the pass again; order_status (with the claim) says whether it's ready.
share_agentpickup: when the user wants to share agentPickup itself, invite a friend or get friends using it, shows a
QR and link for them. That isn't a group order: start_group_order is only for ordering together at one shop.
Group orders (a team lunch, an office order): start_group_order gives a code to share; each person's agent calls join_group_order and
pays its own share with pay_order; at closing time the shop gets one combined order and the organiser gets its QR.
group_order_status shows who's in; close_group_order closes it early.
Questions about agentPickup itself rather than a shop: the user pays on the shop's own checkout, so the assistant and
agentPickup never see the card; the money goes to the shop; the shop sees the user's name and order, not their email;
an order nobody collects is refunded; shops join at https://agentpickup.app/connect, with their POS or with none.
More at https://agentpickup.app/faq.`;

const CARDS_INSTRUCTIONS = `agentPickup lets you order from local businesses of any kind (retailers, restaurants, florists, hardware stores and more) for the user to collect in person.
0. find_shops (when available): shops near the user that sell what they want. Pass a shop's shop_url to the other tools.
1. get_shop: what the shop sells, where to collect, and how it takes payment.
2. create_pickup_order, once the user has agreed the items and total. It needs the user's email (the shop emails the
   pickup pass there too) and returns a claim: keep it with the order id. An item's options (a size, a colour, an add-on) are in
   get_shop: ask for a required choice that has no default, and pass the chosen option ids with the item. Where the
   shop takes dietary notes and the user mentions an allergy or dietary need, pass it as dietary_note; the order's
   card shows the note, or that none was added. set_dietary_note adds or changes it before they pay. For a later
   pickup ("for 5:30"), pass pickup_at; it must be when the shop is open. Leave it out for as soon as possible.
3. Payment: the user pays by card (or Apple Pay or Google Pay) on the shop's own checkout page, from the link
   create_pickup_order returns or the Pay button on the order's card. A test shop with a card checkout uses it too,
   with its test card and no real money; a demo shop with no checkout marks the order paid with no money moving.
4. The pass: where the chat shows cards, the order's card becomes the pickup pass (QR and code) once it's paid and
   keeps itself up to date until it's collected. Otherwise give the user the pass link and pickup code. They show the
   QR at the counter, or say the code, to collect.
get_pickup_pass (with the claim) fetches the pass again; order_status (with the claim) says whether it's ready.
cancel_pickup_order (with the claim) cancels an order the shop hasn't started yet, and refunds it the way it was paid.
share_agentpickup: when the user wants to share agentPickup itself or invite a friend, shows a QR and link for them.
Questions about agentPickup itself rather than a shop: the user pays on the shop's own checkout, so the assistant and
agentPickup never see the card; the money goes to the shop; the shop sees the user's name and order, not their email;
an order nobody collects is refunded; shops join at https://agentpickup.app/connect, with their POS or with none.
More at https://agentpickup.app/faq.`;

/** x402 networks that move no real money (the server's directory uses the same list). */
const TEST_NETWORKS = new Set(["eip155:84532"]);


/** A time as the shop reads it: "Wed 11 Nov, 5:30 pm (Australia/Brisbane)". */
function shopTime(ms: number, timeZone?: string): string {
  const zone = timeZone && /^[A-Za-z_+\-\/0-9]{1,64}$/.test(timeZone) ? timeZone : undefined;
  try {
    const text = new Intl.DateTimeFormat("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: zone }).format(new Date(ms));
    return zone ? `${text} (${zone})` : new Date(ms).toISOString();
  } catch {
    return new Date(ms).toISOString();
  }
}
const money = (cents: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

/** A tool's answer, and the card's data where there's a card: in structuredContent, which hosts pass to the card. */
const reply = (summary: string, data: unknown, card?: PassCard): ToolResult => ({
  content: [{ type: "text" as const, text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }],
  ...(card ? { structuredContent: { card }, _meta: { [CARD_META_KEY]: card } } : {}),
});

const failure = (message: string): ToolResult => ({ content: [{ type: "text" as const, text: message }], isError: true });

/** A shop's base URL: shops can live under a path (https://host/v/cafe). A pasted API or pass link works too. */
const shopBase = (url: URL) => {
  const path = url.pathname.replace(/\/+$/, "");
  return url.origin + (path.match(/^(.*)\/(?:api|p|c)\/.+$/)?.[1] ?? path.replace(/\/staff$/, ""));
};

export function createPickupMcpServer(opts: PickupMcpOptions): McpServer {
  const homeUrl = new URL(opts.shopUrl);
  const home = shopBase(homeUrl);
  const doFetch: Fetch = opts.fetch ?? ((req) => fetch(req));

  async function shopFor(shopUrl?: string): Promise<string> {
    if (!shopUrl) return home;
    let url: URL;
    try {
      url = new URL(shopUrl);
    } catch {
      throw new ToolError(`"${shopUrl}" isn't a URL.`);
    }
    // Shops on this server's own host: the home shop and its venues.
    if (url.origin === homeUrl.origin) return shopBase(url);
    if (opts.allowOtherShops || opts.trustedShop) {
      if (url.protocol !== "https:" && url.hostname !== "localhost") throw new ToolError("Shops must be served over https.");
      if (opts.allowOtherShops || (await opts.trustedShop!(shopBase(url)))) return shopBase(url);
      throw new ToolError(`This server orders from shops on ${homeUrl.origin} and agentPickup shops its directory lists.`);
    }
    throw new ToolError(`This server orders from shops on ${homeUrl.origin} only.`);
  }

  async function call(shop: string, path: string, init?: RequestInit) {
    const res = await doFetch(new Request(`${shop}${path}`, init));
    if (!res.ok) throw new ToolError(await errorOf(res, `The shop answered ${res.status}.`));
    return res.json() as Promise<Record<string, unknown>>;
  }

  // Tool errors go back to the model as text it can act on, not as protocol errors.
  const guarded =
    <A>(fn: (args: A) => Promise<ToolResult>) =>
    async (args: A) => {
      try {
        return await fn(args);
      } catch (err) {
        if (err instanceof ToolError) return failure(err.message);
        return failure(`Couldn't reach the shop: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

  /** The pass, for whoever made the order. null while it isn't paid (or is a share of a group order). */
  async function passByClaim(shop: string, orderId: string, claim: string): Promise<Pass | null> {
    const res = await doFetch(new Request(`${shop}/api/orders/${encodeURIComponent(orderId)}/pass`, { headers: { "X-Pickup-Claim": claim } }));
    if (res.status === 409) return null;
    if (!res.ok) throw new ToolError(await errorOf(res, `The shop answered ${res.status}.`));
    return (await res.json()) as Pass;
  }

  async function shopName(shop: string) {
    if (!shopNames.has(shop)) {
      const data = await call(shop, "/api/catalog").catch(() => null);
      const merchant = data?.merchant as { name?: string; location?: { name?: string; address?: string } } | undefined;
      rememberShop(shop, merchant?.name, merchant?.location);
    }
    return shopNames.get(shop);
  }

  /** What the pass card draws for an order, with its QR once there's a pass. */
  /** The shop's looks, read with its catalog when they aren't known (or are old). */
  async function looksOf(shop: string): Promise<Looks | undefined> {
    const known = shopLooks.get(shop);
    if (known && Date.now() - known.at < 10 * 60_000) return known;
    try {
      const catalog = await call(shop, "/api/catalog");
      rememberShop(shop, (catalog.merchant as { name?: string })?.name, (catalog.merchant as { location?: { name?: string; address?: string } })?.location);
      rememberLooks(shop, catalog as never);
    } catch {
      // The card still works without them.
    }
    return shopLooks.get(shop) ?? known;
  }

  /**
   * The order's card. `owner` is the order as its maker sees it (with any dietary note), when this call has that:
   * the card then shows the note, or that none was added. Without it the card keeps what it showed before.
   */
  async function cardFor(shop: string, order: Order, extra: Partial<PassCard> = {}, pass?: Pass | null, owner?: Order): Promise<PassCard> {
    const looks = await looksOf(shop);
    const noteFrom = owner ?? pass?.order;
    return {
      v: 1,
      orderId: order.id,
      shopUrl: shop,
      shopName: shopNames.get(shop),
      ...(looks?.logo ? { logo: looks.logo } : {}),
      ...(looks?.brandColor ? { brandColor: looks.brandColor } : {}),
      where: shopWhere.get(shop),
      lines: order.items.map((i) => ({
        qty: i.qty,
        name: i.name,
        ...(typeof i.unitCents === "number" ? { price: money(i.unitCents * i.qty, order.currency) } : {}),
        ...(looks?.images.get(i.id) ? { image: looks.images.get(i.id) } : {}),
        ...(i.options?.length ? { options: optionNames(i) } : {}),
      })),
      ...(looks?.notes && noteFrom ? { dietary: { note: noteFrom.dietaryNote ?? null } } : {}),
      status: order.status,
      ...(order.status === "paid" && order.acceptedAt ? { accepted: true } : {}),
      rail: order.rail,
      items: order.items.map((i) => `${i.qty}× ${i.name}${i.options?.length ? ` (${optionNames(i)})` : ""}`).join(", "),
      total: money(order.totalCents, order.currency),
      ...(order.pickupAt ? { pickupAt: order.pickupAt } : {}),
      collectBy: order.collectBy,
      collectedAt: order.collectedAt ?? null,
      inviteUrl: addLinks(shop).sharePageUrl,
      ...extra,
      ...(pass ? { passUrl: pass.passUrl, pickupCode: pass.pickupCode, qr: qrBits(pass.qrContent) } : {}),
    };
  }

  /** The add page for sharing: for one of this host's shops when given (?shop=<slug>), else everyone's. */
  const addPage = (opts.addPageUrl ?? "https://agentpickup.app/add").replace(/\/$/, "");
  function addLinks(shop?: string) {
    let slug = "";
    if (shop) {
      const u = new URL(shop);
      slug = u.pathname.match(/\/v\/([^/]+)/)?.[1] ?? (u.pathname === "/" || u.pathname === "" ? slugOf(shopNames.get(shop) ?? "") : "");
    }
    const q = slug ? `shop=${encodeURIComponent(slug)}` : "";
    return { url: `${addPage}${q ? `?${q}` : ""}`, sharePageUrl: `${addPage}?share=1${q ? `&${q}` : ""}` };
  }

  type Line = { id: string; qty: number; options?: string[] };
  const lineArg = z.object({
    id: z.string().describe("Item id from get_shop"),
    qty: z.number().int().min(1).max(20),
    options: z
      .array(z.string())
      .max(20)
      .optional()
      .describe("The ids of this line's chosen options from get_shop (a size, a colour, an add-on). Ask for a required choice that has no default."),
  });
  const lineBody = (l: Line) => ({ id: l.id, qty: l.qty, ...(l.options?.length ? { options: l.options } : {}) });
  const pickupArg = z
    .string()
    .max(40)
    .optional()
    .describe(
      'When the user wants to collect, if not as soon as possible: a time in the shop\'s own time zone (get_shop gives its local time) like "17:30" or "5:30pm" ' +
        "(today, or tomorrow once it has passed), or an ISO time. It must be when the shop is open, within 7 days. Leave it out for as soon as possible.",
    );
  const dietaryArg = z
    .string()
    .max(200)
    .optional()
    .describe(
      "The user's dietary needs for the shop, in their words (an allergy, an intolerance), where get_shop says it takes dietary notes. " +
        "Only what the user said; leave it out if they said nothing.",
    );

  const claimArg = z
    .string()
    .max(200)
    .optional()
    .describe("The claim create_pickup_order returned with the order. With it, a paid order's pass comes back too.");

  const shopArg: Record<string, z.ZodType> =
    opts.allowOtherShops || opts.directoryUrl
      ? { shop_url: z.string().optional().describe(`An agentPickup shop's URL, as find_shops returns it. Defaults to ${home}.`) }
      : {};

  const server = new McpServer(
    {
      name: "agentpickup",
      title: "agentPickup",
      version: VERSION,
      websiteUrl: "https://agentpickup.app",
      icons: [{ src: "https://agentpickup.app/logo.png", mimeType: "image/png", sizes: ["1024x1024"] }],
    },
    {
      instructions: (opts.cardsOnly ? CARDS_INSTRUCTIONS : INSTRUCTIONS) + (opts.instructions ? `\n${opts.instructions}` : ""),
    },
  );

  // The cards load the shop's logo and item photos from the shop's own /img/ addresses: their CSP names those origins.
  const photoOrigins = [...new Set([new URL(opts.shopUrl).origin, ...(opts.directoryUrl ? [new URL(opts.directoryUrl).origin] : [])])];
  const passResMeta = { ...passMeta, ui: { prefersBorder: false, csp: { resourceDomains: photoOrigins } } };
  server.registerResource(
    "pickup-pass",
    CARD_URI,
    {
      title: "Pickup pass",
      description: "The order as a card: a Pay button while it's unpaid, then the QR and pickup code, kept up to date until it's collected.",
      mimeType: CARD_MIME_TYPE,
      _meta: passResMeta,
    },
    async () => ({
      contents: [{ uri: CARD_URI, mimeType: CARD_MIME_TYPE, text: passCardHtml(VERSION), _meta: passResMeta }],
    }),
  );
  // Apps that loaded an older tool list (a phone that hasn't reconnected, a ChatGPT app version fixed at review) ask
  // for an older version's card: they get today's.
  server.registerResource(
    "pickup-pass-earlier",
    new ResourceTemplate("ui://agentpickup/pass-{version}.html", { list: undefined }),
    { title: "Pickup pass", mimeType: CARD_MIME_TYPE, _meta: passResMeta },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: CARD_MIME_TYPE, text: passCardHtml(VERSION), _meta: passResMeta }],
    }),
  );

  if (opts.directoryUrl) {
    const directoryUrl = opts.directoryUrl;
    server.registerTool(
      "find_shops",
      {
        title: "Find pickup shops",
        description:
          "Find agentPickup shops to order from: near a point (lat/lng), in a suburb or city (place), or selling something (query). " +
          "Returns each shop's shop_url, pickup address, hours, whether it's open now, distance, and matching menu items.",
        inputSchema: {
          query: z.string().max(100).optional().describe('What the user wants, e.g. "AA batteries", "flowers" or "sourdough". Leave out to list everything.'),
          place: z.string().max(100).optional().describe('A suburb, street or city to match against shop addresses, e.g. "Surry Hills".'),
          lat: z.number().min(-90).max(90).optional().describe("Where the user is: latitude. Send with lng."),
          lng: z.number().min(-180).max(180).optional().describe("Where the user is: longitude. Send with lat."),
          radius_km: z.number().positive().max(100).optional().describe("With lat/lng: how far to look. Default 10."),
          open_now: z.boolean().optional().describe("Only shops open now (shops without listed hours stay in)."),
          limit: z.number().int().min(1).max(50).optional(),
        },
        annotations: { title: "Find pickup shops", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      },
      guarded(
        async (args: { query?: string; place?: string; lat?: number; lng?: number; radius_km?: number; open_now?: boolean; limit?: number }) => {
          if ((args.lat === undefined) !== (args.lng === undefined)) throw new ToolError("Send lat and lng together.");
          const search = async (params: Record<string, unknown>, openNow?: boolean) => {
            const url = new URL(directoryUrl);
            for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
            if (openNow) url.searchParams.set("open_now", "true");
            const res = await doFetch(new Request(url));
            if (!res.ok) throw new ToolError(await errorOf(res, `The directory answered ${res.status}.`));
            const all = ((await res.json()) as { shops: DirectoryShop[] }).shops;
            // Cards-only: the shops it can order from here, by card or with a test payment. A shop on a test network
            // is there to try USDC, so it isn't one of them.
            return opts.cardsOnly
              ? all.filter((s) => s.payments.card || s.payments.cardTest || (s.payments.test && !(s.payments.x402 && TEST_NETWORKS.has(s.payments.x402.network))))
              : all;
          };
          let shops = await search({ q: args.query, place: args.place, lat: args.lat, lng: args.lng, radius_km: args.radius_km, limit: args.limit }, args.open_now);
          let header = "";
          // Nothing near the user: the test shops, which take orders from anywhere with no real money, so they can
          // still try it. Real shops elsewhere aren't offered: they're too far to collect from.
          if (!shops.length && (args.place || args.lat !== undefined)) {
            const anywhere = (await search({ q: args.query, limit: args.limit })).filter(
              (s) => s.testOnly || (s.payments.test && !s.payments.card && !s.payments.cardTest && s.source?.kind !== "listed"),
            );
            if (anywhere.length) {
              shops = anywhere;
              header = `No agentPickup shops ${args.place ? `in or near ${args.place}` : "near there"} yet. These test shops take orders from anywhere, with no real money moving, so the user can try it:\n`;
            }
          }
          if (!shops.length) return reply("No agentPickup shops match. Try a wider radius, another place, or no query.", { shops: [] });
          const lines = shops.map((s) => {
            const facts = [
              s.distanceKm !== undefined ? `${s.distanceKm} km` : null,
              s.openNow === true ? "open now" : s.openNow === false ? "closed now" : null,
              s.testOnly ? "test shop, no real money" : null,
              opts.cardsOnly ? (s.payments.card ? "takes cards" : s.payments.cardTest ? "takes test cards" : null) : null,
              s.source?.kind === "listed" ? `listed by ${s.source.domain}` : null,
              s.order?.via === "ucp" ? "orders through its UCP checkout" : s.order?.via === "web" ? "orders on its own website" : null,
            ].filter(Boolean);
            const items = s.items.slice(0, 3).map((i) => `${i.name} ${money(i.priceCents, s.currency)}`).join(", ");
            return `- ${s.name}${facts.length ? ` (${facts.join(", ")})` : ""}${s.location.address ? `, ${s.location.address}` : ""}${items ? `: ${items}` : ""}`;
          });
          return reply(`${header}${shops.length} shop${shops.length === 1 ? "" : "s"}:\n${lines.join("\n")}\nPass a shop's shop_url to get_shop or create_pickup_order.`, {
            ...(header ? { nearby: false } : {}),
            shops: shops.map((s) => ({
              shop_url: s.url,
              name: s.name,
              location: { name: s.location.name, address: s.location.address, hours: s.location.hours },
              distanceKm: s.distanceKm,
              openNow: s.openNow,
              testOnly: s.testOnly,
              payments: opts.cardsOnly
                ? { card: s.payments.card || Boolean(s.payments.cardTest), ...(s.payments.cardTest ? { testCards: true } : {}), test: s.payments.test }
                : { x402: s.payments.x402?.network ?? null, test: s.payments.test },
              listedBy: s.source?.kind === "listed" ? s.source.domain : null,
              // agentpickup: use get_shop and create_pickup_order. ucp or web: order there instead.
              orderVia: s.order?.via ?? "agentpickup",
              ...(s.order?.via === "ucp" ? { ucpProfile: s.order.profile } : s.order?.via === "web" ? { orderUrl: s.order.url } : {}),
              items: s.items.map((i) => ({ id: i.id, name: i.name, price: money(i.priceCents, s.currency) })),
              moreItems: Math.max(0, s.itemCount - s.items.length),
            })),
          });
        },
      ),
    );
  }

  server.registerTool(
    "get_shop",
    {
      title: "See what a shop sells",
      description:
        "What the shop sells (item ids and prices, with photos, dietary labels, allergens and what's sold out), where to collect, and which payments it takes. " +
        "In chat apps that show cards, the menu appears as a card with the photos.",
      inputSchema: { ...shopArg },
      annotations: { title: "See what a shop sells", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      _meta: MENU_TOOL_META,
    },
    guarded(async (args: { shop_url?: string }) => {
      const shop = await shopFor(args.shop_url);
      const data = await call(shop, "/api/catalog");
      const merchant = data.merchant as {
        name: string;
        location?: { name?: string; address?: string; hours?: string };
        socials?: { network: string; handle: string; url: string }[];
      };
      rememberShop(shop, merchant.name, merchant.location);
      rememberLooks(shop, data as never);
      const looks = shopLooks.get(shop);
      const NETWORK_NAMES: Record<string, string> = { instagram: "Instagram", x: "X", facebook: "Facebook", tiktok: "TikTok" };
      const collecting = data.collecting as { windowMinutes?: number; noShow?: string } | undefined;
      const waitFor = (m: number) => (m % 60 ? `${m} minutes` : m === 60 ? "1 hour" : `${m / 60} hours`);
      const collectingNote =
        collecting?.windowMinutes
          ? ` A paid order waits ${waitFor(collecting.windowMinutes)} from its pickup time; one nobody collects is ${collecting.noShow === "kept" ? "not refunded" : "refunded"}.`
          : "";
      const socials = (merchant.socials ?? []).filter((s) => NETWORK_NAMES[s.network]);
      const followNote = socials.length
        ? ` On ${socials.map((s) => `${NETWORK_NAMES[s.network]}${s.network === "facebook" ? "" : ` as @${s.handle}`}`).join(", ")}.`
        : "";
      const currency = String(data.currency ?? "usd");
      type Item = {
        id: string;
        name: string;
        priceCents: number;
        description?: string;
        category?: string;
        image?: string;
        dietary?: string[];
        allergens?: string[];
        calories?: number;
        soldOut?: boolean;
        options?: OptionGroup[];
      };
      const items = (data.items as Item[]).map((i) => ({
        id: i.id,
        name: i.name,
        price: money(i.priceCents, currency),
        description: i.description,
        ...(i.category ? { category: i.category } : {}),
        ...(typeof i.image === "string" && i.image.startsWith("https://") ? { image: i.image } : {}),
        ...(i.dietary?.length ? { dietary: i.dietary } : {}),
        ...(i.allergens?.length ? { allergens: i.allergens } : {}),
        ...(typeof i.calories === "number" ? { calories: i.calories } : {}),
        ...(i.soldOut ? { soldOut: true } : {}),
        // Pass the chosen ids with the item to create_pickup_order.
        ...(i.options?.length
          ? {
              options: i.options.map((g) => ({
                group: g.name,
                rule: describeGroup(g, (c) => money(c, currency)).replace(/^[^(]*\(([^)]*)\).*$/, "$1"),
                choices: g.options
                  .filter((o) => !o.soldOut)
                  .map((o) => ({ id: o.id, name: o.name, ...(o.priceCents ? { extra: money(o.priceCents, currency) } : {}), ...(o.default ? { default: true } : {}) })),
              })),
            }
          : {}),
      }));
      const groupsOf = new Map((data.items as Item[]).map((i) => [i.id, i.options ?? []]));
      const soldOut = items.filter((i) => i.soldOut).length;
      const payments = data.payments as { x402?: { network: string } | null; test?: boolean; card?: boolean; square?: { live: boolean } | null };
      const cards = Boolean(payments.square || payments.card);
      const ways = [
        ...(payments.x402 && !opts.cardsOnly ? [`USDC over x402 on ${payments.x402.network}, paid by the agent`] : []),
        ...(cards
          ? [payments.square?.live === false
              ? "cards, paid by the user on a checkout link (a sandbox: its test card pays, with no real money)"
              : "cards, paid by the user on a checkout link"]
          : []),
        ...(payments.test && !(opts.cardsOnly && cards) ? ["test payments, with no money moving"] : []),
      ];
      // Known hours: say whether it's open, so nobody orders from a closed shop.
      const openNow = typeof data.openNow === "boolean" ? data.openNow : null;
      const localTime = data.localTime as { now?: string; timeZone?: string } | undefined;
      const hoursNote =
        openNow === true ? "Open now. " : openNow === false ? `Closed now${data.opensNext ? `; opens ${data.opensNext}` : ""}: orders aren't taken until then. ` : "";
      const clockNote = localTime?.now && localTime.timeZone ? ` It's ${localTime.now} there (${localTime.timeZone}); a pickup_at clock time is in the shop's time.` : "";
      const menu: MenuCard = {
        v: 1,
        shop: merchant.name,
        ...(looks?.logo ? { logo: looks.logo } : {}),
        ...(looks?.brandColor ? { brandColor: looks.brandColor } : {}),
        ...(merchant.location?.name ? { location: merchant.location.name } : {}),
        openNow,
        ...(openNow === false && typeof data.opensNext === "string" ? { opensNext: data.opensNext } : {}),
        items: items.map(({ options, ...i }) => {
          const groups = groupsOf.get(i.id) ?? [];
          return { ...i, ...(options && groups.length ? { options: groups.map((g) => describeGroup(g, (c) => money(c, currency))) } : {}) };
        }),
      };
      const answer = reply(
        `${merchant.name}${merchant.location?.name ? `, collect at ${merchant.location.name}` : ""}. ` +
          hoursNote +
          (soldOut ? `${soldOut} item${soldOut === 1 ? " is" : "s are"} sold out right now. ` : "") +
          (!ways.length
            ? opts.cardsOnly
              ? "Doesn't take card payments here."
              : "Doesn't take agent payments."
            : ways.length === 1 && payments.test && !cards
              ? "A test shop: orders are marked paid without money moving."
              : `Takes ${ways.join("; ")}.`) +
          followNote +
          collectingNote +
          clockNote +
          // Hosts that draw cards show the menu as one: a second copy of it in the reply only clutters the chat.
          " Where the user sees the menu card, it already shows the items, prices, photos and options: don't list or draw the menu again; answer what they asked or ask what they'd like.",
        {
          shop,
          merchant: merchant.name,
          location: merchant.location,
          ...(socials.length ? { socials } : {}),
          openNow,
          ...(openNow === false && data.opensNext ? { opensNext: data.opensNext } : {}),
          currency,
          items,
          ...(opts.cardsOnly ? {} : { x402: payments.x402 ?? null }),
          cards,
          test: Boolean(payments.test) && !(opts.cardsOnly && cards),
          // Pass the user's dietary note (an allergy, an intolerance) as dietary_note when ordering.
          ...(looks?.notes ? { takesDietaryNotes: true } : {}),
        },
      );
      // The card draws the menu; hosts that pass _meta get it there too.
      return { ...answer, structuredContent: { menu }, _meta: { [MENU_META_KEY]: menu } };
    }),
  );

  server.registerTool(
    "ask_about_shop",
    {
      title: "Ask about a shop",
      description:
        "Answer a question about a shop that its menu doesn't: dietary needs and allergies (gluten-free, vegan, nuts), reviews, " +
        "opening hours, where it is, parking, wait times, prices. Use it whenever the user asks something like that about a shop. " +
        "Send the question in a few words, without names or other personal details. It answers from what the shop has said, " +
        "says plainly what the shop hasn't, and tells the shop which topics people ask about (never the question itself).",
      inputSchema: { ...shopArg, question: z.string().min(2).max(300).describe('The question in a few words, e.g. "gluten-free options?" or "is there parking?"') },
      annotations: { title: "Ask about a shop", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    guarded(async (args: { shop_url?: string; question: string }) => {
      const shop = await shopFor(args.shop_url);
      const data = await call(shop, "/api/question", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: args.question }),
      });
      const answers = (data.answers as { topic: string; text: string }[] | undefined) ?? [];
      return reply(`${String(data.shop ?? "The shop")}: ${answers.map((a) => a.text).join(" ") || "it hasn't said."}`, { shop, topics: data.topics, answers });
    }),
  );

  server.registerTool(
    "create_pickup_order",
    {
      title: "Order for pickup",
      description: opts.cardsOnly
        ? "Create an order to collect in person, once the user has agreed the items and total. Returns the order id, total, a " +
          "claim (keep it) and the shop's checkout link, where the user pays by card. The shop emails the pickup pass to `email` " +
          "once it's paid, and where the chat shows cards the order shows as one that becomes the pass. A shop with a card checkout " +
          "always uses it, test shops included (their checkout takes a test card); a demo shop with no checkout marks the order " +
          "paid with no money moving."
        : "Create an order to collect in person. Returns the order id, total and a claim (keep it); pay it with pay_order. " +
          "The shop emails the pickup pass to `email` once it's paid, and where the chat shows cards the order shows as one " +
          "that becomes the pass. Where the shop takes cards, `payment: \"card\"` returns a checkout link for the user to pay on instead.",
      inputSchema: {
        items: z.array(lineArg).min(1),
        email: z.string().email().describe("The user's email. The pickup pass goes here too."),
        name: z.string().max(100).optional().describe("Name for the order, shown to staff"),
        dietary_note: dietaryArg,
        pickup_at: pickupArg,
        payment: opts.cardsOnly
          ? z
              .enum(["card", "test"])
              .optional()
              .describe("Leave it out. A shop with a card checkout always uses it (the user pays on the shop's checkout link); test only applies at a demo shop with no checkout, where no money moves.")
          : z
              .enum(["agent", "card", "test"])
              .optional()
              .describe(
                "Who pays: agent (USDC over x402, or a test payment at a test shop), card (the user pays on a checkout link), " +
                  "or test (where the shop takes test payments: the whole flow with no money moving). Default: agent where the shop takes it, else card.",
              ),
        ...shopArg,
      },
      // It creates a real order (and, paid, a charge): Claude asks before it runs.
      annotations: { title: "Order for pickup", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      _meta: CARD_TOOL_META,
    },
    guarded(async (args: { items: Line[]; email: string; name?: string; dietary_note?: string; pickup_at?: string; payment?: "agent" | "card" | "test"; shop_url?: string }) => {
      const shop = await shopFor(args.shop_url);
      // The agent pays over x402 where the shop takes it, a test shop marks the order paid straight away, and a
      // shop that takes cards gives the user a checkout link.
      const catalog = (await call(shop, "/api/catalog")) as {
        payments: { x402?: unknown; test?: boolean; card?: boolean; square?: unknown };
        merchant?: { name?: string; location?: { name?: string; address?: string } };
        dietaryNotes?: boolean;
        localTime?: { timeZone?: string };
      };
      rememberShop(shop, catalog.merchant?.name, catalog.merchant?.location);
      rememberLooks(shop, catalog as never);
      // A shop that doesn't take dietary notes gets the order without one, and the user is told to say it at the counter.
      const note = args.dietary_note?.trim() ? args.dietary_note.trim().slice(0, 200) : undefined;
      const noteDropped = Boolean(note && !catalog.dietaryNotes);
      const { payments } = catalog;
      const agentRail = payments.x402 ? "x402" : payments.test ? "test" : null;
      const cardRail = payments.square ? "square" : payments.card ? "card" : null;
      // Cards-only: a shop with a card checkout always uses it, so the user sees and uses the shop's own checkout page
      // (a sandbox's takes its test card); a test payment is only for a demo shop with no checkout.
      const rail =
        opts.cardsOnly ? (args.payment === "card" ? cardRail : (cardRail ?? (payments.test ? "test" : null)))
        : args.payment === "test" ? (payments.test ? "test" : null)
        : args.payment === "card" ? cardRail
        : args.payment === "agent" ? agentRail
        : (agentRail ?? cardRail);
      if (!rail) {
        throw new ToolError(
          args.payment === "card" ? "This shop doesn't take cards."
          : opts.cardsOnly ? "This shop doesn't take card payments here."
          : args.payment === "test" ? "This shop doesn't take test payments."
          : "This shop doesn't take agent payments.",
        );
      }
      const data = await call(shop, "/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: args.items.map(lineBody),
          email: args.email,
          name: args.name,
          rail,
          ...(note && !noteDropped ? { dietaryNote: note } : {}),
          ...(args.pickup_at ? { pickupAt: args.pickup_at } : {}),
        }),
      });
      const order = data.order as Order;
      const next = data.next as { url?: string; passUrl?: string };
      // Older shops don't hand out claims; everything else still works.
      const claim = typeof data.claim === "string" ? data.claim : undefined;
      const what =
        `${order.items.map((i) => `${i.qty}× ${i.name}${i.options?.length ? ` (${optionNames(i)})` : ""}`).join(", ")}, ${money(order.totalCents, order.currency)}` +
        (order.dietaryNote ? `. Dietary note for the shop: ${order.dietaryNote}` : "") +
        (order.pickupAt ? `. For pickup at ${shopTime(order.pickupAt, catalog.localTime?.timeZone)}` : "");
      const keep =
        (claim ? " Keep the claim: get_pickup_pass and order_status take it." : "") +
        (noteDropped ? " This shop doesn't take dietary notes here: tell the user to tell staff at the counter." : "");
      if (rail === "test") {
        const pass = claim ? await passByClaim(shop, order.id, claim).catch(() => null) : null;
        return reply(
          `Test order ${order.id}: ${what}, marked paid with no money moving. The pickup pass is at ${next.passUrl}` +
            (pass ? ` (pickup code ${pass.pickupCode})` : "") +
            `, and the shop emails it to ${args.email}.${keep}`,
          {
            shop,
            orderId: order.id,
            claim,
            status: order.status,
            test: true,
            total: money(order.totalCents, order.currency),
            items: order.items,
            passUrl: next.passUrl,
            pickupCode: pass?.pickupCode,
          },
          await cardFor(shop, order, { claim, rail }, pass, order),
        );
      }
      if (rail === "square" || rail === "card") {
        return reply(
          `Order ${order.id}: ${what}. Give the user this link to pay by card: ${next.url}. Once they've paid, the shop emails ` +
            `${args.email} the receipt and pickup pass.${keep} Where the user sees the order's card, it already has this Pay ` +
            `button and turns into the pass once they pay: don't repeat the order or add another Pay button.`,
          { shop, orderId: order.id, claim, total: money(order.totalCents, order.currency), items: order.items, payBy: "card", checkoutUrl: next.url, collectBy: order.collectBy },
          await cardFor(shop, order, { claim, rail, checkoutUrl: next.url }, null, order),
        );
      }
      return reply(
        `Order ${order.id}: ${what}. Confirm with the user, then call pay_order.${keep}`,
        { shop, orderId: order.id, claim, total: money(order.totalCents, order.currency), items: order.items, payUrl: next.url, collectBy: order.collectBy },
        await cardFor(shop, order, { claim, rail }, null, order),
      );
    }),
  );

  if (!opts.cardsOnly) server.registerTool(
    "pay_order",
    {
      title: "Pay for an order",
      description: opts.payer
        ? `Pay an order in USDC over x402 from wallet ${opts.payer.address}. This spends money: confirm the items and total with the user first. Returns the pickup pass link.`
        : "No wallet is set up here, so this returns the price and pay link for another x402 client to pay.",
      inputSchema: { order_id: z.string(), ...shopArg },
      annotations: { title: "Pay for an order", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    guarded(async (args: { order_id: string; shop_url?: string }) => {
      const shop = await shopFor(args.shop_url);
      const status = (await call(shop, `/api/orders/${encodeURIComponent(args.order_id)}`)) as { order: { rail: string; status: string }; checkoutUrl?: string };
      if (status.order.rail === "square" || status.order.rail === "card") {
        if (status.order.status !== "awaiting_payment") return reply(`Order ${args.order_id} is already paid (${status.order.status}).`, { orderId: args.order_id, status: status.order.status });
        return reply(
          status.checkoutUrl
            ? `This order is paid by card: give the user ${status.checkoutUrl} to pay on.`
            : "This order is paid by card, on the checkout link create_pickup_order returned.",
          { orderId: args.order_id, payBy: "card", checkoutUrl: status.checkoutUrl ?? null },
        );
      }
      const payUrl = `${shop}/api/orders/${encodeURIComponent(args.order_id)}/pay`;
      if (!opts.payer) {
        const res = await doFetch(new Request(payUrl, { method: "POST" }));
        if (res.status !== 402) throw new ToolError(await errorOf(res, "This order isn't waiting for an x402 payment."));
        // x402 v2 carries the requirements in the PAYMENT-REQUIRED header; older servers put them in the body.
        const header = res.headers.get("PAYMENT-REQUIRED");
        const required = (header ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) : await res.json()) as {
          accepts?: { amount: string; network: string; asset: string; payTo: string }[];
        };
        const accept = required.accepts?.[0];
        // Other ways to finish, for an agent with no wallet of its own (a chat app on the web, say).
        const { payments } = (await call(shop, "/api/catalog").catch(() => ({ payments: {} }))) as { payments: { test?: boolean; card?: boolean; square?: unknown } };
        const others = [
          ...(payments.square || payments.card ? ['payment "card" gives the user a checkout link to pay on'] : []),
          ...(payments.test ? ['payment "test" runs the whole flow with no money moving'] : []),
        ];
        return reply(
          `Waiting for payment: ${usd(accept?.amount)} USDC on ${accept?.network}. No wallet is set up in this server: pay the link ` +
            `from the user's own x402 wallet (such as Coinbase's agent wallet), or set AGENTPICKUP_WALLET_KEY where this server runs.` +
            (others.length ? ` Or create the order again with create_pickup_order: ${others.join("; ")}.` : ""),
          { orderId: args.order_id, payUrl, amount: usd(accept?.amount), network: accept?.network, asset: accept?.asset, payTo: accept?.payTo },
        );
      }
      const paid = await opts.payer.pay({ id: args.order_id, payUrl }, doFetch);
      if (!paid.ok) {
        // A demo or test shop can still show the user the whole flow, with a test payment instead.
        const { payments } = (await call(shop, "/api/catalog").catch(() => ({ payments: {} }))) as { payments: { test?: boolean } };
        throw new ToolError(
          paid.error +
            (payments.test
              ? ' This shop also takes test payments, which move no money: call create_pickup_order again with payment "test" to run the whole flow.'
              : ""),
        );
      }
      return reply(
        `Paid ${paid.amount ?? ""} USDC. Pickup pass: ${paid.passUrl}` +
          (paid.emailedTo ? ` (also emailed to ${paid.emailedTo})` : "") +
          `. The user shows its QR at the counter.`,
        { orderId: args.order_id, ...paid, ok: undefined },
      );
    }),
  );

  server.registerTool(
    "order_status",
    {
      title: "Check an order",
      description:
        "Whether an order is waiting for payment, paid, ready to collect, collected or expired. With the order's claim, " +
        "a paid order's pass comes back too, and the chat's card for it updates.",
      inputSchema: { order_id: z.string(), claim: claimArg, ...shopArg },
      annotations: { title: "Check an order", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      _meta: CARD_TOOL_META,
    },
    guarded(async (args: { order_id: string; claim?: string; shop_url?: string }) => {
      const shop = await shopFor(args.shop_url);
      const { order, checkoutUrl, claimed } = (await call(shop, `/api/orders/${encodeURIComponent(args.order_id)}`, {
        headers: args.claim ? { "X-Pickup-Claim": args.claim } : {},
      })) as { order: Order; checkoutUrl?: string; claimed?: boolean };
      const words: Record<string, string> = {
        awaiting_payment: "is waiting for payment",
        paid: order.acceptedAt ? "is paid and the shop is making it" : "is paid; the shop has it but hasn't started it yet",
        ready: "is ready to collect",
        collected: "has been collected",
        expired: "expired before anyone collected it",
        cancelled: "was cancelled",
      };
      const pass =
        args.claim && (order.status === "paid" || order.status === "ready") ? await passByClaim(shop, order.id, args.claim).catch(() => null) : null;
      return reply(
        `Order ${order.id} ${words[order.status] ?? `is ${order.status}`}.` + (pass ? ` Pickup code ${pass.pickupCode}, pass at ${pass.passUrl}.` : ""),
        pass ? { ...order, passUrl: pass.passUrl, pickupCode: pass.pickupCode } : order,
        await cardFor(shop, order, { claim: args.claim, checkoutUrl }, pass, claimed ? order : undefined),
      );
    }),
  );

  server.registerTool(
    "set_dietary_note",
    {
      title: "Add a dietary note",
      description:
        "Add or change the dietary note on an order before it's paid (an allergy, an intolerance, in the user's words), at a shop that " +
        "takes dietary notes. An empty note removes it. The order's card shows it within a few seconds. Once the order is paid it's " +
        "with the shop already: the user tells staff at the counter instead.",
      inputSchema: {
        order_id: z.string(),
        claim: z.string().max(200).describe("The claim create_pickup_order returned with the order."),
        note: z.string().max(200).describe("The note, only what the user said. Empty to remove it."),
        ...shopArg,
      },
      annotations: { title: "Add a dietary note", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    guarded(async (args: { order_id: string; claim: string; note: string; shop_url?: string }) => {
      const shop = await shopFor(args.shop_url);
      const data = (await call(shop, `/api/orders/${encodeURIComponent(args.order_id)}/dietary-note`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Pickup-Claim": args.claim },
        body: JSON.stringify({ note: args.note }),
      })) as { order: Order };
      const note = data.order.dietaryNote;
      return reply(
        note
          ? `The order's dietary note is now: ${note}. The shop gets it with the order once it's paid, and the order's card shows it.`
          : "The order has no dietary note now.",
        { orderId: data.order.id, dietaryNote: note ?? null },
      );
    }),
  );

  server.registerTool(
    "cancel_pickup_order",
    {
      title: "Cancel an order",
      description:
        "Cancel a pickup order when the user asks, with the claim create_pickup_order returned. An unpaid order just closes. A paid " +
        "one can be cancelled until the shop starts making it, and what was paid goes back the way it was paid (a card refund can " +
        "take a few business days to show). Once the shop has started it, or it's ready, the user asks staff at the counter instead.",
      inputSchema: {
        order_id: z.string(),
        claim: z.string().max(200).describe("The claim create_pickup_order returned with the order."),
        ...shopArg,
      },
      annotations: { title: "Cancel an order", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    guarded(async (args: { order_id: string; claim: string; shop_url?: string }) => {
      const shop = await shopFor(args.shop_url);
      const data = (await call(shop, `/api/orders/${encodeURIComponent(args.order_id)}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Pickup-Claim": args.claim },
        body: "{}",
      })) as { order: Order; outcome: string };
      const amount = money(data.order.totalCents, data.order.currency);
      const text =
        data.outcome === "unpaid"
          ? `Order ${data.order.id} is cancelled. It wasn't paid, so nothing is charged.`
          : data.outcome === "already_cancelled"
            ? `Order ${data.order.id} was already cancelled.`
            : data.order.rail === "test"
              ? `Order ${data.order.id} is cancelled. It was a test order, so no money moved.`
              : data.outcome === "refund_failed"
                ? `Order ${data.order.id} is cancelled, but the refund of ${amount} didn't go through yet: the shop has been told, and the user can contact it.`
                : `Order ${data.order.id} is cancelled, and ${amount} goes back the way it was paid (a card refund can take a few business days to show). The shop is told, and the user gets an email.`;
      return reply(text, { orderId: data.order.id, status: data.order.status, outcome: data.outcome });
    }),
  );

  server.registerTool(
    "get_pickup_pass",
    {
      title: "Get the pickup pass",
      description:
        "The pass link, pickup code and QR for a paid order: with the claim create_pickup_order returned" +
        (opts.payer ? ", or by signing in with the wallet that paid (Sign-In-With-X)." : "."),
      inputSchema: { order_id: z.string(), claim: claimArg, ...shopArg },
      annotations: { title: "Get the pickup pass", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      _meta: CARD_TOOL_META,
    },
    guarded(async (args: { order_id: string; claim?: string; shop_url?: string }) => {
      const shop = await shopFor(args.shop_url);
      let pass: Pass | null;
      if (args.claim) {
        pass = await passByClaim(shop, args.order_id, args.claim);
        if (!pass) throw new ToolError("This order isn't paid yet, so there's no pass. order_status says where it's at.");
      } else if (opts.payer) {
        const res = await opts.payer.signIn(`${shop}/api/orders/${encodeURIComponent(args.order_id)}/pass`, doFetch);
        if (!res.ok) throw new ToolError(await errorOf(res, `The shop answered ${res.status}.`));
        pass = (await res.json()) as Pass;
      } else {
        throw new ToolError("Send the claim create_pickup_order returned with the order. The pass is also in the email the shop sent when it was paid.");
      }
      await shopName(shop);
      return reply(
        `Pickup pass: ${pass.passUrl}, pickup code ${pass.pickupCode}. The user shows the QR at the counter, or says the code.`,
        { passUrl: pass.passUrl, pickupCode: pass.pickupCode, qrContent: pass.qrContent, status: pass.order?.status },
        pass.order ? await cardFor(shop, pass.order, { claim: args.claim }, pass) : undefined,
      );
    }),
  );

  // ---------- sharing ----------
  // The menu card loads item photos from the shop's own /img/<id>: its CSP names the shops' origins.
  const menuMeta = { ui: { prefersBorder: false, csp: { resourceDomains: photoOrigins } }, "openai/widgetDescription": MENU_CARD_DESCRIPTION };
  server.registerResource(
    "shop-menu",
    MENU_URI,
    { title: "Shop menu", description: "A shop's items with photos, prices and dietary labels.", mimeType: CARD_MIME_TYPE, _meta: menuMeta },
    async () => ({ contents: [{ uri: MENU_URI, mimeType: CARD_MIME_TYPE, text: menuCardHtml(VERSION), _meta: menuMeta }] }),
  );
  server.registerResource(
    "shop-menu-earlier",
    new ResourceTemplate("ui://agentpickup/menu-{version}.html", { list: undefined }),
    { title: "Shop menu", mimeType: CARD_MIME_TYPE, _meta: menuMeta },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: CARD_MIME_TYPE, text: menuCardHtml(VERSION), _meta: menuMeta }] }),
  );

  server.registerResource(
    "share-agentpickup",
    SHARE_URI,
    {
      title: "Share agentPickup",
      description: "A QR and link for friends to add agentPickup to their assistant.",
      mimeType: CARD_MIME_TYPE,
      _meta: shareMeta,
    },
    async () => ({
      contents: [{ uri: SHARE_URI, mimeType: CARD_MIME_TYPE, text: shareCardHtml(VERSION), _meta: shareMeta }],
    }),
  );
  server.registerResource(
    "share-agentpickup-earlier",
    new ResourceTemplate("ui://agentpickup/share-{version}.html", { list: undefined }),
    { title: "Share agentPickup", mimeType: CARD_MIME_TYPE, _meta: shareMeta },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: CARD_MIME_TYPE, text: shareCardHtml(VERSION), _meta: shareMeta }],
    }),
  );

  server.registerTool(
    "share_agentpickup",
    {
      title: "Share agentPickup",
      description:
        "A QR code and link the user can share so friends can add agentPickup to Claude, ChatGPT or Grok and order too. " +
        "Use when the user asks how to share agentPickup, invite friends, or get others using it. Name a shop to share it with that shop picked.",
      inputSchema: { ...shopArg },
      annotations: { title: "Share agentPickup", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: SHARE_TOOL_META,
    },
    guarded(async (args: { shop_url?: string }) => {
      const shop = args.shop_url ? await shopFor(args.shop_url) : undefined;
      const name = shop ? await shopName(shop) : undefined;
      const links = addLinks(shop);
      const card: ShareCard = {
        v: 1,
        ...links,
        qr: qrBits(links.url),
        ...(name ? { shopName: name } : {}),
      };
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Share this link: ${links.url}. A friend opens it (or scans its QR off the user's screen), adds agentPickup to Claude, ChatGPT or Grok, ` +
              `then just asks for their usual${name ? ` at ${name}` : ""}. ${links.sharePageUrl} opens the phone's share sheet and has a sticker to print. ` +
              `News and new shops: @agentPickup on X, https://x.com/agentPickup.`,
          },
        ],
        structuredContent: { share: card },
        _meta: { [SHARE_META_KEY]: card },
      };
    }),
  );

  // ---------- group orders ----------
  type GroupView = {
    code: string;
    title: string;
    status: string;
    organiser: string;
    closesAt: number;
    members: { name: string; items: string; totalCents: number; status: string }[];
    paidCents: number;
    currency: string;
    combined: { status: string; collectBy: number } | null;
  };
  const closesIn = (g: GroupView) => {
    const minutes = Math.max(0, Math.round((g.closesAt - Date.now()) / 60_000));
    return g.status === "open" ? `closes in ${minutes} min` : g.status === "sent" ? "closed and sent to the shop" : "cancelled";
  };
  const groupSummary = (g: GroupView) => {
    const paid = g.members.filter((m) => m.status !== "awaiting_payment" && m.status !== "cancelled");
    return `${g.title} (code ${g.code}), ${closesIn(g)}: ${paid.length} of ${g.members.length} paid, ${money(g.paidCents, g.currency)} so far.`;
  };

  if (!opts.cardsOnly) server.registerTool(
    "start_group_order",
    {
      title: "Start a group order",
      description:
        "Start a group order (a team lunch, an office order) at a shop, when the user wants to order together with others now. Returns a code to " +
        "share: each person's agent joins with it and pays for their own items. When it closes, the shop gets one combined order " +
        "and the organiser is emailed its pickup QR. To share agentPickup itself with a friend, use share_agentpickup instead.",
      inputSchema: {
        organiser_name: z.string().min(1).max(60).describe("Who collects, shown to staff"),
        organiser_email: z.string().email().describe("Where the group's pickup QR goes"),
        title: z.string().max(60).optional().describe('e.g. "Friday team lunch"'),
        closes_in_minutes: z.number().int().min(5).max(240).optional().describe("Default 15"),
        ...shopArg,
      },
      annotations: { title: "Start a group order", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    guarded(async (args: { organiser_name: string; organiser_email: string; title?: string; closes_in_minutes?: number; shop_url?: string }) => {
      const shop = await shopFor(args.shop_url);
      const data = (await call(shop, "/api/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: args.organiser_name, email: args.organiser_email, title: args.title, closesInMinutes: args.closes_in_minutes }),
      })) as { group: GroupView; organiserKey: string };
      return reply(
        `Started ${data.group.title}: share code ${data.group.code}. Everyone's agent joins with join_group_order and the code; it ${closesIn(data.group)}. ` +
          `Keep organiser_key to close it early.`,
        { shop, code: data.group.code, closesAt: data.group.closesAt, organiser_key: data.organiserKey },
      );
    }),
  );

  if (!opts.cardsOnly) server.registerTool(
    "join_group_order",
    {
      title: "Join a group order",
      description:
        "Add the user's items to a group order with its code. Returns the order id; pay it with pay_order before the group closes. " +
        "The organiser collects everything, so the user gets a receipt, not a QR.",
      inputSchema: {
        code: z.string().min(4).max(12).describe("The group's code"),
        items: z.array(lineArg).min(1),
        dietary_note: dietaryArg,
        email: z.string().email().describe("The user's email, for their receipt"),
        name: z.string().min(1).max(60).describe("The user's name, shown to staff on their items"),
        ...shopArg,
      },
      annotations: { title: "Join a group order", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    guarded(async (args: { code: string; items: Line[]; email: string; name: string; dietary_note?: string; shop_url?: string }) => {
      const shop = await shopFor(args.shop_url);
      const { payments } = (await call(shop, "/api/catalog")) as { payments: { x402?: unknown; test?: boolean } };
      const rail = payments.x402 ? "x402" : payments.test ? "test" : null;
      if (!rail) throw new ToolError("This shop doesn't take agent payments.");
      const data = (await call(shop, `/api/groups/${encodeURIComponent(args.code)}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: args.items.map(lineBody), email: args.email, name: args.name, rail, ...(args.dietary_note?.trim() ? { dietaryNote: args.dietary_note.trim().slice(0, 200) } : {}) }),
      })) as { order: Order; group: GroupView; next: { type: string; url?: string } };
      const what = `${data.order.items.map((i) => `${i.qty}× ${i.name}`).join(", ")}, ${money(data.order.totalCents, data.order.currency)}`;
      return reply(
        rail === "test"
          ? `Added to ${data.group.title}: ${what}, paid with a test payment (no money moved). ${data.group.organiser} collects it.`
          : `Added to ${data.group.title}: ${what}. Confirm with the user, then pay it with pay_order (order ${data.order.id}) before the group closes.`,
        { shop, orderId: data.order.id, group: groupSummary(data.group), payUrl: data.next.url ?? null, test: rail === "test" },
      );
    }),
  );

  if (!opts.cardsOnly) server.registerTool(
    "group_order_status",
    {
      title: "Check a group order",
      description: "Who's in a group order, what they ordered, who has paid, and whether it has closed and been collected.",
      inputSchema: { code: z.string().min(4).max(12), ...shopArg },
      annotations: { title: "Check a group order", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    guarded(async (args: { code: string; shop_url?: string }) => {
      const shop = await shopFor(args.shop_url);
      const { group } = (await call(shop, `/api/groups/${encodeURIComponent(args.code)}`)) as { group: GroupView };
      return reply(
        groupSummary(group) + (group.combined ? ` The shop's order is ${group.combined.status}.` : ""),
        group,
      );
    }),
  );

  if (!opts.cardsOnly) server.registerTool(
    "close_group_order",
    {
      title: "Close a group order now",
      description: "Close a group order early, as its organiser. Unpaid shares are left out; the shop gets the rest as one order.",
      inputSchema: { code: z.string().min(4).max(12), organiser_key: z.string().min(8), ...shopArg },
      annotations: { title: "Close a group order now", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    guarded(async (args: { code: string; organiser_key: string; shop_url?: string }) => {
      const shop = await shopFor(args.shop_url);
      const { group } = (await call(shop, `/api/groups/${encodeURIComponent(args.code)}/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organiserKey: args.organiser_key }),
      })) as { group: GroupView };
      return reply(
        group.status === "sent"
          ? `Closed: ${groupSummary(group)} The shop has the combined order, and ${group.organiser}'s pickup QR is on its way by email.`
          : `Closed with nobody paid, so the group order was cancelled.`,
        group,
      );
    }),
  );

  return server;
}

/** A Streamable HTTP endpoint (stateless, JSON responses) for hosting the server, e.g. at /mcp. */
export function createMcpHandler(opts: PickupMcpOptions) {
  return async (req: Request): Promise<Response> => {
    const server = createPickupMcpServer(opts);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(req);
  };
}
