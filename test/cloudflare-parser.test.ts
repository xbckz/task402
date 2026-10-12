import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CloudflarePdfParser } from "../src/cloudflare-parser.js";
import { buildPdfIndex } from "../src/pdf-document-index.js";

const input = new Uint8Array(await readFile(new URL("../examples/sample-report.pdf", import.meta.url)));
const validIndex = await buildPdfIndex(input);
const parserFor = (value: unknown) => new CloudflarePdfParser(async () => Response.json(value), "test-token");

test("Container parser accepts native index and rejects malformed or inconsistent results", async () => {
  assert.equal((await parserFor(validIndex).parse(input)).pageCount, 2);
  await assert.rejects(parserFor({ ...validIndex, pageCount: 101 }).parse(input));
  await assert.rejects(parserFor({ ...validIndex, pages: [] }).parse(input));
  await assert.rejects(parserFor({ ...validIndex, pages: [{ ...validIndex.pages[0], blocks: [{ text: "invalid" }] }, validIndex.pages[1]] }).parse(input));
});

test("Container parser preserves public overload and malformed PDF status without leaking internals", async () => {
  const overloaded = new CloudflarePdfParser(async () => Response.json({ error: { code: "document_parser_busy", message: "private runtime detail" } }, { status: 503 }), "test-token");
  await assert.rejects(overloaded.parse(input), (error: unknown) => {
    assert.equal((error as { status: number }).status, 503);
    assert.equal((error as { code: string }).code, "document_parser_busy");
    assert.ok(!(error as Error).message.includes("private"));
    return true;
  });
  const malformed = new CloudflarePdfParser(async () => Response.json({ error: { code: "pdf_parse_failed" } }, { status: 422 }), "test-token");
  await assert.rejects(malformed.parse(input), { status: 422, code: "pdf_parse_failed" });
});

test("Container parser rejects forged PNGs and oversized error outputs", async () => {
  const forged = new CloudflarePdfParser(async () => new Response("not a PNG", { headers: { "content-type": "image/png" } }), "test-token");
  await assert.rejects(forged.render(input, 1, { x: 0, y: 0, width: 1, height: 1 }));
  const oversized = new CloudflarePdfParser(async () => new Response("x".repeat(4097), { status: 503 }), "test-token");
  await assert.rejects(oversized.parse(input), /bounded output limit/);
});
