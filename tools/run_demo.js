import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRelayFaultServer } from "../src/proxy.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scenario = JSON.parse(fs.readFileSync(path.join(root, "examples", "scenario.json"), "utf8"));
const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "relayfault-demo-"));
const eventPath = path.join(tempDirectory, "events.ndjson");

const upstream = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const result = JSON.stringify({ accepted: true, bytes: Buffer.concat(chunks).length });
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(result) });
    response.end(result);
  });
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

let relay;
try {
  const upstreamPort = await listen(upstream);
  relay = createRelayFaultServer({
    target: `http://127.0.0.1:${upstreamPort}`,
    scenario,
    seed: 20260829,
    eventPath,
  });
  const relayPort = await listen(relay.server);
  const statuses = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${relayPort}/payments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attempt }),
    });
    statuses.push(response.status);
    await response.text();
  }
  const statusResponse = await fetch(`http://127.0.0.1:${relayPort}/__relayfault/status`);
  const status = await statusResponse.json();
  const eventCount = fs.readFileSync(eventPath, "utf8").trim().split("\n").filter(Boolean).length;
  const result = { seed: 20260829, statuses, events: eventCount, stats: status.stats };
  if (JSON.stringify(statuses) !== JSON.stringify([503, 503, 200]) || eventCount !== 3) {
    throw new Error(`unexpected demo evidence: ${JSON.stringify(result)}`);
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (relay) await close(relay.server);
  await close(upstream);
  fs.rmSync(tempDirectory, { recursive: true, force: true });
}
