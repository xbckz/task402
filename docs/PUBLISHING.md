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

`server.json` is the public MCP Registry metadata, `glama.json` marks the repository for Glama discovery, and `lhm.plugin.json` is the reviewed LobeHub owner manifest generated from the live endpoint. Directory submission, publisher verification, and listing approval are external account actions; they cannot be completed by a repository commit alone. Before submitting, verify that the metadata URL, remote endpoint, tool count, pricing, limitations, and repository commit all match the live service.

The official Registry publisher is a standalone binary. On Windows, use `curl.exe` for the download because the PowerShell web cmdlet can terminate large GitHub release downloads before the archive is written:

```powershell
$arch = if ([Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq 'Arm64') { 'arm64' } else { 'amd64' }
$toolDir = Join-Path $env:TEMP 'mcp-publisher'
New-Item -ItemType Directory -Force $toolDir | Out-Null
curl.exe -L --fail --retry 4 --retry-delay 2 --retry-all-errors `
  --user-agent 'task402-publisher' `
  --output "$toolDir\mcp-publisher.tar.gz" `
  "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_$arch.tar.gz"
tar -xzf "$toolDir\mcp-publisher.tar.gz" -C $toolDir
$env:Path = "$toolDir;$env:Path"
& "$toolDir\mcp-publisher.exe" validate
```

The current metadata has been validated successfully. GitHub authentication can publish only `io.github.xbckz/*`; the existing `xyz.task402/*` namespace requires the domain publisher key. The private key is kept outside the repository at `%LOCALAPPDATA%\Task402\mcp-registry-private-key.dpapi`, encrypted with Windows DPAPI for the current user. Never commit or paste its decrypted value. The matching public proof is served by `/.well-known/mcp-registry-auth`.

To publish from this Windows account, decrypt the protected value in memory and pass it directly to the publisher. The command does not write the private key to a file or print it:

```powershell
$toolDir = Join-Path $env:TEMP 'mcp-publisher'
$protected = Join-Path $env:LOCALAPPDATA 'Task402\mcp-registry-private-key.dpapi'
$keySecure = (Get-Content -LiteralPath $protected -Raw).Trim() | ConvertTo-SecureString
$keyPtr = [IntPtr]::Zero
try {
  $keyPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($keySecure)
  $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPtr)
  & "$toolDir\mcp-publisher.exe" login http --domain task402.xyz --private-key $key
  & "$toolDir\mcp-publisher.exe" publish
} finally {
  if ($keyPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPtr) }
  Remove-Variable key -ErrorAction SilentlyContinue
}
```

If the protected file is lost, generate a new Ed25519 key, update the Worker’s `MCP_REGISTRY_AUTH_PUBLIC_KEY` variable, deploy, and then run the command above. The public proof must be live before `login http` is attempted. A domain key is different from a GitHub OAuth login; GitHub authentication cannot publish a `xyz.task402/*` name.

For Smithery, the repository and Worker deploy are only the source release. Sign in to the `martin00207/task402` listing, open **Releases**, and publish the current remote server. Then use **Settings → Verification → Check again**. Smithery scores the release's live `tools/list` response; a deploy by itself does not create a Smithery release. The canonical connector URL remains `https://task402.xyz/mcp`, while Smithery's generated gateway name is derived from the existing namespace and server ID.

The public machine-readable entry points are:

- `https://task402.xyz/mcp`
- `https://task402.xyz/server.json`
- `https://task402.xyz/v1/tools`
- `https://task402.xyz/v1/pricing`
- `https://task402.xyz/.well-known/mcp/server-card.json`
- `https://task402.xyz/.well-known/x402.json`

The prepared marketplace manifests are:

- `server.json` — Official MCP Registry (`xyz.task402/x402-docs`)
- `glama.json` — Glama repository ownership metadata
- `lhm.plugin.json` — LobeHub Marketplace owner declaration (`xbckz-task402`)

For LobeHub, the manifest was generated from the live `tools/list` response and includes all 20 tools, their input schemas, output schemas, annotations, the canonical `https://task402.xyz/mcp` endpoint, and the current `0.3.2` service release. Publish it with the LobeHub CLI only after authenticating and connecting the GitHub account that owns this repository:

```powershell
npx -y @lobehub/market-cli auth status --output json
npx -y @lobehub/market-cli github status
npx -y @lobehub/market-cli plugin publish https://github.com/xbckz/task402 --dir "$PWD"
```

The two status commands are read-only. `lhm login` and `lhm github connect` open a browser and require the account owner to complete OAuth. The publish command creates or updates the listing from the checked-in manifest; it does not replace the canonical MCP endpoint or change x402 pricing.

Keep the README, `server.json`, pricing response, and public docs synchronized whenever a tool, price, transport, or limitation changes. A directory listing improves discovery but does not guarantee agent traffic; publish a working example and a small reproducible workflow with each release.
