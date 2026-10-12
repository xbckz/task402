# Contributing to Task402

Task402 is a hosted, payment-aware MCP and REST service. Contributions should preserve deterministic outputs, bounded resource use, explicit payment terms, and safe retry behavior.

## Before opening a pull request

```powershell
npm ci
npm run typecheck
npm test
npm run deploy:dry-run
```

Keep examples runnable with public data. Never commit `.dev.vars`, wallet keys, facilitator credentials, operator passwords, document capabilities, recovery keys, or generated `.data` artifacts. Do not add a test that broadcasts a real payment.

For changes to a tool, update its REST schema, MCP definition, `/v1/pricing` metadata, agent documentation, and a focused test together. If a change affects payment amount, network, recipient, authorization, idempotency, or recovery semantics, document the compatibility impact before merging.

## Pull requests

Describe the user-facing behavior, the bounded limits, and the validation you ran. Keep unrelated generated files and deployment state out of commits. Security reports should follow [`SECURITY.md`](./SECURITY.md) rather than becoming public issues.
