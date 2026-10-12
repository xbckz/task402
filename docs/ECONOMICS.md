**Document-tool platform: cost and revenue scenarios**

Prepared 9 October 2026. All amounts are USD per month unless stated otherwise. These are conditional calculations using current public rates and explicitly invented workloads and selling prices. They are not demand forecasts, measured performance, or confirmed customer willingness to pay. The application was not changed.

**Scope and definitions**

The 68-capability roadmap can share parsers, rendering, private storage, queues, evidence, and billing. Enabling a capability does not mean paying for it on every job. Actual usage determines OCR, model, audio, rendering, and storage costs. This model represents recurring PDF workloads through four bounded job classes; it does not pretend to price every document type with one average request. Signature certificates, commercial engine licenses, enterprise support contracts, transcription, translation, and unusual jobs need separate quotes or measured cost inputs. A software allowance is a budget reserve, not proof that every license fits it.

One job means one successfully paid operation or explicitly bounded bundle, not one HTTP request, one agent, or one whole document of arbitrary size. A job can involve multiple HTTP calls. Repeated cached reads are counted separately here. A customer can run many agents, and an agent can run many jobs. Revenue counts only successful paid jobs, not free inspections, discovery, unpaid traffic, or MCP tool listings.

Direct service cost includes the $5 Workers plan, estimated metered infrastructure, OCR/model usage, a processing-overhead allowance, and settlement. Cash surplus before labor subtracts direct costs, a 3% credits/refunds reserve, software allowance, and marketing. Operating result also subtracts a budget for maintenance/support labor. If the founder supplies that labor unpaid, the cash surplus may remain in the bank, but the work still has an economic cost. Neither column is take-home pay. Initial development, financing, income tax, VAT/sales tax, and optional fiat conversion/withdrawal costs are excluded. Prices and revenue are modeled net of any tax collected for authorities.

**Verified rate card**

