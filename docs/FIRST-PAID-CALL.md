# First paid call

This is the shortest safe path for an agent or operator to make one paid Task402 call. It uses the hosted MCP endpoint, keeps the payment signer outside the service, and never puts a private key in the repository.

## Discover before paying

```powershell
curl.exe https://task402.xyz/v1/pricing
curl.exe https://task402.xyz/.well-known/x402.json
```

The response is the source of truth for the current network, USDC contract, recipient, amount, resource URL, and timeout. A client should inspect these fields and apply its own payment policy before signing.

For MCP clients, connect to `https://task402.xyz/mcp`, call `initialize`, then `tools/list`. The service is discoverable without payment. Start with `generate_pdf`, `web_evidence`, or one of the OpenAPI and Base read tools.

## Challenge and retry

Call the selected tool without payment first. A paid tool returns a structured x402 v2 challenge. The client must:

1. Verify the challenge matches the current pricing policy and expected resource.
2. Ask an external wallet, hardware signer, HSM, or wallet service to approve and sign the exact terms.
3. Retry the identical tool input with the signed payload in `params._meta["x402/payment"]`.
4. Save the returned settlement receipt and capability without logging either secret.

The hosted service does not receive a private key and does not sign for the caller. A client must never change the amount, network, asset, recipient, resource, or idempotency key between the challenge and retry.

## Safe smoke test

For a terminal reproduction of the MCP flow, follow [`TEST-TRANSACTION.md`](./TEST-TRANSACTION.md) and run `npm run test:agent` with a disposable wallet. The helper validates Base mainnet, Base USDC, the live recipient, and the expected amount before signing. It prints public identifiers only.

For a REST-only generation flow, the same sequence is documented in the [API quickstart](https://task402.xyz/docs#first-paid-call): request an unsigned `402`, approve the exact challenge externally, then retry with `PAYMENT-SIGNATURE` and the same `Idempotency-Key`.

## After payment

Generation returns a job capability. Use it only with the returned status and download URLs. Document indexing returns a separate document capability and recovery key flow. Retrieval, citation, comparison, and validation calls are included after indexing; they still require the capability and expire with the document.

If the facilitator reports an uncertain settlement, stop and reconcile the job, facilitator, and chain status. Do not submit a new payment automatically. See [`AGENT-GUIDE.md`](./AGENT-GUIDE.md) for retry and recovery rules.
