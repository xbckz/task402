# Distribution verification and website acceptance

Repository audit: 12 October 2026. These findings describe the checked-in source; they do not prove publication or current external catalog status.

## Discovery findings

- Fixed: the shared paid-tool executor forced Bazaar MCP challenges to advertise `transport: "http"`. It now uses the payment builder's `streamable-http` default for the canonical `/mcp` resource. The regression test checks the tool name, transport, MCP type, and official extension validation before any handler runs.
- Registry metadata, MCP initialization, and the public server card describe release `0.3.1`. The npm package version describes the application package and is not evidence of a Registry release. Read the live Registry record before reporting a published version.
- Fixed: the public server card now carries complete JSON Schema input contracts for the published MCP tools, including property types, required fields, array item schemas, and bounds. MCP `tools/list` remains authoritative if a future schema change is not mirrored here.
- `/v1/tools` currently provides tasks, billing, and interfaces rather than executable input schemas. Direct agents should follow `/openapi.json` for REST or MCP `tools/list` for MCP. Keep these links visible beside the catalog.
- Fixed: Bazaar MCP challenges now include the complete paid-tool input schemas, including `idempotency_key`, optional selectors, and bounded chain/web fields. The executable server card and payment metadata are covered by regression checks; keep both surfaces synchronized when adding tools.
- Fixed: the public MCP quickstart and agent guide now list the available PDF, web, OpenAPI, and Base read-only tool groups. Keep directory descriptions synchronized when the surface changes.
- Static directory metadata and copied prices can drift from deployed configuration. Use `/v1/pricing` as the price authority in listings; record a date with any manually verified external status.

## Evidence required before claiming distribution

| Channel | Evidence to retain | What it establishes |
| --- | --- | --- |
| Public discovery | Successful credential-free GETs for docs, pricing, tool catalog, OpenAPI, llms, and server card | A crawler can learn the service contract |
| MCP connectivity | Successful initialize and tools/list through an official Streamable HTTP client | A compatible MCP host can connect and inspect tools |
| Official Registry | Live record with the exact namespace, release version, and remote URL | That Registry release is published |
| Bazaar | Live facilitator discovery response matching the exact resource, MCP tool name, transport, network, and payee | The particular paid capability is cataloged |
| Glama / Smithery | Public accepted listing URL, tested setup, and dated review | The listing is visible in that directory |
| Adoption | Real successful paid calls and repeat usage, separated from discovery requests | Users are using the service |

Read every page of a paginated catalog before concluding a resource is absent. A 402 challenge containing metadata proves the advertisement exists; it does not prove a facilitator indexed it. Any settlement used to trigger indexing is a real payment and should use the existing explicitly approved wallet workflow.

## Website quality review plan

Keep the existing service routes, tool names, configured prices, payment behavior, capability requirements, and limits. Use the requested reference for the visual direction while expressing Task402's evidence workflow and precise pricing.

Review the homepage, pricing, docs, demo, and all three use-case pages in one desktop/mobile batch. Use widths around 1440px and 390px, and check the 320px minimum layout separately for overflow. Follow every primary action, operate navigation and copy controls with a keyboard, and verify visible focus, contrast, reduced motion, and long endpoint/code wrapping. Compare rendered content with `/v1/pricing`, `/openapi.json`, and MCP tool discovery.

| Criterion | Points | Evidence |
| --- | ---: | --- |
| Reference-aligned visual direction | 20 | Clear typography, intentional depth and lighting, restrained palette, coherent components |
| Hierarchy and first-call clarity | 20 | First viewport explains outcome and presents an obvious docs/connect action |
| Responsive layout | 15 | No clipped primary content or page-wide overflow; usable tables and examples |
| Accessibility | 15 | Keyboard access, visible focus, readable contrast, reduced-motion support |
| Product truth and preservation | 15 | Existing routes, prices, limits, paid/included distinctions, and capability requirements remain accurate |
| Documentation conversion | 10 | Concrete discovery, connection, payment, and recovery steps; copyable examples |
| Performance | 5 | No unnecessary client framework, layout shifts, blocking third-party dependency, or oversized visual assets |

Acceptance: at least 85/100, with no broken route, invented availability claim, incorrect price, mobile content loss, or inaccessible primary action. Fix the findings together, run one confirmation batch, and record the remaining limitations with the delivered result. A source-only review cannot award a visual score; use rendered desktop and mobile evidence.
