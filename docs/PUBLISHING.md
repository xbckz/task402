# Publishing and directory distribution

This repository is the source of truth for the Task402 Worker, local runtime, parser Container, tests, and public MCP metadata.

## GitHub release

From a clean checkout with GitHub authentication already configured:

```powershell
git add -A
git diff --cached --check
git commit -m "Publish Task402 agent evidence service"
git branch -M main
git remote add origin https://github.com/xbckz/task402.git # omit if already configured
git push -u origin main
```

Run `npm run typecheck`, `npm test`, and `npm run deploy:dry-run` before pushing. The included GitHub Actions workflow repeats those checks for every pull request and push to `main`.

## Hosted release

The public Worker is deployed separately from GitHub. After a source release, deploy with the account that owns the configured Cloudflare bindings:

```powershell
npx wrangler deploy
```

Confirm the live MCP endpoint, pricing document, well-known metadata, and health response:

```powershell
curl.exe -I https://task402.xyz/mcp
curl.exe https://task402.xyz/v1/pricing
curl.exe https://task402.xyz/.well-known/x402.json
curl.exe https://task402.xyz/healthz
```

Do not commit `.dev.vars`, wallet keys, stats passwords, Cloudflare tokens, facilitator credentials, parser Container tokens, or signed payment payloads. Use Wrangler secrets and the Cloudflare dashboard for those values.

## MCP directories

`server.json` is the public MCP Registry metadata and `glama.json` marks the repository for Glama discovery. Directory submission, publisher verification, and listing approval are external account actions; they cannot be completed by a repository commit alone. Before submitting, verify that the metadata URL, remote endpoint, tool count, pricing, limitations, and repository commit all match the live service.

For Smithery, the repository and Worker deploy are only the source release. Sign in to the `martin00207/task402` listing, open **Releases**, and publish the current remote server. Then use **Settings → Verification → Check again**. Smithery scores the release's live `tools/list` response; a deploy by itself does not create a Smithery release. The canonical connector URL remains `https://task402.xyz/mcp`, while Smithery's generated gateway name is derived from the existing namespace and server ID.

The public machine-readable entry points are:

- `https://task402.xyz/mcp`
- `https://task402.xyz/server.json`
- `https://task402.xyz/v1/tools`
- `https://task402.xyz/v1/pricing`
- `https://task402.xyz/.well-known/mcp/server-card.json`
- `https://task402.xyz/.well-known/x402.json`

Keep the README, `server.json`, pricing response, and public docs synchronized whenever a tool, price, transport, or limitation changes. A directory listing improves discovery but does not guarantee agent traffic; publish a working example and a small reproducible workflow with each release.
