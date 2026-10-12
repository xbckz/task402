import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Execute the actual DO class with a platform stub; Node cannot import cloudflare:workers.
const source = await readFile(new URL("../src/container.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function fixture(parse: () => Promise<Response>) {
  const events: string[] = [];
  let expire: (() => void) | undefined;
  const container = {
    running: false, images: { parser: "image@digest" },
    start(options: { enableInternet: boolean }) { assert.equal(options.enableInternet, false); events.push("start"); this.running = true; },
    async destroy() { events.push("destroy"); this.running = false; },
    async setInactivityTimeout() { assert.ok(events.includes("health")); events.push("timeout"); },
    getTcpPort() { return { fetch: async (request: Request) => {
      if (new URL(request.url).pathname === "/health") { events.push("health"); return new Response("ok"); }
      events.push("parse"); return parse();
    } }; },
  };
  class DurableObject {
    constructor(public ctx: unknown, public env: unknown) {}
  }
  const exports: Record<string, any> = {};
  class WorkerRequest extends Request {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(input, init?.body ? { ...init, duplex: "half" } as RequestInit : init);
    }
  }
  runInNewContext(compiled, {
    exports, require: (name: string) => name === "cloudflare:workers" ? { DurableObject } : { MAX_DOCUMENT_INDEX_BYTES: 8 * 1024 * 1024 },
    Request: WorkerRequest, Response, URL, AbortController, AbortSignal, Uint8Array,
    setTimeout: (callback: () => void, ms: number) => { assert.equal(ms, 60_000); expire = callback; return 1; },
    clearTimeout: () => {},
  });
  const instance = new exports.DocumentParserContainer({ container }, { DOCUMENT_CONTAINER_TOKEN: "test-token" });
  const request = () => new Request("https://parser/parse", { method: "POST", headers: { "x-document-container-token": "test-token" }, body: "pdf" });
  return { instance, events, request, expire: () => expire!() };
}

test("Container admission rejects concurrent tasks, waits for health, and resets after success", async () => {
  let complete!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { complete = resolve; });
  const f = fixture(() => pending);
  const first = f.instance.fetch(f.request());
  const busy = await f.instance.fetch(f.request());
  assert.equal(busy.status, 503);
  assert.equal((await busy.json()).error.code, "document_parser_busy");
  complete(Response.json({ ok: true }));
  assert.equal((await first).status, 200);
  assert.deepEqual(f.events, ["start", "health", "timeout", "parse", "destroy"]);
});

test("Container deadline destroys stuck parsing and releases admission without retrying it", async () => {
  const f = fixture(() => new Promise(() => {}));
  const first = f.instance.fetch(f.request());
  for (let turn = 0; turn < 20 && !f.events.includes("parse"); turn++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(f.events.includes("parse"));
  f.expire();
  assert.equal((await first).status, 503);
  assert.equal(f.events.filter((event) => event === "parse").length, 1);
  assert.equal(f.events.at(-1), "destroy");
  const next = f.instance.fetch(f.request());
  f.expire();
  assert.equal((await next).status, 503);
  assert.equal(f.events.filter((event) => event === "start").length, 2);
});
