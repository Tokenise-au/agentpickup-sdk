---
name: agentpickup
description: Order and pay for things to collect in person at real shops (cafés, restaurants, retail click and collect) through agentPickup, and hand the user the QR pickup pass. Use when the user wants food, coffee or goods ready to pick up at a shop, asks to order ahead for collection, or mentions agentPickup.
---

# agentPickup

agentPickup shops take orders from AI agents. You order and pay for the user, the order appears on the shop's own screens, and the user collects in person by showing a signed QR at the counter.

## Choose how to connect

- **The agentPickup MCP tools are available** (`find_shops`, `get_shop`, `create_pickup_order`, `pay_order`, `order_status`, `get_pickup_pass` and the group-order tools): use them. They cover every step below.
- **They aren't:** use the HTTP routes below. Paying from a wallet needs an x402 client, such as Coinbase's agent wallet. Without one, use card checkout and give the user the link to pay on.

## Order for the user

1. **Find a shop.** `GET https://agentpickup.app/directory/v1/shops` with `q` (what the user wants), `place` (a suburb), or `lat` and `lng` with an optional `radius_km`. Add `open_now=true` for shops open now. Each result's `url` is the shop's address, written `{shop}` below.
2. **Read the menu.** `GET {shop}/api/catalog` gives item ids and prices, the pickup location, and how the shop takes payment (`payments.x402`, `payments.square`, `payments.test`).
3. **Confirm with the user.** Show the items, the total and where to collect. Wait for a clear yes before paying.
4. **Pay** in one of three ways:
   - **From the user's agent wallet** (x402, USDC on Base), where `payments.x402` is set: `GET {shop}/api/x402/order?items={id}:{qty},...` answers 402 with the price. Pay it with the x402 client, and the response carries the order and the pickup pass. To have the QR emailed too, `POST` to the same address with `{"items": [{"id": "...", "qty": 1}], "email": "..."}`.
   - **By card, paid by the user**, where `payments.square` is set: `POST {shop}/api/orders` with `{"items": [...], "email": "...", "rail": "square"}`, then give the user `next.url`, the shop's checkout page (card, Apple Pay or Google Pay).
   - **Free, to try the whole flow**, where `payments.test` is set: `POST {shop}/api/orders` with `{"items": [...], "email": "...", "rail": "test"}`. The order is marked paid with no money moving, and the response carries the pass link. With the MCP tools, `create_pickup_order` with `payment: "test"`.
5. **Hand over the pass.** Give the user the pass link and pickup code, and say where and by when to collect. `GET {shop}/api/orders/{id}` reports whether the order is paid, ready or collected.

## Group orders

For a coffee run with the MCP tools: `start_group_order` gives a code to share; each person's agent calls `join_group_order` and pays its share with `pay_order`; at closing time the shop gets one combined order and the organiser gets its QR. `group_order_status` shows who's in, and `close_group_order` closes it early.

## Rules

- Never pay before the user agrees to the items and the total.
- Prices come from the shop's menu. Never calculate or send a price yourself.
- The pickup QR works like a ticket: whoever holds it can collect. Give it only to the user.
- To try it for free, use a test payment at any shop with `payments.test` set. The Demo Café at https://agentpickup.app takes real USDC on Base, and the Demo Café on the test network, https://agentpickup.app/v/demo-cafe-testnet, takes testnet USDC on Base Sepolia. Neither makes anything.
- Standard x402 clients cap each payment at $1. Raise the cap for real orders, within the limit the user set.
- If nobody collects in time, card payments are refunded. Whether USDC is paid back depends on the shop.

## More

- Step-by-step guide: https://agentpickup.app/AGENTS.md
- Short index: https://agentpickup.app/llms.txt
- A shop's API: `{shop}/openapi.json`
