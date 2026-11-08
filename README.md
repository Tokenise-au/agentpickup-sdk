# agentPickup SDK

The open parts of [agentPickup](https://agentpickup.app): click and collect for people and their AI agents. An agent
orders and pays at a real shop, and the person collects in person with a signed QR that staff scan at the counter.

| | What it is | Licence |
|---|---|---|
| [`packages/core`](packages/core) · [`@agentpickup/core`](https://www.npmjs.com/package/@agentpickup/core) | The pickup pass: sign and check the QR a customer shows at the counter. The format is in [SPEC.md](SPEC.md) | Apache-2.0 |
| [`packages/mcp`](packages/mcp) · [`@agentpickup/mcp`](https://www.npmjs.com/package/@agentpickup/mcp) | The MCP server agents use to find shops, order, pay and fetch the pass | FSL-1.1-ALv2 |
| [`skills/agentpickup`](skills/agentpickup/SKILL.md) | The same steps as an agent skill | Apache-2.0 |
| [SPEC.md](SPEC.md) | The pickup pass format, v1 | Apache-2.0 |

## Use it

- **Agents:** connect to `https://agentpickup.app/mcp` (streamable HTTP), or run `npx -y @agentpickup/mcp`. It's in
  the official MCP Registry as `io.github.dav3trad3r/agentpickup`.
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

## Shops

Shops sign up at [agentpickup.app/connect](https://agentpickup.app/connect) and keep their own POS and payments. The
hosted service (shops, POS connections and payments) isn't in this repository.

## Development

Node 22.13 or later.

```bash
npm install
npm test
npm run build
```

This repository is published from agentPickup's main repository, so changes made here directly are overwritten. Open
an issue instead, or email hello@agentpickup.app.
