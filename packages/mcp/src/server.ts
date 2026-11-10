// The agentPickup MCP server: lets any MCP client (Claude, ChatGPT, Cursor, an agent framework) find pickup
// shops near someone, see what they sell, order, pay over x402, and hand its user the QR to collect with.
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import QRCode from "qrcode";
import { z } from "zod";
import { CARD_META_KEY, CARD_MIME_TYPE, passCardHtml, type PassCard, type QrBits } from "./card.js";
import { SHARE_META_KEY, shareCardHtml, type ShareCard } from "./share-card.js";
import { errorOf, usd, type Fetch, type Payer } from "./wallet.js";

export const VERSION = "0.5.0";

// The pickup pass card (MCP Apps). The version is in the URI so hosts that cache cards pick up a new one.
const CARD_URI = `ui://agentpickup/pass-${VERSION}.html`;
const CARD_TOOL_META = { ui: { resourceUri: CARD_URI }, "ui/resourceUri": CARD_URI };
const SHARE_URI = `ui://agentpickup/share-${VERSION}.html`;
const SHARE_TOOL_META = { ui: { resourceUri: SHARE_URI }, "ui/resourceUri": SHARE_URI };

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
  items: { id: string; name: string; qty: number; unitCents?: number }[];
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
   keep it with the order id.
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
Group orders (a lunch or coffee run): start_group_order gives a code to share; each person's agent calls join_group_order and
pays its own share with pay_order; at closing time the shop gets one combined order and the organiser gets its QR.
group_order_status shows who's in; close_group_order closes it early.`;

const CARDS_INSTRUCTIONS = `agentPickup lets you order from local shops (cafés, bakeries, stores and more) for the user to collect in person.
0. find_shops (when available): shops near the user that sell what they want. Pass a shop's shop_url to the other tools.
1. get_shop: what the shop sells, where to collect, and how it takes payment.
2. create_pickup_order, once the user has agreed the items and total. It needs the user's email (the shop emails the
   pickup pass there too) and returns a claim: keep it with the order id.
3. Payment: the user pays by card (or Apple Pay or Google Pay) on the shop's own checkout page, from the link
   create_pickup_order returns or the Pay button on the order's card. Where the shop takes test payments,
   payment: "test" runs the whole flow with no money moving.
4. The pass: where the chat shows cards, the order's card becomes the pickup pass (QR and code) once it's paid and
   keeps itself up to date until it's collected. Otherwise give the user the pass link and pickup code. They show the
   QR at the counter, or say the code, to collect.
get_pickup_pass (with the claim) fetches the pass again; order_status (with the claim) says whether it's ready.
share_agentpickup: when the user wants to share agentPickup itself or invite a friend, shows a QR and link for them.`;

