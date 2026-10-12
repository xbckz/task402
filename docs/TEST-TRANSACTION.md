# One controlled x402 test transaction

This procedure uses one small live Base USDC payment for a generated PDF. Never put a private key, seed phrase, capability, recovery key, or signed payload in this repository or chat. Use a separate wallet or hardware signer with only the amount needed for the test.

## 1. Read the live contract

```powershell
curl.exe https://task402.xyz/v1/pricing
```

Confirm the response still says `paymentProtocol: "x402-v2"`, network `eip155:8453`, USDC as the asset, the intended recipient, and the current atomic amount.

For Base mainnet USDC, the EIP-712 domain name is `USD Coin` and the domain version is `2`. `USDC` is the token symbol; do not substitute it for the signing-domain name.

## 2. Request an unsigned challenge

Keep the request body and idempotency key unchanged for the retry:

```powershell
$body = @{ title = "Task402 live test"; markdown = "# Paid smoke test`n`nThis is one controlled transaction." } | ConvertTo-Json -Compress
$key = "live-test-$(Get-Date -Format yyyyMMddHHmmss)-$([guid]::NewGuid())"
curl.exe -i https://task402.xyz/v1/pdf `
  -X POST -H "Content-Type: application/json" `
  -H "Idempotency-Key: $key" `
  --data-raw $body
```

The response should be `402` and contain the x402 v2 requirements. An unsigned challenge does not move funds.

## 3. Approve and sign externally

Have the wallet signer validate the exact amount, Base network, USDC contract, recipient, resource URL, timeout, and nonce from the challenge. Sign the payload externally. Do not let a script invent payment terms or silently retry.

## 4. Retry exactly once

Send the identical JSON body and idempotency key with the signer-produced `PAYMENT-SIGNATURE` value. The value is a base64-encoded JSON x402 payload when using this REST endpoint. A successful response should be `201`, include a completed job and capability, and include a settlement receipt.

Use the returned capability only with its status/download URLs. Do not log it.

## 5. Verify and recover safely

- Download the PDF with the returned capability and confirm it opens.
- Check the settlement transaction on Base and in the facilitator response.
- Repeat the exact request only to test idempotent recovery; it should return `200` without another settlement.
- If the result is ambiguous or times out, inspect the job and facilitator/chain status before doing anything else. Never create a new payment authorization automatically.
- Check `/admin` or the protected stats endpoint and confirm one paid call and one settlement amount.

The repository example at [`examples/agent-flow.ts`](../examples/agent-flow.ts) intentionally stops at the unsigned challenge, so it is safe to run before this controlled test.

## Terminal helper

For the simplest local test, use a separate wallet containing only the amount you intend to spend. The guarded helper uses the official x402 EVM client, checks the live challenge before signing, requires an explicit confirmation flag, downloads the returned PDF, and never prints the signed payload or capability.

In PowerShell, from the repository directory:

```powershell
$env:EVM_PRIVATE_KEY = Read-Host "Paste the disposable test wallet private key"
$env:TASK402_CONFIRM = "YES"
npm run test:live
Remove-Item Env:EVM_PRIVATE_KEY, Env:TASK402_CONFIRM
```

The script will refuse a challenge unless it is exactly Base Mainnet, Base USDC, `10000` atomic units, and the configured recipient. The configured recipient may equal the payer for this registered-wallet smoke test; in that case the transfer is directed back to the same wallet. It writes the verified PDF to `out/task402-live-test.pdf` and prints only the public payer address, job ID, settlement transaction, and artifact size. Never put the key in a command-line argument, repository file, shell history, or chat. If the command fails after signing, do not rerun with a new key or idempotency key until the job and settlement status have been reconciled.

If the live facilitator returns `address_not_registered`, the payer signature was received but no funds moved. OpenX402 whitelists the server's `payTo` recipient; registration must be performed by the wallet controlling that recipient, not by the payer wallet. Confirm the current registration fee and terms on the [OpenX402 registration screen](https://openx402.ai/) before approving anything.

If the facilitator returns `settlement_pending`, the Worker retries the identical settlement payload once so the facilitator can reconcile its broadcast transaction. A timeout or malformed response without a transaction hash remains `payment_recovery_pending`; reconcile the job and chain before submitting another payment.

## Exact agent-style MCP test

Run `npm run test:agent` with the same environment setup to exercise the same sequence as an MCP agent. It initializes `https://task402.xyz/mcp`, lists tools, calls `generate_pdf` without payment, reads the structured x402 challenge, creates the signed payment payload through the official EVM client, retries `generate_pdf` with `_meta["x402/payment"]`, calls `get_pdf_job`, and downloads the PDF. This is the closest terminal reproduction of an agent call; it does not use the REST payment header.
