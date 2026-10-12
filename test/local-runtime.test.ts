import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileArtifactStore, SqliteJobStore } from "../src/local-store.js";
import { pinnedLookupValue } from "../src/pinned-dns.js";

test("pinned DNS lookup preserves Node's all-address callback shape", () => {
  const address = { address: "93.184.216.34", family: 4 };
  assert.deepEqual(pinnedLookupValue(address, true), [address]);
  assert.equal(pinnedLookupValue(address, false), address.address);
});

test("local process rejects rebinding and oversize bodies and cleans persisted expired jobs on startup", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "x402-audit-"));
  const dbPath = join(directory, "jobs.sqlite");
  const objectPath = join(directory, "objects");
  const jobs = new SqliteJobStore(dbPath);
  const objects = new FileArtifactStore(objectPath);
  const id = "00000000-0000-4000-8000-000000000001";
  await jobs.insertJob({ id, requestKey: "expired", paymentKey: null, paymentFingerprint: "unused", inputHash: "unused", capabilityHash: "unused", title: "Expired", createdAt: 1, expiresAt: 2, paymentRetainUntil: Date.now() + 60_000 });
  await jobs.updateState(id, "complete", { artifactKey: `${id}.pdf`, artifactBytes: 3 });
  await objects.put(`${id}.pdf`, new Uint8Array([1, 2, 3]));
  jobs.close();

  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const child = spawn(process.execPath, ["--import", "tsx", "src/local.ts"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(port), NODE_ENV: "test", PAYMENTS_MODE: "dev-bypass", LOCAL_DB_PATH: dbPath, LOCAL_ARTIFACT_DIR: objectPath, LOCAL_DOCUMENT_DB_PATH: join(directory, "documents.sqlite"), LOCAL_DOCUMENT_ARTIFACT_DIR: join(directory, "documents") },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let logs = "";
  child.stdout.on("data", (data) => { logs += data.toString(); });
  child.stderr.on("data", (data) => { logs += data.toString(); });
  try {
    for (let attempt = 0; !logs.includes("local API listening") && attempt < 150; attempt++) {
      assert.equal(child.exitCode, null, logs);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.match(logs, /local API listening/);
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    const rebindingStatus = await new Promise<number | undefined>((resolve, reject) => {
      const probe = request(`${base}/healthz`, { headers: { host: "rebind.attacker.test" } }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      });
      probe.once("error", reject);
      probe.end();
    });
    assert.equal(rebindingStatus, 403);
    const oversized = await fetch(`${base}/v1/pdf`, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(300_001) });
    assert.equal(oversized.status, 413);
    assert.equal(await objects.get(`${id}.pdf`), null);
    const reopened = new SqliteJobStore(dbPath);
    try { assert.equal((await reopened.get(id))?.state, "expired"); }
    finally { reopened.close(); }
  } finally {
    const exited = once(child, "exit");
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await exited;
    await rm(directory, { recursive: true, force: true });
  }
});
