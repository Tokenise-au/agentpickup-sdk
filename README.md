# agentPickup SDK

[agentPickup](https://agentpickup.app) is the commerce and fulfilment infrastructure that lets AI agents buy from
physical businesses. Agents find businesses, read their catalogues, ask questions and place orders. The customer pays
on the business's own checkout, or the agent pays directly. The order arrives in the system the business already runs,
and the customer collects in person with a signed QR. It works in any industry and with any point of sale, and the
money goes straight to the business.

It has three parts:

- **Discovery and ordering for agents:** a public directory, each business's catalogue, and ordering and checkout over
  MCP (Claude, ChatGPT, Grok), x402, MPP, UCP and ACP.
- **The business's own systems:** orders land on its point of sale next to its other orders (Square today, more
  systems on the way), or on the agentPickup dashboard for a business with no POS.
- **Verified collection:** a signed pickup pass that staff scan, which anyone can check offline against the business's
  published keys.

**For businesses:** connect your point of sale, or start with no POS, and AI agents can order from you. Your staff
work as they do now, and the money goes straight to you. A dashboard shows your sales and what
people ask their assistants near you: searches, dietary needs and allergies, and questions about your shop. Sign up at
[agentpickup.app/connect](https://agentpickup.app/connect).

**For people:** add agentPickup to your assistant at [agentpickup.app/add](https://agentpickup.app/add), then ask for
what you want.

**For agents and developers:** this repository holds the open parts. The hosted service (shops, POS connections,
payments, the dashboard) runs at agentpickup.app and isn't published as a package.

| | What it is | Licence |
|---|---|---|
| [`packages/core`](packages/core) · [`@agentpickup/core`](https://www.npmjs.com/package/@agentpickup/core) | The pickup pass: sign and check the QR a customer shows at the counter (Ed25519). The format is in [SPEC.md](SPEC.md) | Apache-2.0 |
| [`packages/mcp`](packages/mcp) · [`@agentpickup/mcp`](https://www.npmjs.com/package/@agentpickup/mcp) | The MCP server assistants use to find businesses, read their catalogues, ask about one, order (now or for later), pay, cancel, fetch the pass, and run group orders | FSL-1.1-ALv2 |
| [`skills/agentpickup`](skills/agentpickup/SKILL.md) | The same steps as an agent skill | Apache-2.0 |
| [SPEC.md](SPEC.md) | The pickup pass format, v1 | Apache-2.0 |

## Use it

- **Assistants:** connect to `https://agentpickup.app/mcp` (streamable HTTP), or run `npx -y @agentpickup/mcp`. It's in
  the official MCP Registry as `io.github.dav3trad3r/agentpickup`. Connector directories that don't take crypto use
  `https://agentpickup.app/mcp/cards`: cards and test payments only, paid on the shop's own checkout.
- **Agents that use skills:** `npx skills add Tokenise-au/agentpickup-sdk`.
- **Guides for agents:** [AGENTS.md](https://agentpickup.app/AGENTS.md) and [llms.txt](https://agentpickup.app/llms.txt).
- **Checking a pass:**

```ts
import { loadSigningKey, generateSigningKeyPem, signPass, verifyPass, toJwks } from "@agentpickup/core";

const key = loadSigningKey(generateSigningKeyPem());
const token = signPass({ v: 1, oid: "ord_123", pid: "pas_456", exp: Math.floor(Date.now() / 1000) + 7200 }, key);
verifyPass(token, [key]); // { ok: true, claims } or { ok: false, reason: "malformed" | "unknown_key" | "bad_signature" | "expired" }
toJwks([key]);            // what a shop publishes at /.well-known/collect-keys.json
```

## How a shop is paid

Card payments go through the shop's own POS account, so the money never passes through agentPickup. Where a shop adds
a wallet, agents can also pay in USDC over [x402](https://x402.org), straight to the shop's wallet. Each order's QR is
signed by the shop's key, and staff scan it (or mark the order in their POS) when it's collected.

## Development

Node 22.13 or later.

```bash
npm install
npm test
npm run build
```

This repository is published from agentPickup's main repository, so changes made here directly are overwritten. Open
an issue instead, or email hello@agentpickup.app.