| Component | Public rate used | Official source |
| --- | --- | --- |
| Workers | $5 base; 10M requests and 30M CPU-ms included; overages $0.30/M requests and $0.02/M CPU-ms | [Workers](https://developers.cloudflare.com/workers/platform/pricing/) |
| Containers | 375 vCPU-min, 25 GiB-h memory, 200 GB-h disk included; then $0.000020/vCPU-s, $0.0000025/GiB-s, $0.00000007/GB-s | [Containers](https://developers.cloudflare.com/containers/platform/pricing/) |
| Container egress | North America/Europe: first 1 TB included, then $0.025/GB | [Containers](https://developers.cloudflare.com/containers/platform/pricing/) |
| Browser Run | 10 browser hours included, then $0.09/hour; session concurrency is separate | [Browser Run](https://developers.cloudflare.com/browser-run/pricing/) |
| R2 Standard | 10 GB-month, 1M writes, 10M reads included; then $0.015/GB-month, $4.50/M writes, $0.36/M reads; free R2 egress | [R2](https://developers.cloudflare.com/r2/pricing/) |
| D1 | 25B rows read, 50M rows written, 5 GB included; excess $0.001/M reads, $1/M writes, $0.75/GB-month | [D1](https://developers.cloudflare.com/d1/platform/pricing/) |
| Queues | 1M operations included, then $0.40/M; typically three operations per small delivered message | [Queues](https://developers.cloudflare.com/queues/platform/pricing/) |
| OCR 4.1 | $4 per 1,000 uncached pages; no batch/cache discount assumed | [Mistral](https://docs.mistral.ai/inference/pricing) |
| Mistral Medium 3.5 | $1.50/M input tokens and $7.50/M output tokens; an illustrative advanced-workflow backend | [Mistral](https://docs.mistral.ai/inference/pricing) |
| CDP facilitator | First 1,000 onchain transactions free, then $0.001 each; exact EVM payment modeled as one transaction | [CDP](https://docs.cdp.coinbase.com/x402/seller/facilitator) |

Included allocations are assumed available to this project; they are account-wide and other projects may consume them. Container memory/disk are provisioned-resource charges while CPU is active-use based. R2 rounds billable units up; the model applies that rounding. Browser duration rounds to the nearest hour. No paid session concurrency above the included 10 is assumed; add $2 per extra monthly-average daily-peak browser if using Sessions. Quick Actions do not have that concurrency fee. Queue payloads are handles smaller than 64 KB, not entire PDFs. D1 assumptions are 200 rows read, 20 written, and 5 KB retained metadata per successful job, before 10% processing overhead. Document text and search indexes beyond these assumptions need additional storage or the software allowance.

The container cost assumes a standard-2 instance with 6 GiB memory and 12 GB disk. The modeled allocation includes twice the job wall time for startup/idle, plus processing overhead. It is not a measured cold-start or utilization guarantee. Long idle containers, large decompressed PDFs, more expensive engines, peak capacity, and long retention can raise costs. Deployment compatibility, throughput, and provider quotas still need validation.

**Suggested test prices and job assumptions**

| Job class | Hypothetical sale | Provider work | Runtime allowance |
| --- | --- | --- | --- |
| Cached read/search bundle | $0.005 | No new OCR or model call; existing document available | 5 HTTP calls; 100 Worker CPU-ms total |
| Native/generation, up to 10 pages | $0.03 | No OCR/model; processing and generation budget | 20 active CPU-s; 40 container wall-s; 20 browser-s |
| OCR job, 10 OCR pages | $0.15 | 10 x $0.004 = $0.04 OCR before overhead | 10 CPU-s; 20 container wall-s |
| Advanced 20-page workflow | $0.60 | 10 OCR pages plus 20k input / 3k output tokens = $0.0925 provider work | 90 CPU-s; 120 container wall-s; 30 browser-s |

Advanced work represents one bounded schema, comparison, or evidence workflow; it is not unlimited model reasoning or a guarantee that the chosen model is accurate enough. Its output-token allowance must include any separately billable reasoning tokens; additional visual/image calls are outside this particular recipe. Native/generation is a shared budget class rather than a claim that every native parse needs rendering. Each new processing job retains an assumed 5 MB (native), 10 MB (OCR), or 20 MB (advanced) of source and derived data for 30 days. Storage uses a steady-state rolling retention window. Provider and compute work get 10% extra allocation for failed attempts/retries/reprocessing, while a separate 3% of sales is reserved for customer credits/refunds. These are scenario buffers, not observed failure rates. The model does not include the customer's own agent-model bill.

**Four balanced-volume scenarios**

Balanced usage is 55% cached reads, 25% native/generation, 15% OCR, and 5% advanced workflows. This produces an assumed average sale of $0.06275 per paid job, or $62.75 for 1,000 mixed jobs. Labor is valued at an assumed $40/hour, not a researched wage quote.

| Stage | Paid jobs | Revenue | Direct service cost | Software + marketing | Labor budget | Cash before labor | Operating result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Pilot | 1,000 | $63 | $17 | $100 | $800 | -$56 | -$856 |
| Small | 10,000 | $628 | $141 | $250 | $1,600 | $218 | -$1,382 |
| Growing | 100,000 | $6,275 | $1,389 | $1,500 | $4,000 | $3,197 | -$803 |
| Busy | 1,000,000 | $62,750 | $13,999 | $9,500 | $20,000 | $37,369 | $17,369 |

Cash and operating results also deduct the 3% credits reserve, which is not shown as a separate table column. Software/marketing and labor budgets are independent assumptions for each stage, not vendor minimums or automatic volume-based charges. Pilot through busy stages allocate 20, 40, 100, and 500 maintenance/support hours per month. The busy stage includes $7,500 marketing; this is a spending scenario, not an established acquisition channel.

**The same 100,000 jobs with different demand**

| Workload | Read/native/OCR/advanced | Average sale | Revenue | Direct service cost | Operating result |
| --- | --- | --- | --- | --- | --- |
| Cheap-heavy | 90% / 8% / 2% / 0% | $0.0099 | $990 | $212 | -$4,752 |
| Balanced | 55% / 25% / 15% / 5% | $0.0628 | $6,275 | $1,389 | -$803 |
| Premium-heavy | 20% / 20% / 35% / 25% | $0.2095 | $20,950 | $4,468 | $10,353 |

Each row uses the same $500 software, $1,000 marketing, and $4,000 labor budgets plus credits. Premium-heavy demand is not a probability or expected outcome: it requires customers to value and buy the advanced service. Cheap tools compete with local parsers and inexpensive APIs. More usage does not automatically mean a more valuable business.

**What changes the result at 100,000 balanced jobs**

| Change | Revenue | Direct service cost | Operating result |
| --- | --- | --- | --- |
| Baseline | $6,275 | $1,389 | -$803 |
| Selling prices -50% | $3,138 | $1,389 | -$3,846 |
| OCR/model cost x3 | $6,275 | $3,727 | -$3,140 |
| Unbilled processing overhead +50% | $6,275 | $1,854 | -$1,267 |
| Lean founder operation | $6,275 | $1,389 | $2,997 |
| One payment per 10 jobs | $6,275 | $1,299 | -$713 |

The lean-founder row budgets $100 software, no paid acquisition, and 40 labor hours ($1,600). It assumes low support demand and efficient maintenance; it does not establish that all 68 capabilities can actually be supported in 40 hours. The bundled-payment row is a hypothetical prepaid bundle or separately implemented batching flow; the current MVP supports fixed exact payments, not this optimization. New CDP batching support does not mean it is already integrated here. Additional channel deposits/refunds/withdrawals can incur onchain transaction fees too.

**Break-even paid jobs per month**

Monthly overhead here combines software, maintenance/support labor, and marketing into one fixed amount. It is held constant while finding the threshold. Service costs and the credits reserve still scale with usage. Real staffing and acquisition costs can increase as volume rises.

| Workload | $100 fixed overhead | $3,000 fixed overhead | $5,500 fixed overhead |
| --- | --- | --- | --- |
| Cheap-heavy | 13,665 | 400,105 | 733,937 |
| Balanced | 2,185 | 63,823 | 117,065 |
| Premium-heavy | 652 | 18,919 | 34,702 |

**Flat-price failure example**

At a $0.01 flat price, a 10-page uncached OCR job costs $0.04 in OCR alone. At 100,000 such jobs, sales are $1,000 and OCR is $4,000 before retries, settlement, compute, refunds, or staff. A 100-page OCR document costs $0.40 before those extras. Per-page limits and quotes are essential. The current MVP's default $0.01 generator price must not be inherited by arbitrary OCR, translation, chart reading, or model-analysis jobs.

At the listed facilitator rate, $0.001 settlement is 20% of a $0.005 sale, 10% of a $0.01 sale, and 1% of a $0.10 sale after the free tier. A prepaid bundle or supported batch settlement may improve cheap-read economics. It does not turn provider compute into free work or eliminate channel-management overhead.

**Other roadmap services need their own units**

Audio transcription has a different unit from PDF pages: Mistral currently lists Voxtral Mini Transcribe 2 at $0.003/minute. A 30-minute recording is $0.09 provider work before retries, storage, and payment. Translation and visual interpretation need model-token/image budgets; high-resolution rendering and compression need CPU/memory budgets. Digital signing needs a signing/certificate integration, while validation can need trust/revocation services. Commercial PDF libraries and enterprise document APIs can have minimums or quote-based licenses. Charge these through separately bounded jobs and add their actual costs; the PDF averages above cannot cover unlimited use of all of them.

**Build cost is separate from runtime**

A $5 platform subscription does not pay for implementing or maintaining the product. As a deliberately broad planning allowance, a focused production release could take 300-800 human engineering/QA hours; the full 68-capability roadmap with robust validation and operations could take 2,000-5,000 hours. At assumed labor rates of $40-$80/hour, that is $12,000-$64,000 and $80,000-$400,000 respectively. These are the author's scope estimates, not sourced contractor bids, measured AI productivity, or a promise about calendar time. Specialized signing/redaction/accessibility requirements, licenses, security review, corpus creation, and enterprise expectations can increase them.

If you and coding agents do the work, cash outlay can be much lower than outsourced development, but the time and verification effort remain. Coding-agent subscriptions/API usage are not estimated without measured sessions and account pricing. Recovering an illustrative $100,000 build investment over 24 months adds $4,167/month to the required surplus. The operating tables exclude this recovery charge. They also exclude new feature expansion beyond the stated ongoing labor budget.

**Decision**

With zero demand, revenue is zero. A sleeping on-demand deployment can retain a $5 base platform charge, but the pilot's $100 software allowance and 20 maintenance hours make its modeled cash expense $105/month and economic expense $905/month even before new development. Keeping every premium provider or commercial library contracted can add fixed costs; those must be quoted rather than inferred from usage rates.

The compute economics can be attractive with capped jobs and appropriate prices. The balanced 100,000-job case is still around break-even after the selected business budgets; the cheap-heavy case cannot support the same operation, while premium-heavy demand could. Start by proving repeat use and willingness to pay for a few workflows, then expand the catalog. Treat distribution, customer support, and correctness as real costs. Availability in an agent marketplace is not evidence of future paid demand.

[`ECONOMICS-SCENARIOS.json`](./ECONOMICS-SCENARIOS.json) contains the full breakdown and inputs. Rates were checked on 9 October 2026; the tables are maintained as planning assumptions rather than generated billing data. All costs are estimates based on these assumptions, not a Cloudflare or provider invoice.
