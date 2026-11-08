# The agentPickup pickup pass, v1

Draft, November 2026. Feedback welcome: open an issue, or see the x402 proposal
[x402-foundation/x402#4142](https://github.com/x402-foundation/x402/issues/4142).

A pickup pass lets whoever presents it collect a paid order. The merchant issues it once the order is paid, by x402
or any other method. The customer shows it as a QR, and staff check it at the counter, offline if need be. It carries
no names, items or amounts, so a leaked screenshot gives nothing away.

## Token

A compact JWS ([RFC 7515](https://www.rfc-editor.org/rfc/rfc7515)) signed with Ed25519 (`"alg": "EdDSA"`,
[RFC 8037](https://www.rfc-editor.org/rfc/rfc8037)).

**Header**

```json
{ "alg": "EdDSA", "kid": "_Gmp2PH4" }
```

`kid` is the first 8 characters of the base64url SHA-256 hash of the public key's DER SubjectPublicKeyInfo.

**Payload**

| Claim | Type | Meaning |
|---|---|---|
| `v` | `1` | Format version |
| `oid` | string | The merchant's order id |
| `pid` | string | Pass id: random and single use. The handle the merchant redeems against |
| `exp` | number | Unix seconds. The order can't be collected after this |

```json
{ "v": 1, "oid": "ord_7HkQ2mXc9aRt", "pid": "Ya7qVHjkKI7bn4gU", "exp": 1793666330 }
```

Issuers shouldn't add personal data. Verifiers ignore claims they don't know.

## QR content

```
https://<shop>/c/<header>.<payload>.<signature>
```

A normal phone camera opens the merchant's pass page from it. Scanners also accept the bare token.

## Keys

The merchant publishes its public keys as a JWKS at `/.well-known/collect-keys.json`, under the shop's own address.
Each key is an Ed25519 JWK (`"kty": "OKP"`, `"crv": "Ed25519"`) with its `kid`, `"alg": "EdDSA"` and `"use": "sig"`.
A device that keeps a copy of the keys can check passes with no network.

## Checking a pass

1. Split the token into its three base64url parts and parse the header and payload as JSON. Otherwise: `malformed`.
2. Require `alg` `EdDSA`, `v` equal to `1`, and non-empty `oid` and `pid`. Otherwise: `malformed`.
3. Find the key whose `kid` matches the header's. None: `unknown_key`.
4. Check the Ed25519 signature over `<header>.<payload>`. Fails: `bad_signature`.
5. If `exp` is before now: `expired`.

Steps 1 to 5 work offline. Single use doesn't: redeeming a pass, so marking the order collected, happens on the
merchant's server in one atomic update, so two scanners can't both hand the same order over.

## Next to x402

The pass is issued after an x402 payment settles, and works alongside x402's offer-and-receipt extension: the receipt
proves the payment, and the pass gets the goods handed over. It also fits the auth-capture scheme: hold at order,
capture when the pass is scanned, void if it's never collected.

## Reference implementation

[`packages/core`](packages/core) (`@agentpickup/core`): `signPass`, `verifyPass`, `toJwks` and `extractToken`.
