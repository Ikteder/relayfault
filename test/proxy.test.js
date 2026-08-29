import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { createRelayFaultServer, parseAndCheckTarget, stripHopByHopHeaders } from "../src/proxy.js";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function fixture(t, scenario, options = {}) {
  const calls = [];
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      calls.push({ method: request.method, url: request.url, headers: request.headers, body });
      const result = JSON.stringify({ received: body, path: request.url });
      response.writeHead(201, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(result),
        connection: "close",
        "x-upstream": "yes",
      });
      response.end(result);
    });
  });
  const upstreamPort = await listen(upstream);
  const relay = createRelayFaultServer({
    target: `http://127.0.0.1:${upstreamPort}`,
    scenario,
    seed: 20260829,
    ...options,
  });
  const relayPort = await listen(relay.server);
  t.after(async () => {
    await close(relay.server);
    await close(upstream);
  });
  return { base: `http://127.0.0.1:${relayPort}`, calls, relay };
}

const forwardScenario = { version: 1, rules: [], defaultAction: { type: "forward" } };

test("forwards method, path, headers, and body", async (t) => {
  const { base, calls } = await fixture(t, forwardScenario);
  const response = await fetch(`${base}/echo?q=1`, {
    method: "POST",
    headers: { "content-type": "text/plain", "x-client": "relay-test", connection: "close" },
    body: "payload",
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("x-upstream"), "yes");
  assert.deepEqual(await response.json(), { received: "payload", path: "/echo?q=1" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers["x-client"], "relay-test");
});

test("removes hop-by-hop headers without removing end-to-end headers", () => {
  assert.deepEqual(
    stripHopByHopHeaders({ connection: "close", "transfer-encoding": "chunked", "x-request-id": "abc" }),
    { "x-request-id": "abc" },
  );
});

test("returns two synthetic failures before forwarding", async (t) => {
  const { base, calls, relay } = await fixture(t, {
    version: 1,
    rules: [
      {
        name: "first two",
        match: { method: "POST", path: "/pay" },
        when: { requests: [1, 2] },
        action: { type: "respond", status: 503, headers: { "retry-after": "1" }, body: "retry" },
      },
    ],
    defaultAction: { type: "forward" },
  });
  const statuses = [];
  for (let index = 0; index < 3; index += 1) {
    const response = await fetch(`${base}/pay`, { method: "POST", body: "x" });
    statuses.push(response.status);
    await response.text();
  }
  assert.deepEqual(statuses, [503, 503, 201]);
  assert.equal(calls.length, 1);
  assert.equal(relay.stats.synthetic, 2);
  assert.equal(relay.stats.forwarded, 1);
});

test("delays a request and then forwards it", async (t) => {
  const { base, relay } = await fixture(t, {
    version: 1,
    rules: [{ name: "slow", match: { path: "/slow" }, action: { type: "delay", milliseconds: 35 } }],
  });
  const began = performance.now();
  const response = await fetch(`${base}/slow`);
  await response.text();
  const elapsed = performance.now() - began;
  assert.equal(response.status, 201);
  assert.ok(elapsed >= 25, `expected visible delay, observed ${elapsed} ms`);
  assert.equal(relay.stats.delayed, 1);
  assert.equal(relay.stats.forwarded, 1);
});

test("disconnect action closes the client connection", async (t) => {
  const { base, calls, relay } = await fixture(t, {
    version: 1,
    rules: [{ name: "drop", match: { path: "/drop" }, action: { type: "disconnect" } }],
  });
  await assert.rejects(fetch(`${base}/drop`));
  assert.equal(calls.length, 0);
  assert.equal(relay.stats.disconnected, 1);
});

test("rejects an oversized body without forwarding", async (t) => {
  const { base, calls, relay } = await fixture(t, forwardScenario, { maxBodyBytes: 4 });
  const response = await fetch(`${base}/upload`, { method: "POST", body: "12345" });
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /exceeds/);
  assert.equal(calls.length, 0);
  assert.equal(relay.stats.rejectedBodies, 1);
});

test("status endpoint is read-only and excluded from fault counters", async (t) => {
  const { base } = await fixture(t, forwardScenario);
  await (await fetch(`${base}/hello`)).text();
  const first = await (await fetch(`${base}/__relayfault/status`)).json();
  const second = await (await fetch(`${base}/__relayfault/status`)).json();
  assert.equal(first.service, "relayfault");
  assert.equal(first.stats.total, 1);
  assert.equal(second.stats.total, 1);
  assert.equal(first.stats.forwarded, 1);
});

test("records one structured event per handled request", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relayfault-test-"));
  const eventPath = path.join(directory, "events.ndjson");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { base } = await fixture(t, forwardScenario, { eventPath });
  await (await fetch(`${base}/one`)).text();
  await (await fetch(`${base}/two`)).text();
  const events = fs.readFileSync(eventPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.requestId), [1, 2]);
  assert.deepEqual(events.map((event) => event.outcome), ["forwarded", "forwarded"]);
});

test("blocks remote targets unless the caller explicitly opts in", () => {
  assert.throws(() => parseAndCheckTarget("https://example.com"), /remote targets are blocked/);
  assert.equal(parseAndCheckTarget("https://example.com", true).origin, "https://example.com");
  assert.throws(() => parseAndCheckTarget("file:///tmp/demo"), /protocol/);
  assert.throws(() => parseAndCheckTarget("http://user:secret@localhost:9000"), /credentials/);
});
