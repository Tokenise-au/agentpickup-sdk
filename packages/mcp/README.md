# @agentpickup/mcp

An MCP server for [agentPickup](https://agentpickup.app): people order from real shops through their AI assistant and
collect in person. It lets the assistant find shops near its user, see what they sell, answer questions the menu
doesn't (dietary needs, allergies, hours, parking), order, and have the user pay by card on the shop's own checkout
(or pay in USDC over x402 from an agent wallet). The order lands on the shop's own POS, and the user collects with the
QR they show at the counter.

## Tools

| Tool | What it does |
|---|---|
| `find_shops` | Shops near a point (`lat`/`lng`), in a suburb (`place`) or selling something (`query`), from the agentPickup directory: each one's `shop_url`, address, hours, open now, distance and matching items |
| `get_shop` | Items and prices, the pickup location, whether it's open, its social accounts, and how the shop takes payment |
| `ask_about_shop` | Questions the menu doesn't answer: dietary needs and allergies, reviews, opening hours, where it is, parking, wait times, prices. Answers from what the shop has said, and says plainly what it hasn't. Send the question without names or personal details: the shop sees only which topics people ask about |
| `create_pickup_order` | Creates an order and returns a `claim` to keep with it. Needs the user's email, where the shop sends the receipt and pickup pass. A test shop marks it paid straight away, with no money moving. Where the shop takes cards, `payment: "card"` returns a checkout link for the user to pay on instead |
| `pay_order` | Pays the order's x402 link from your wallet and returns the pass link. With no wallet set up, returns the price and pay link instead. For a card order, returns its checkout link |
| `order_status` | Waiting for payment, paid, ready, collected or expired. With the order's `claim`, a paid order's pass comes back too |
| `get_pickup_pass` | Fetches the pass link, pickup code and QR again: with the order's `claim`, or by signing in as the paying wallet (Sign-In-With-X) |
| `start_group_order` | Starts a group order (a coffee run) with a closing time; returns the code to share and a key to close it early |
| `join_group_order` | Adds the user's items to a group order by its code; pay the share with `pay_order` before it closes |
| `group_order_status` | Who's in, what they ordered, who has paid, and whether the shop's order is ready or collected |
| `share_agentpickup` | A QR and link for friends to add agentPickup to their assistant (as a card where the chat shows cards), for everyone or with one shop picked |
| `close_group_order` | Closes a group order early, as its organiser; the shop gets one combined order and the organiser its QR |

## The pickup pass card

In chat apps that draw [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) cards (Claude and ChatGPT
among them), `create_pickup_order`, `order_status` and `get_pickup_pass` show the order as a card: a Pay button while
it's unpaid, then the QR and pickup code, kept up to date until it's collected. When the shop marks it ready, the QR's
tile turns lime. The card is one self-contained page (`ui://agentpickup/pass-<version>.html`) that loads nothing from
anywhere else. In apps without cards, the agent gives the user the pass link and pickup code. The shop emails the pass
either way. The card's "Invite a friend" link, and `share_agentpickup`'s own card, point at the add page
(`addPageUrl`, default https://agentpickup.app/add) so friends can add it too.

## Use it

Try it against the hosted demo shops first. The hosted server holds no wallet: its demo shops take a free test
payment, the Square sandbox's test card, or USDC from the user's own x402 wallet:

```json
{ "mcpServers": { "agentpickup": { "type": "http", "url": "https://agentpickup.app/mcp" } } }
```

Or run it locally against any agentPickup shop, with your own wallet:

```json
{
  "mcpServers": {
    "agentpickup": {
      "command": "npx",
      "args": ["-y", "@agentpickup/mcp"],
      "env": {
        "AGENTPICKUP_SHOP_URL": "https://orders.yourshop.com",
        "AGENTPICKUP_WALLET_KEY": "0x…",
        "AGENTPICKUP_MAX_PER_ORDER": "$25"
      }
    }
  }
}
```

| Setting | Default | |
|---|---|---|
| `AGENTPICKUP_SHOP_URL` | the demo shop | The shop to order from. Tool calls can also name another shop with `shop_url` |
| `AGENTPICKUP_WALLET_KEY` | none | The private key of a wallet used only for this, holding just the USDC you mean to spend: never your main wallet. Without it, `pay_order` only quotes |
| `AGENTPICKUP_MAX_PER_ORDER` | `$25` | The most the wallet pays for one order |
| `AGENTPICKUP_NETWORKS` | `eip155:84532` | Networks the wallet may pay on. Base Sepolia (test USDC) unless you add `eip155:8453` for Base mainnet |
| `AGENTPICKUP_DIRECTORY_URL` | `https://agentpickup.app/directory/v1/shops` | Where `find_shops` searches. `off` leaves the tool out |

Use a wallet that holds only what you're willing to let an agent spend. The tools tell the model to confirm
items and the total with the user before paying.

## Host it in your own server

```ts
import { createMcpHandler, walletPayer } from "@agentpickup/mcp";

const mcp = createMcpHandler({ shopUrl: "https://orders.yourshop.com" }); // no wallet: pay_order quotes
// `instructions` adds your own notes to what agents read on connecting, e.g. which of your shops take what.
app.all("/mcp", (c) => mcp(c.req.raw)); // Streamable HTTP, stateless, any Request/Response runtime
```

Node 22.13 or later. Licence: FSL-1.1-ALv2 (free to use and self-host; becomes Apache-2.0 two years after
each release).
