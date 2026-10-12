**Agent document services: PDF roadmap and research**

Prepared 9 October 2026. This is a proposed roadmap, not a list of implemented features. The running Desktop MVP currently generates PDFs from Markdown through REST and MCP. This research adds planning documents only.

**Recommendation**

Expand from PDF generation into a document service that lets an agent ingest once, inspect what is available, search for relevant evidence, and retrieve small source-grounded results. Keep expensive OCR, visual interpretation, and full-document reasoning optional. The first commercial hypothesis to test is that this reduces the cost of completing a document task while preserving correctness.

There are two customer groups: agents that have no dependable local document runtime, and agents that need repeated access to the same documents across sessions or machines. An agent with a working local parser and a small clean PDF may gain little from another hosted API. Convenience alone will not justify a premium for every use case.

The strongest initial use cases are finding a specific clause or specification in a long document, extracting a financial table with cell-level evidence, and comparing revisions. Start with one of those workflows rather than offering the entire catalog at launch.

**Why PDF tasks become expensive**

The costs come from repeated model input, whole-page images, processing irrelevant pages, broken extraction that triggers retries, lost structure, and asking a language model to perform operations that software can calculate directly. Upload size is a different cost: compressing a PDF's bytes does not necessarily reduce its model input tokens.

For example, Claude's native PDF path supplies both extracted text and page images to the model. Its documentation also recommends prompt caching for repeated analysis. A stored file reference alone should not be treated as free repeated inference. The exact tradeoff depends on the agent's model, caching, PDF density, and task. [Claude PDF support](https://platform.claude.com/docs/en/build-with-claude/pdf-support)

Converting all pages to Markdown can remove unnecessary visual input, but it still leaves the agent reading all the text. The larger opportunity is selective retrieval with faithful structure and reusable processing. Plain PDF text extraction also does not read image-only scans; OCR is a separate capability. [pypdf extraction documentation](https://github.com/py-pdf/pypdf/blob/main/docs/user/extract-text.md)

An illustrative text-only calculation: a 100-page document at an assumed 2,000 tokens per page, resent on eight uncached requests, exposes 1.6 million document tokens to the model. Eight results capped at 6,000 tokens expose at most 48,000 returned document tokens. That is 97% less document text in this constructed example, not a measured API bill reduction. Parsing, OCR, image input, reasoning, tool overhead, and provider caching must be included in an actual comparison. A task requiring every page may not benefit from selective retrieval.

**What exists already, and what to reuse**

| Existing service or engine | Verified capability | Product implication |
| --- | --- | --- |
| [Cloudflare Workers AI toMarkdown](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/) | Document conversion to Markdown; most format conversion is free, with some model-powered conversions potentially incurring Workers AI usage | Benchmark this inexpensive baseline before building a proprietary converter. This does not make storage, Worker requests, or all AI processing free. |
| [Cloudflare PDF conversion internals](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/how-it-works/) | Uses a PDF structure tree when available and otherwise extracts page text | Do not assume this is a complete scanned-PDF OCR or cell-coordinate extraction service. Test page boundaries, structure, and source mapping. |
| [LiteParse](https://github.com/run-llama/liteparse) | Local spatial extraction, bounding boxes, complexity detection, OCR integration, and page screenshots; Apache-2.0 code | Strong candidate to benchmark for the inexpensive parsing and rendering path. Its native and WASM variants need separate deployment tests; availability of WASM does not establish Worker compatibility. |
| [Docling](https://github.com/docling-project/docling) | Layout, reading order, tables, OCR, and structured document output; MIT code with separately licensed models | Candidate for a richer parsing backend on a suitable CPU or model runtime. Pin the engine and model versions. |
| [Adobe PDF Extract](https://developer.adobe.com/document-services/apis/pdf-services/extract-pdf-content/) | Structured extraction of text, images, tables, and reading order from native and scanned PDFs | A managed fallback to benchmark on difficult documents, rather than another capability to reproduce immediately. |
| [Mistral Document AI OCR](https://docs.mistral.ai/studio/document-processing/basic_ocr) | Structured OCR, table outputs, bounding boxes, and optional confidence information | Candidate for selective scanned-page processing. Preserve which model and region produced each result. |
| [Google Document AI layout parser](https://docs.cloud.google.com/document-ai/docs/layout-parse-chunk) | Layout-aware document structure and chunking, including contextual headings | Another managed backend to compare. Its documented limitations include PDF tables spanning multiple pages potentially being split. Joining such tables remains a useful service capability. |
| [Azure Document Intelligence layout](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/layout?view=doc-intel-4.0.0) | Table cells, spans, bounding polygons, and document layout | Useful comparison for table fidelity and evidence mapping. Availability of a feature does not establish accuracy on the target corpus. |
| [Amazon Textract](https://docs.aws.amazon.com/textract/latest/dg/how-it-works-analyzing.html) | Text, forms, tables, query responses, and signature detection | Useful for business-document workflows. Detection of a signature image is different from validating a cryptographic PDF signature. |
| [Unstructured's routing implementation](https://github.com/Unstructured-IO/unstructured/blob/main/unstructured/partition/strategies.py) | Routes between fast extraction, OCR, and richer layout strategies based on document requirements | Supports the case for multiple processing paths; do not send every page through the most expensive engine. |
| [PDFMonkey](https://pdfmonkey.io/docs/api/documents/) | Generates PDFs from a stored template and structured payload | Reusable template generation already has managed competitors. Differentiate through agent workflows, versioned source edits, evidence, and output checks. |
| [Gotenberg](https://gotenberg.dev/docs/getting-started/routes) | Chromium-based HTML/Markdown generation and LibreOffice-based Office conversion | Candidate engine for container-based generation and conversion; deploying it does not by itself supply cost controls or quality verification. |

These are potential dependencies, competitors, or fallbacks, not newly connected services. No vendor API was called on user documents during this research. This is a capability survey, not a hands-on accuracy ranking. Managed-provider costs must be checked against their current pricing and the exact processor selected; [Google's pricing](https://cloud.google.com/products/document-ai/pricing) illustrates that OCR, layout, and form extraction are distinct billed operations.

The defensible product work is a consistent agent interface, reusable private document state, accurate evidence locations, selective processing, cost ceilings, predictable failure handling, and a measured reduction in task cost. Basic PDF-to-text conversion is already widely available.

**Next release: seven core capabilities**

1. `ingest_document`: accept a private upload, calculate an immutable content hash, return a document capability and stable ID, and reuse existing authorized processing results. Separate upload lifetime from parsed-document lifetime.
2. `inspect_pdf`: report page count, encryption, signatures, text coverage by page, likely scan pages, form/attachment presence, and processing warnings. Inspection must have its own resource limits; it is not a free unlimited full parse.
3. `get_document_map`: expose existing bookmarks first, then detected headings, page ranges, tables, and figures. Mark inferred headings explicitly. Do not silently generate a possibly fictional table of contents.
4. `search_document`: return bounded ranked snippets with section, physical page, printed page label, and source references. Start with exact, phrase, and lexical search; measure the need for semantic search before adding embeddings.
5. `read_document`: retrieve selected pages, section IDs, or block IDs as text, spatial text, Markdown, or structured JSON. Preserve original text alongside optional normalization. Support byte limits and explicit cursors.
6. `render_page_region`: produce a selected page or crop for visual confirmation. Return a resource by default; include an image in model context only when explicitly requested and supported by the MCP client.
7. `quote_document_operation`: describe the selected pages, processing mode, maximum application charge, allowed fallback, expiration, and output limits before an agent authorizes paid work. Bind the quote to the document hash and canonical request.

The platform also needs status, download, and deletion operations; these are shared lifecycle operations rather than separate product lines. Existing `generate_pdf` remains useful as the output half of the workflow.

**The next paid capabilities I would prioritize**

`extract_tables` should return an inventory first, then selected tables. Preserve original strings, row and column spans, headers, units, footnotes, and a source location for each cell. Normalize values in separate fields. A blank cell, zero, dash, and missing value must remain distinguishable. Joining multi-page tables should be opt-in or marked as inferred.

`query_tables` should perform validated operations such as filter, group, sum, and compare over extracted data. A small typed query language is sufficient initially; unrestricted SQL or code execution is unnecessary. Return the exact cells used and warnings for mixed units or currencies. Correct arithmetic over incorrectly extracted cells is still a wrong result.

`ocr_pages` should process only chosen pages or low-quality regions, reuse prior OCR, and report which pages were not processed. The expensive step must require permission in the quoted processing policy. A failed cheap extraction should not automatically trigger an unlimited premium model call.

`compare_documents` should align versions, distinguish page reflow from content changes, and return changed paragraphs or table cells with source locations in both versions. A semantic summary can be an optional extra; a deterministic change inventory is the foundation.

`validate_pdf_output` should expose separate findings for structural integrity, missing expected content, clipping or suspicious layout, font/rendering issues, and standards checks. The current MVP's PDF signature and size checks are not a complete validator. qpdf checks syntax rather than page meaning; veraPDF covers machine-verifiable standards requirements rather than complete human accessibility. [qpdf check semantics](https://github.com/qpdf/qpdf/blob/main/manual/cli.rst), [veraPDF validation](https://docs.verapdf.org/validation/)

`extract_schema` should extract only fields requested by a JSON schema, attach evidence to each field, distinguish absent from unreadable values, and run deterministic validation. Use explicit abstention rather than inventing a plausible value. JSON that conforms to a schema is not proof that the values are correct.

`verify_citation` should check whether an exact quote is present in the identified source version and resolve its page and location. Semantic support checking is a separate model-assisted mode. Neither confirms that the source itself tells the truth.

`build_evidence_pack` should create a small artifact containing selected source excerpts, cropped evidence, source hashes, page labels, timestamps, and a manifest. This makes an agent's work reviewable without requiring someone to reopen hundreds of pages.

`build_context_packet` should compose search, selected reading, and table slicing into one bounded call for a question. Include neighboring qualifications, units, citations and coverage warnings. This can save agent round trips as well as input tokens. Start with deterministic selection; optional model reranking is a separately quoted mode, not an invisible expense.

**PDF creation also needs a cheaper agent workflow**

`generate_pdf_from_template` should accept a versioned template ID and small schema-validated JSON payload. The service retains the layout, fonts, and reusable styles. Agents can then populate a known invoice, research report, proposal, or evidence packet without repeatedly writing complete HTML/CSS. This extends the existing Markdown generator rather than replacing it. Template-driven generation is an established pattern in [PDFMonkey's document API](https://pdfmonkey.io/docs/api/documents/); the product opportunity is the surrounding agent workflow and dependable result.

`patch_generated_document` should retain the editable source, template version, and structured data behind each generated artifact. The agent submits a patch such as changing one field or replacing one named section against a specific base revision. Return the new PDF, source diff, changed-page map, and validation findings. Concurrent edits must detect version conflicts. This can reduce repeated model output and visual-review cycles; it is not a promise to edit arbitrary imported PDFs perfectly.

`generate_document_batch` can apply a validated template to many records, with a manifest, per-record status, and individual downloads. Bound concurrency, page count, retries, and charge; one malformed record should not invalidate all successful records. Reusing a template does not remove rendering cost for each output.

Connect these operations to `validate_pdf_output`. A useful layout failure identifies the affected page or region, the expected field or block, a short finding, and a crop for verification. Start with deterministic checks for expected text and page counts plus rendering diagnostics. Visual judgments such as clipping and overlap need measured detection quality and sometimes model or human review. Recheck impacted pages and cross-page effects after a patch, with a complete validation pass when changes affect global layout. Preserve stable source/artifact hashes so repeated downloads and checks reuse the correct revision.

Conversion back from PDF to editable source belongs later: reconstructed paragraphs and tables can help, but uncertain reading order, fonts, and layout need an explicit fidelity report. Keep the original file alongside the reconstructed output.

**Result design that directly controls agent cost**

Prefer a compact, stable contract across operations. A proposed search result looks like this:

```json
{
  "document_id": "doc_123",
  "document_version": "sha256:...",
  "processing_version": "native-engine-version/config-hash",
  "coverage": {
    "requested_pages": [1, 2, 3, 4],
    "searched_pages": [1, 2, 4],
    "unreadable_pages": [3],
    "complete": false
  },
  "results": [{
    "block_id": "p4_b7",
    "page": 4,
    "page_label": "2",
    "section": "Termination",
    "text": "The agreement may be terminated...",
    "source": {
      "method": "native_text",
      "bbox": [0.10, 0.30, 0.80, 0.42],
      "coordinate_system": "normalized_top_left_displayed_page",
      "rotation_applied": true
    }
  }],
  "truncated": false,
  "next_cursor": null,
  "usage": {"pages_processed": 4, "pages_ocr": 0, "cache_hit": true},
  "warnings": ["Page 3 requires OCR; it was not searched."]
}
```

Physical pages should be consistently one-based in the public API, with printed labels separately returned. Document IDs and hashes are not authorization. Every request still requires an appropriately scoped document capability or authenticated ownership.

Enforce `max_output_bytes` and optional token estimates tied to a named tokenizer. Pagination cursors must be bound to the document, query, and processing version. Never silently truncate a table or present a partial search as proof that a clause is absent. Return large tables, images, and complete exports as downloadable resources, not unsolicited base64 or enormous JSON in model context.

Keep confidence types separate: OCR recognition score, structure-detection score, heuristic quality flag, and model uncertainty are different quantities. Do not manufacture a universal confidence percentage or present an uncalibrated score as the probability that a financial value is correct.

Cache native text, OCR, layout, thumbnails, tables, and optional summaries independently. Cache keys should include source hash, engine/model version, configuration, requested pages, and tenant scope. A cache hit can reduce processing cost while returned text still incurs agent-model input cost. Avoid a cross-customer cache-existence oracle for private documents.

Expose a small core MCP tool set with modes and optional capability groups. The 68-item catalog below is a product backlog, not a proposal to inject 68 large tool schemas into every agent conversation.

**Architecture for the existing Cloudflare project**

Keep Workers as the API, MCP, authorization, quote, and payment coordinator. Use R2 for private immutable uploads, parsed page artifacts, crops, tables, and output files. Use D1 for ownership, processing versions, page coverage, quotes, jobs, and the payment ledger. Add a queue or durable workflow for longer work and a private search/index backend appropriate to the chosen retrieval method.

Use a bounded cheap extraction path for clean PDFs. Benchmark Workers AI toMarkdown, PDF.js, and a suitable native or WASM parser; do not choose solely from a README. Ordinary Workers have 128 MB per isolate, including WASM memory, so entire large PDFs and rasterized page batches cannot be assumed to fit. [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [PDF.js](https://github.com/mozilla/pdf.js)

Put native executables, heavier OCR, large-document parsing, and office conversion in an isolated container/serverless job runtime or a managed provider. Browser Run can continue generating PDFs, but the current HTML-to-PDF adapter does not establish an arbitrary uploaded-PDF rendering service. Such rendering needs its own backend and tests.

For the small-budget version, deploy coordination and bounded text workflows first, with expensive OCR and visual models disabled unless explicitly selected and quoted. Add a managed provider before committing to an always-on inference server, then compare unit economics at actual volume. The $5 Workers subscription does not cover every external provider or guarantee a $5 total bill.

**Payment and budget behavior**

Price by work that an agent can predict: processed pages, OCR pages, selected table extraction, bounded query bundles, or a document-processing job. Small cached reads can be included in an ingestion bundle for a defined lifetime, reducing repeated payment friction. Do not announce selling prices until provider cost, unsuccessful jobs, support, storage, and settlement overhead are measured.

The current adapter supports a fixed exact payment. Use a fixed quoted operation or bundle initially; do not assume it already supports charging a variable amount up to a ceiling. A different payment scheme or credit system requires a separately implemented and tested payment flow.

The default processing policy should be `native_only`, `ocr_selected`, or `premium_selected`, with a maximum page count, maximum application charge, and no automatic upgrade beyond that policy. Reserve budget atomically before dispatch so concurrent jobs cannot independently spend the same allowance. A provider may still bill a dispatched request after cancellation; distinguish a customer charge ceiling from a guarantee about all upstream costs.

Long jobs introduce a payment problem that the synchronous generator does not solve: an exact EVM authorization has a validity window, and verification is not a reservation of the payer's funds. Do not queue an arbitrary ten-minute OCR job and assume a short-lived authorization will remain settleable. Choose a documented accepted fee/bundle model or an authorization policy that safely covers completion, supported by the selected facilitator. Preserve the current rule that uncertain settlement is reconciled rather than blindly resent. [Official x402 exact EVM specification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md)

All artifacts and status checks must remain tied to the same paid request and immutable source. Charge once for a successful idempotent operation, expose the operation's actual usage, and state the failure/refund policy explicitly for paid upstream parsing. Do not claim a refund or cancellation occurred merely because a local request timed out.

**Less obvious PDF problems worth supporting**

- A single PDF can mix clean digital text, scans, and previously OCRed pages. Route per page, not only per document.
- A selectable text layer may be garbled, incomplete, or visually inconsistent. Compare native and rendered evidence selectively; text presence alone is not a quality guarantee.
- Column order, repeated headers, footnotes, and sidebars can change meaning when flattened. Preserve structure and keep original spans retrievable.
- Page index, printed page number, rotation, CropBox, and coordinate origin must be explicit to prevent an agent highlighting the wrong sentence.
- Tables need header inheritance, merged cells, continuation handling, original numeric formatting, and unit preservation. Include decimal commas, parentheses for negatives, superscripts, and percentage units in tests.
- Embedded machine-readable attachments can be more useful than OCR. Inventory and safely expose them without executing macros, scripts, or archive contents.
- Prefer an invoice's embedded structured XML or a report's attached spreadsheet when it is actually present, with validation and provenance. Keep attachment data and the visible PDF separate and report discrepancies rather than assuming they match.
- Metadata and declared timestamps can be listed cheaply, but they are self-reported document data, not independent proof of origin or history.
- A filled form can contain stored values that are not visibly rendered. Fill, regenerate appearances where supported, render, and read back; distinguish AcroForms, XFA, and flattened forms. [pikepdf form documentation](https://pikepdf.readthedocs.io/en/latest/topics/interactive_forms.html)
- Rewriting a signed document can invalidate its signatures or violate permitted-change policies. Preserve the original and return an explicit modification report. Cryptographic signature validity, certificate trust, timestamps, and revocation are separate checks. [pyHanko validation](https://docs.pyhanko.eu/en/latest/cli-guide/validation.html)
- A black overlay is not redaction. A real redaction workflow must address underlying text, images, metadata, attachments, and retained revisions, and verify the emitted artifact with defined tests. Unsupported content should produce an explicit failure rather than a blanket guarantee. [PyMuPDF redaction behavior](https://pymupdf.readthedocs.io/en/latest/page.html)
- Document text, including tool-looking instructions and hidden text, is untrusted input. Preserve it as quoted evidence; do not execute it or treat it as agent authority. Detection can flag suspicious content but cannot guarantee elimination of prompt injection.
- PDF parsers need isolation, memory/time limits, decompression limits, and a clear external-network policy. A syntactically repaired PDF is not certified safe. [OCRmyPDF security documentation](https://ocrmypdf.readthedocs.io/en/latest/pdfsecurity.html)

**Build order and acceptance gates**

| Stage | Deliverable | Evidence needed before broadening scope |
| --- | --- | --- |
| 1 | Private ingestion, inspection, map, lexical search, bounded read, selected crop, quote/status/delete | At least 30 authorized fixtures spanning native, scanned, mixed, rotated, multilingual, encrypted, malformed, and multi-column files; correct page references; explicit partial coverage; bounded outputs; no paid fallback without policy |
| 2 | Selected-page OCR, table extraction/query, citation verification | Held-out table cells and source locations; row/column/span checks; OCR failure and abstention tests; deterministic arithmetic; measured provider cost |
| 3 | Revision comparison, extraction-quality report, generated-PDF validation, templates/source patches, evidence packs, schema fields | Page insertion/reflow versus actual edits; no silent missing content; independent rendering; version-conflict handling; extraction citations and nulls for absent/unreadable fields |
| 4 | One business workflow, chosen from table research, invoices/statements, or form packets | Successful completion and willingness to pay from real users; support burden and gross margin; quality remains acceptable on previously unseen templates |
| 5 | Advanced transformations, signatures, redaction, accessibility, translation, and adjacent document formats | Dedicated acceptance tests and operational policies for each; avoid treating these as trivial switches on an extraction engine |

Measure cost per correctly completed task, model input and output tokens, OCR pages, latency, retries, unsupported/abstained results, evidence accuracy, and the rate of silently wrong values. Compare a native PDF baseline with prompt caching, a cheap local-parser baseline, and the service. Evaluate search tasks separately from whole-document reviews.

The [ParseBench paper](https://arxiv.org/abs/2604.08538) argues for evaluating tables, charts, faithfulness, semantic formatting, and visual grounding rather than only text similarity. It is associated with a parser vendor, so use its dimensions and a separate held-out corpus rather than treating vendor rankings as proof of the best backend.

**Library and model selection**

Benchmark before selecting and record exact versions. LiteParse's code is Apache-2.0 and Docling's code is MIT; Docling explicitly notes that individual models have their own licenses. PyMuPDF is offered under AGPL and commercial terms. Review the actual code/model/dependency licenses when choosing a commercial backend rather than assuming every downloadable package has the same terms. [LiteParse](https://github.com/run-llama/liteparse), [Docling licensing](https://github.com/docling-project/docling#license), [PyMuPDF licensing](https://pymupdf.readthedocs.io/en/latest/about.html#license-and-copyright)

**What I would avoid initially**

Avoid unrestricted editing of arbitrary PDF layouts, a promise of perfect chart digitization, blanket accessibility certification, legally conclusive signature judgments, automatic premium OCR on every failure, and a universal document-chat wrapper that loads whole files repeatedly. These require separate product decisions and evaluation, not simply more tool names.

An optional answer or summary service can be useful later, especially if it selects evidence and uses a cheaper model. It should remain source-grounded and budgeted. The customer's existing agent can usually perform the final synthesis; the service should first make accurate evidence inexpensive to obtain.

**Complete capability catalog**

Priorities indicate proposed sequencing: P0 = foundation; P1 = next high-value release; P2 = specialized expansion; P3 = advanced or adjacent experiment. Runtime labels are deployment proposals, not verified Worker compatibility. Some capabilities should be modes of one tool or bundled workflows rather than standalone MCP tools. The machine-readable catalog is in `BACKLOG.json`.

| ID | Capability | Priority | Why an agent would use it | Execution proposal / acceptance focus |
| --- | --- | --- | --- | --- |
| DOC-001 | `ingest_document` | P0 | Upload once; issue a private stable document handle; reuse authorized extraction across sessions. | Worker + R2 + bounded parser. Check: Content hashing, tenant isolation, immutable versions, upload limits, deletion and expiry. |
| DOC-002 | `inspect_pdf` | P0 | Report page count, scan/text coverage, encryption, signatures, forms, attachments and processing requirements. | Bounded parser; offload large files. Check: Page-level coverage and explicit unknown states; inspection itself stays resource-bounded. |
| DOC-003 | `get_document_map` | P0 | List sections, bookmarks, tables and figures so the agent chooses where to look. | Cached structure + optional parser. Check: Distinguish embedded bookmarks from inferred headings and preserve correct page ranges. |
| DOC-004 | `search_document` | P0 | Return small cited snippets using exact, phrase and lexical search before optional semantic search. | Search index + Worker coordinator. Check: Explicit coverage, ranked results, stable locations, bounded results and no false absence claims. |
| DOC-005 | `read_document` | P0 | Retrieve selected pages, sections or blocks as text, spatial text, Markdown or JSON. | Cached page/block artifacts. Check: Original spans remain available; truncation and cursors explicit; reading order checked. |
| DOC-006 | `render_page_region` | P0 | Provide a page or bounded crop for visual verification without rendering the whole file. | PDF renderer service or CPU job. Check: Rotation and crop coordinates correct; DPI and pixel limits; private resource by default. |
| DOC-007 | `quote_document_operation` | P0 | Quote processing mode, selected pages, output limits and application charge ceiling before work. | Worker + durable budget ledger. Check: Request/document binding, quote expiry, atomic budget reservation and explicit fallback policy. |
| DOC-008 | `ocr_pages` | P1 | OCR only selected or demonstrably unreadable pages; cache the result for future reads. | OCR provider or isolated CPU job. Check: Mixed native/scan PDFs, languages, abstention, page evidence and no unauthorized premium fallback. |
| DOC-009 | `extract_tables` | P1 | List tables, then extract selected ones with spans, units, original cells and source boxes. | Parser + optional layout/OCR provider. Check: Headers and merged cells correct; missing versus zero preserved; continuation joins marked. |
| DOC-010 | `query_tables` | P1 | Filter, aggregate and compare extracted values without model arithmetic or full-table context. | Bounded table execution service. Check: Typed operations, exact source cells, unit/currency checks and deterministic numeric results. |
| DOC-011 | `compare_documents` | P1 | Return changed clauses, paragraphs and table cells across revisions, with both source locations. | CPU diff + optional model summary. Check: Page insertions and reflow do not masquerade as semantic changes; never imply legal equivalence. |
| DOC-012 | `validate_pdf_output` | P1 | Check generated files for expected content, render problems and suspicious clipping or omissions. | Structural checker + renderer + optional vision. Check: Structural, content, visual and standards findings remain separate; no blanket correctness guarantee. |
| DOC-013 | `extract_schema` | P1 | Return only requested JSON fields, with evidence, nulls and validation errors. | Retrieved evidence + optional model + validator. Check: Schema validity separated from factual correctness; absent/unreadable fields are not guessed. |
| DOC-014 | `verify_citation` | P1 | Resolve exact quotations and references to their source page and immutable document version. | Cached source spans + optional semantic model. Check: Exact matching distinct from semantic support and source truth; quote context preserved. |
| DOC-015 | `build_evidence_pack` | P1 | Bundle selected snippets, crops, tables and a source manifest into a reviewable packet. | Artifact assembly + renderer. Check: Source hashes, page labels, transformation history and consistent cited locations. |
| DOC-016 | `build_context_packet` | P1 | Return relevant passages and selected table slices in one budgeted call rather than many agent round trips. | Search/read composition + optional reranking. Check: Source locations, neighboring qualifications and units retained; output budget and partial coverage explicit. |
| DOC-017 | `list_form_fields` | P1 | Expose actual field names, types, current values and permitted choices before filling. | Form-aware parser. Check: Distinguish AcroForm, XFA and flattened documents; unsupported formats explicit. |
| DOC-018 | `fill_form_fields` | P2 | Fill selected interactive fields from structured data and optionally flatten the result. | Form-aware CPU job + renderer. Check: Appearance streams visible, values read back, choice validation and signature-change warning. |
| DOC-019 | `extract_annotations` | P2 | Extract review comments, highlights and their anchored text for an agent to address. | PDF parser. Check: Comment author/date treated as document metadata; locations and unresolved replies preserved. |
| DOC-020 | `extract_images` | P2 | Retrieve selected embedded pictures and metadata rather than screenshotting every page. | PDF parser + private image artifacts. Check: Image IDs, page occurrence and captions retained; deduplication does not lose placement. |
| DOC-021 | `interpret_figure` | P2 | Describe a chosen diagram, legend or visual element with an explicit evidence crop. | Selected crop + vision model. Check: Distinguish observed labels from interpretation and abstain on unreadable details. |
| DOC-022 | `digitize_chart` | P3 | Convert selected charts into approximate data with axes, units and source evidence. | Chart engine + vision + optional review. Check: Mark estimated versus exact values; test logarithmic axes, legends and uncertainty. |
| DOC-023 | `extract_equations` | P2 | Read a chosen formula as LaTeX with surrounding definitions and source location. | Layout/math parser + optional vision. Check: Subscripts, symbols and equation numbers checked; no claim of mathematical validity. |
| DOC-024 | `resolve_cross_references` | P2 | Follow references to sections, tables, figures, appendices and footnotes inside a document. | Document structure graph. Check: Broken references reported; physical page index and printed labels remain distinct. |
| DOC-025 | `normalize_reading_order` | P2 | Repair column sequencing, repeated headers and hyphenation while retaining original spans. | Layout parser + heuristics. Check: Normalization reversible through source links; footnotes and numbers not silently discarded. |
| DOC-026 | `assess_extraction_quality` | P1 | Flag sparse, garbled, mismatched or incomplete extraction and propose the cheapest next step. | Heuristics + selected independent checks. Check: Quality flags are calibrated separately; partial coverage and backend failures visible. |
| DOC-027 | `search_document_collection` | P2 | Find relevant passages across an authorized set of PDFs without loading every document. | Private collection index. Check: Per-result access control, corpus coverage and document/version provenance. |
| DOC-028 | `detect_duplicate_documents` | P2 | Find identical or near-duplicate documents to avoid repeat processing and review. | Hashes + optional semantic similarity. Check: Byte identity separate from similarity; private cross-tenant existence is not disclosed. |
| DOC-029 | `reuse_changed_pages` | P2 | Process only changed pages/regions when a new document revision arrives. | Versioned extraction cache + CPU comparison. Check: Cache invalidation includes resources, engine settings and dependencies, not just page text. |
| DOC-030 | `organize_pdf_pages` | P2 | Split, merge, reorder, rotate and select pages from structured instructions. | PDF CPU job. Check: Internal links, forms, bookmarks, page labels and signature consequences checked. |
| DOC-031 | `compress_pdf` | P2 | Reduce storage or transfer size with a declared quality policy and output comparison. | PDF/image CPU job. Check: Compression is not advertised as guaranteed token savings; small text and barcodes preserved. |
| DOC-032 | `repair_pdf_structure` | P2 | Attempt bounded repair of damaged cross-references and streams and report changes. | Isolated qpdf or similar job. Check: Repair success separate from safe content, correct rendering or recovered information. |
| DOC-033 | `make_searchable_pdf` | P2 | Add a searchable text layer to scanned pages while retaining their visual appearance. | OCR + PDF CPU job. Check: Text aligns to images; original retained; signatures and OCR mistakes explicitly handled. |
| DOC-034 | `annotate_pdf` | P2 | Add highlights, comments, labels and source-linked markup to selected locations. | PDF parser/writer + renderer. Check: Coordinates correct after rotation/cropping; originals and existing comments preserved. |
| DOC-035 | `redact_pdf` | P3 | Remove selected sensitive content rather than covering it with a black rectangle. | Dedicated redaction engine + independent verification. Check: Defined checks for text, images, attachments, metadata and revisions; unsupported content fails. |
| DOC-036 | `sanitize_pdf` | P2 | Remove declared active content and embedded items under a documented sanitization policy. | Isolated PDF rewriter + checker. Check: Manifest lists removals; no absolute malware-free guarantee or implied preservation of signatures. |
| DOC-037 | `open_password_protected_pdf` | P2 | Process an authorized encrypted PDF using the password supplied for that job. | Isolated parser + secret handling. Check: No password cracking; passwords never logged or persisted unnecessarily; failure modes explicit. |
| DOC-038 | `validate_digital_signatures` | P3 | Report integrity, signed revisions, permitted changes, certificate trust and timestamps separately. | Signature validator + controlled trust/revocation access. Check: Signature image detection is not cryptographic validation; unavailable revocation status remains unknown. |
| DOC-039 | `sign_pdf` | P3 | Prepare and sign a document using a caller-controlled secure signing integration. | External protected signer + PDF signature library. Check: No private key custody in agent context; explicit signing intent and document hash confirmation. |
| DOC-040 | `convert_validate_pdfa` | P3 | Create an archival variant and return the exact profile and validation report. | Conversion backend + veraPDF. Check: Retain original, inspect visual changes and do not label arbitrary PDFs archival without validation. |
| DOC-041 | `audit_pdf_accessibility` | P3 | Report tags, reading order, language, alt text and table-accessibility findings. | Structure/standards checker + human review where needed. Check: Machine checks distinguished from human checks; no universal accessibility certification. |
| DOC-042 | `translate_pdf_sections` | P3 | Translate chosen sections into a parallel or newly laid-out artifact with source alignment. | Selected extraction + translation model + renderer. Check: Original preserved; numbers, names and units checked; layout and translation claims separated. |
| DOC-043 | `summarize_document_sections` | P2 | Create reusable summaries for selected sections with citations and explicit coverage. | Cached evidence + budgeted model. Check: Extracted facts distinguished from model summary; full-document review is not implied. |
| DOC-044 | `extract_action_items` | P2 | Identify deadlines, obligations and follow-up items with owner/date evidence. | Selected evidence + schema model. Check: Quoted source dates preserved; ambiguous deadlines and inference marked rather than invented. |
| DOC-045 | `process_invoice` | P2 | Extract line items and totals, preserve tax/currency evidence and flag arithmetic inconsistencies. | OCR/schema pipeline + deterministic validation. Check: Line-item provenance, duplicate checks, rounding policies and unseen-template tests. |
| DOC-046 | `process_financial_statement` | P2 | Extract statement rows and reconcile opening balance, transactions and closing balance. | Tables + typed computation + evidence. Check: No silent inferred transactions; signs, currency, dates and source rows preserved. |
| DOC-047 | `read_scanned_form` | P2 | Read checkboxes, labels and handwritten fields from a selected flat form. | OCR/layout provider + schema checks. Check: Unchecked versus unreadable separate; confidence and required-field abstention tested. |
| DOC-048 | `compare_product_specifications` | P2 | Compare technical datasheets by requested properties, units and source evidence. | Schema/table extraction + unit conversion. Check: Part variants, conditions, tolerances and missing specifications do not disappear in normalization. |
| DOC-049 | `extract_resume_profile` | P3 | Convert a resume into a requested profile schema without invented employment facts. | Schema extraction + evidence. Check: Timeline evidence preserved; ambiguous dates remain ambiguous; no automated hiring judgment. |
| DOC-050 | `extract_contract_clause_matrix` | P2 | Compare requested clause topics across documents with exact excerpts and missing/unknown states. | Clause search + schema extraction + evidence. Check: No legal advice or equivalence guarantee; partial search and interpretive labels explicit. |
| DOC-051 | `read_barcodes_qr` | P2 | Decode relevant machine-readable codes without model visual guessing. | Selected page render + barcode decoder. Check: Return location and exact bytes; URLs are data and are not automatically opened. |
| DOC-052 | `extract_pdf_attachments` | P2 | Safely inventory and retrieve embedded XML, CSV, spreadsheets and portfolio components. | Bounded PDF/archive extraction. Check: Per-item limits, path normalization and provenance; no execution of attachments or macros. |
| DOC-053 | `recalculate_spreadsheet` | P2 | Evaluate formulas, detect errors and return targeted ranges as reusable evidence. | Spreadsheet calculation runtime. Check: Calculation engine and unsupported functions declared; formula text separated from cached values. |
| DOC-054 | `edit_docx_with_redlines` | P2 | Apply structured changes and return a reviewable Word file with comments or tracked revisions. | OOXML/document runtime + renderer. Check: True revision structure, preserved styles and rendered verification rather than regex replacement. |
| DOC-055 | `convert_office_document` | P2 | Convert DOCX, PPTX or XLSX to PDF or previews without requiring agent GUI automation. | Isolated office renderer. Check: Fonts, page/slide/sheet coverage, print areas and missing dependencies reported. |
| DOC-056 | `inspect_slide_deck` | P2 | Expose slide text, notes, images and targeted visual checks without whole-deck screenshots. | PPTX parser + renderer. Check: Hidden slides, notes and reading order explicit; selected checks do not certify the whole deck. |
| DOC-057 | `capture_web_evidence` | P2 | Capture a requested page as readable text, screenshot or PDF with URL/time/hash evidence. | Browser service + immutable snapshot. Check: Controlled fetch policy, render limits and source identity; snapshot is not proof of website truth. |
| DOC-058 | `build_email_attachment_packet` | P3 | Turn supplied email files and attachments into a searchable evidence packet. | EML/MSG parser + private artifacts. Check: Headers and attachments remain traceable; ingest only, with no automatic email sending. |
| DOC-059 | `validate_structured_data` | P1 | Validate JSON/CSV-like records, dates, units and business totals before an agent acts on them. | Bounded deterministic execution. Check: Precise error locations, named locale/rounding policies and no silent coercion. |
| DOC-060 | `generate_chart_artifact` | P2 | Turn structured data into SVG/PNG/PDF charts without agent plotting setup. | Deterministic chart renderer. Check: Source data retained, units/axes correct, readable rendering and no fabricated values. |
| DOC-061 | `inspect_extract_archive` | P3 | Inventory and retrieve selected files from a document archive without expanding everything. | Isolated archive job. Check: Nested archive/decompression/path limits; no execution and per-file source manifest. |
| DOC-062 | `transcribe_recording` | P3 | Expose searchable transcript segments and selected timestamps for recordings linked to documents. | ASR provider + timestamp index. Check: Speaker attribution uncertainty, language, consent/context policy and timestamp accuracy tested. |
| DOC-063 | `render_diagram` | P2 | Generate Mermaid, Graphviz or similar diagrams from structured input for reports. | Bounded diagram renderer. Check: Syntax diagnostics, bounded rendering and SVG safety; no arbitrary script execution. |
| DOC-064 | `prepare_document_images` | P2 | Deskew, rotate, crop and normalize selected scan images before OCR. | Image CPU pipeline. Check: Original preserved; transformation coordinates and interpolation loss reported. |
| DOC-065 | `generate_pdf_from_template` | P1 | Generate consistent reports, invoices or packets from structured data without repeating HTML/CSS in agent context. | Stored template + schema validator + renderer. Check: Versioned templates and fonts; input schema validation; expected-content checks; reproducible source manifest. |
| DOC-066 | `patch_generated_document` | P1 | Make small edits to retained Markdown or template data and rerender without resending or rewriting the whole document. | Versioned source store + structured patch + renderer. Check: Base-version conflict detection; stable block/field references; diff and page-scoped QA; no arbitrary PDF-editing promise. |
| DOC-067 | `generate_document_batch` | P2 | Generate many documents from validated records with one template and a bounded execution budget. | Job queue + template renderer. Check: Per-record status and artifacts; isolated failures; idempotent retries; bounded concurrency and actual usage. |
| DOC-068 | `convert_pdf_to_editable` | P3 | Reconstruct an editable document or structured source from a PDF when the original source is unavailable. | Layout reconstruction + office renderer. Check: Fidelity report; text/image/table provenance; reconstructed versus preserved structure explicit; no exact-layout guarantee. |