/** x402 networks that move no real money (the server's directory uses the same list). */
const TEST_NETWORKS = new Set(["eip155:84532"]);

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
  async function cardFor(shop: string, order: Order, extra: Partial<PassCard> = {}, pass?: Pass | null): Promise<PassCard> {
    return {
      v: 1,
      orderId: order.id,
      shopUrl: shop,
      shopName: shopNames.get(shop),
      where: shopWhere.get(shop),
      lines: order.items.map((i) => ({
        qty: i.qty,
        name: i.name,
        ...(typeof i.unitCents === "number" ? { price: money(i.unitCents * i.qty, order.currency) } : {}),
      })),
      status: order.status,
      ...(order.status === "paid" && order.acceptedAt ? { accepted: true } : {}),
      rail: order.rail,
      items: order.items.map((i) => `${i.qty}× ${i.name}`).join(", "),
      total: money(order.totalCents, order.currency),
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

  server.registerResource(
    "pickup-pass",
    CARD_URI,
    {
      title: "Pickup pass",
      description: "The order as a card: a Pay button while it's unpaid, then the QR and pickup code, kept up to date until it's collected.",
      mimeType: CARD_MIME_TYPE,
      _meta: { ui: { prefersBorder: false } },
    },
    async () => ({
      contents: [{ uri: CARD_URI, mimeType: CARD_MIME_TYPE, text: passCardHtml(VERSION), _meta: { ui: { prefersBorder: false } } }],
    }),
  );
  // Apps that loaded an older tool list (a phone that hasn't reconnected, a ChatGPT app version fixed at review) ask
  // for an older version's card: they get today's.
  server.registerResource(
    "pickup-pass-earlier",
    new ResourceTemplate("ui://agentpickup/pass-{version}.html", { list: undefined }),
    { title: "Pickup pass", mimeType: CARD_MIME_TYPE, _meta: { ui: { prefersBorder: false } } },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: CARD_MIME_TYPE, text: passCardHtml(VERSION), _meta: { ui: { prefersBorder: false } } }],
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
          query: z.string().max(100).optional().describe('What the user wants, e.g. "flat white", "sourdough" or "AA batteries". Leave out to list everything.'),
          place: z.string().max(100).optional().describe('A suburb, street or city to match against shop addresses, e.g. "Surry Hills".'),
          lat: z.number().min(-90).max(90).optional().describe("Where the user is: latitude. Send with lng."),
          lng: z.number().min(-180).max(180).optional().describe("Where the user is: longitude. Send with lat."),
          radius_km: z.number().positive().max(100).optional().describe("With lat/lng: how far to look. Default 10."),
          open_now: z.boolean().optional().describe("Only shops open now (shops without listed hours stay in)."),
          limit: z.number().int().min(1).max(50).optional(),
        },
        annotations: { title: "Find pickup shops", readOnlyHint: true, openWorldHint: true },
      },
      guarded(
        async (args: { query?: string; place?: string; lat?: number; lng?: number; radius_km?: number; open_now?: boolean; limit?: number }) => {
          if ((args.lat === undefined) !== (args.lng === undefined)) throw new ToolError("Send lat and lng together.");
          const url = new URL(directoryUrl);
          const params: Record<string, unknown> = { q: args.query, place: args.place, lat: args.lat, lng: args.lng, radius_km: args.radius_km, limit: args.limit };
          for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
          if (args.open_now) url.searchParams.set("open_now", "true");
          const res = await doFetch(new Request(url));
          if (!res.ok) throw new ToolError(await errorOf(res, `The directory answered ${res.status}.`));
          const all = ((await res.json()) as { shops: DirectoryShop[] }).shops;
          // Cards-only: the shops it can order from here, by card or with a test payment. A shop on a test network
          // is there to try USDC, so it isn't one of them.
          const shops = opts.cardsOnly
            ? all.filter((s) => s.payments.card || s.payments.cardTest || (s.payments.test && !(s.payments.x402 && TEST_NETWORKS.has(s.payments.x402.network))))
            : all;
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
          return reply(`${shops.length} shop${shops.length === 1 ? "" : "s"}:\n${lines.join("\n")}\nPass a shop's shop_url to get_shop or create_pickup_order.`, {
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
      description: "What the shop sells (item ids and prices), where to collect, and which payments it takes.",
      inputSchema: { ...shopArg },
      annotations: { title: "See what a shop sells", readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (args: { shop_url?: string }) => {
      const shop = await shopFor(args.shop_url);
      const data = await call(shop, "/api/catalog");
      const merchant = data.merchant as { name: string; location?: { name?: string; address?: string; hours?: string } };
      rememberShop(shop, merchant.name, merchant.location);
      const currency = String(data.currency ?? "usd");
      const items = (data.items as { id: string; name: string; priceCents: number; description?: string }[]).map((i) => ({
        id: i.id,
        name: i.name,
        price: money(i.priceCents, currency),
        description: i.description,
      }));
      const payments = data.payments as { x402?: { network: string } | null; test?: boolean; card?: boolean; square?: { live: boolean } | null };
      const cards = Boolean(payments.square || payments.card);
      const ways = [
        ...(payments.x402 && !opts.cardsOnly ? [`USDC over x402 on ${payments.x402.network}, paid by the agent`] : []),
        ...(cards ? ["cards, paid by the user on a checkout link"] : []),
        ...(payments.test ? ["test payments, with no money moving"] : []),
      ];
      // Known hours: say whether it's open, so nobody orders from a closed shop.
      const openNow = typeof data.openNow === "boolean" ? data.openNow : null;
      const hoursNote =
        openNow === true ? "Open now. " : openNow === false ? `Closed now${data.opensNext ? `; opens ${data.opensNext}` : ""}: orders aren't taken until then. ` : "";
      return reply(
        `${merchant.name}${merchant.location?.name ? `, collect at ${merchant.location.name}` : ""}. ` +
          hoursNote +
          (!ways.length
            ? opts.cardsOnly
              ? "Doesn't take card payments here."
              : "Doesn't take agent payments."
            : ways.length === 1 && payments.test
              ? "A test shop: orders are marked paid without money moving."
              : `Takes ${ways.join("; ")}.`),
        {
          shop,
          merchant: merchant.name,
          location: merchant.location,
          openNow,
          ...(openNow === false && data.opensNext ? { opensNext: data.opensNext } : {}),
          currency,
          items,
          ...(opts.cardsOnly ? {} : { x402: payments.x402 ?? null }),
          cards,
          test: Boolean(payments.test),
        },
      );
    }),
  );

  server.registerTool(
    "create_pickup_order",
    {
      title: "Order for pickup",
      description: opts.cardsOnly
        ? "Create an order to collect in person, once the user has agreed the items and total. Returns the order id, total, a " +
          "claim (keep it) and the shop's checkout link, where the user pays by card. The shop emails the pickup pass to `email` " +
          "once it's paid, and where the chat shows cards the order shows as one that becomes the pass. At shops that take test " +
          "payments, `payment: \"test\"` marks it paid with no money moving."
        : "Create an order to collect in person. Returns the order id, total and a claim (keep it); pay it with pay_order. " +
          "The shop emails the pickup pass to `email` once it's paid, and where the chat shows cards the order shows as one " +
          "that becomes the pass. Where the shop takes cards, `payment: \"card\"` returns a checkout link for the user to pay on instead.",
      inputSchema: {
        items: z
          .array(z.object({ id: z.string().describe("Item id from get_shop"), qty: z.number().int().min(1).max(20) }))
          .min(1),
        email: z.string().email().describe("The user's email. The pickup pass goes here too."),
        name: z.string().max(100).optional().describe("Name for the order, shown to staff"),
        payment: opts.cardsOnly
          ? z
              .enum(["card", "test"])
              .optional()
              .describe("card (the user pays on the shop's checkout link) or test (where the shop takes test payments: no money moves). Default: card where the shop takes it, else test.")
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
    guarded(async (args: { items: { id: string; qty: number }[]; email: string; name?: string; payment?: "agent" | "card" | "test"; shop_url?: string }) => {
      const shop = await shopFor(args.shop_url);
      // The agent pays over x402 where the shop takes it, a test shop marks the order paid straight away, and a
      // shop that takes cards gives the user a checkout link.
      const catalog = (await call(shop, "/api/catalog")) as {
        payments: { x402?: unknown; test?: boolean; card?: boolean; square?: unknown };
        merchant?: { name?: string; location?: { name?: string; address?: string } };
      };
      rememberShop(shop, catalog.merchant?.name, catalog.merchant?.location);
      const { payments } = catalog;
      const agentRail = payments.x402 ? "x402" : payments.test ? "test" : null;
      const cardRail = payments.square ? "square" : payments.card ? "card" : null;
      const rail =
        args.payment === "test" ? (payments.test ? "test" : null)
        : args.payment === "card" ? cardRail
        : args.payment === "agent" ? agentRail
        : opts.cardsOnly ? (cardRail ?? (payments.test ? "test" : null))
        : (agentRail ?? cardRail);
      if (!rail) {
        throw new ToolError(
          args.payment === "test" ? "This shop doesn't take test payments."
          : args.payment === "card" ? "This shop doesn't take cards."
          : opts.cardsOnly ? "This shop doesn't take card payments here."
          : "This shop doesn't take agent payments.",
        );
      }
      const data = await call(shop, "/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: args.items, email: args.email, name: args.name, rail }),
      });
      const order = data.order as Order;
      const next = data.next as { url?: string; passUrl?: string };
      // Older shops don't hand out claims; everything else still works.
      const claim = typeof data.claim === "string" ? data.claim : undefined;
      const what = `${order.items.map((i) => `${i.qty}× ${i.name}`).join(", ")}, ${money(order.totalCents, order.currency)}`;
      const keep = claim ? " Keep the claim: get_pickup_pass and order_status take it." : "";
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
          await cardFor(shop, order, { claim, rail }, pass),
        );
      }
      if (rail === "square" || rail === "card") {
        return reply(
          `Order ${order.id}: ${what}. Give the user this link to pay by card: ${next.url}. Once they've paid, the shop emails ` +
            `${args.email} the receipt and pickup pass.${keep}`,
          { shop, orderId: order.id, claim, total: money(order.totalCents, order.currency), items: order.items, payBy: "card", checkoutUrl: next.url, collectBy: order.collectBy },
          await cardFor(shop, order, { claim, rail, checkoutUrl: next.url }),
        );
      }
      return reply(
        `Order ${order.id}: ${what}. Confirm with the user, then call pay_order.${keep}`,
        { shop, orderId: order.id, claim, total: money(order.totalCents, order.currency), items: order.items, payUrl: next.url, collectBy: order.collectBy },
        await cardFor(shop, order, { claim, rail }),
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
      annotations: { title: "Check an order", readOnlyHint: true, openWorldHint: true },
      _meta: CARD_TOOL_META,
    },
    guarded(async (args: { order_id: string; claim?: string; shop_url?: string }) => {
      const shop = await shopFor(args.shop_url);
      const { order, checkoutUrl } = (await call(shop, `/api/orders/${encodeURIComponent(args.order_id)}`)) as { order: Order; checkoutUrl?: string };
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
        await cardFor(shop, order, { claim: args.claim, checkoutUrl }, pass),
      );
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
      annotations: { title: "Get the pickup pass", readOnlyHint: true, openWorldHint: true },
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
  server.registerResource(
    "share-agentpickup",
    SHARE_URI,
    {
      title: "Share agentPickup",
      description: "A QR and link for friends to add agentPickup to their assistant.",
      mimeType: CARD_MIME_TYPE,
      _meta: { ui: { prefersBorder: false } },
    },
    async () => ({
      contents: [{ uri: SHARE_URI, mimeType: CARD_MIME_TYPE, text: shareCardHtml(VERSION), _meta: { ui: { prefersBorder: false } } }],
    }),
  );
  server.registerResource(
    "share-agentpickup-earlier",
    new ResourceTemplate("ui://agentpickup/share-{version}.html", { list: undefined }),
    { title: "Share agentPickup", mimeType: CARD_MIME_TYPE, _meta: { ui: { prefersBorder: false } } },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: CARD_MIME_TYPE, text: shareCardHtml(VERSION), _meta: { ui: { prefersBorder: false } } }],
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
      annotations: { title: "Share agentPickup", readOnlyHint: true, openWorldHint: false },
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
              `then just asks for their usual${name ? ` at ${name}` : ""}. ${links.sharePageUrl} opens the phone's share sheet and has a sticker to print.`,
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
        "Start a group order (a lunch or coffee run) at a shop, when the user wants to order together with others now. Returns a code to " +
        "share: each person's agent joins with it and pays for their own items. When it closes, the shop gets one combined order " +
        "and the organiser is emailed its pickup QR. To share agentPickup itself with a friend, use share_agentpickup instead.",
      inputSchema: {
        organiser_name: z.string().min(1).max(60).describe("Who collects, shown to staff"),
        organiser_email: z.string().email().describe("Where the group's pickup QR goes"),
        title: z.string().max(60).optional().describe('e.g. "Friday coffee run"'),
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
        items: z.array(z.object({ id: z.string().describe("Item id from get_shop"), qty: z.number().int().min(1).max(20) })).min(1),
        email: z.string().email().describe("The user's email, for their receipt"),
        name: z.string().min(1).max(60).describe("The user's name, shown to staff on their items"),
        ...shopArg,
      },
      annotations: { title: "Join a group order", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    guarded(async (args: { code: string; items: { id: string; qty: number }[]; email: string; name: string; shop_url?: string }) => {
      const shop = await shopFor(args.shop_url);
      const { payments } = (await call(shop, "/api/catalog")) as { payments: { x402?: unknown; test?: boolean } };
      const rail = payments.x402 ? "x402" : payments.test ? "test" : null;
      if (!rail) throw new ToolError("This shop doesn't take agent payments.");
      const data = (await call(shop, `/api/groups/${encodeURIComponent(args.code)}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: args.items, email: args.email, name: args.name, rail }),
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
      annotations: { title: "Check a group order", readOnlyHint: true, openWorldHint: true },
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
