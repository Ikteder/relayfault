import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { performance } from "node:perf_hooks";
import { compileScenario } from "./scenario.js";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function loopbackHost(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  const kind = net.isIP(normalized);
  if (kind === 4) return normalized.startsWith("127.");
  return false;
}

export function parseAndCheckTarget(rawTarget, allowRemoteTarget = false) {
  let target;
  try {
    target = new URL(rawTarget);
  } catch {
    throw new Error("target must be a valid http:// or https:// URL");
  }
  if (!new Set(["http:", "https:"]).has(target.protocol)) {
    throw new Error("target protocol must be http or https");
  }
  if (target.username || target.password) throw new Error("target URL must not contain credentials");
  if (target.pathname !== "/" || target.search || target.hash) {
    throw new Error("target URL must contain only an origin, without a path, query, or fragment");
  }
  if (!allowRemoteTarget && !loopbackHost(target.hostname)) {
    throw new Error("remote targets are blocked; pass --allow-remote-target only when intentional");
  }
  return target;
}

export function isLoopbackListenHost(hostname) {
  return loopbackHost(hostname);
}

export function stripHopByHopHeaders(headers) {
  const cleaned = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase()) && value !== undefined) cleaned[name] = value;
  }
  return cleaned;
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    request.on("end", () => {
      if (tooLarge) reject(Object.assign(new Error("request body exceeds configured limit"), { code: "BODY_TOO_LARGE" }));
      else resolve(Buffer.concat(chunks));
    });
    request.on("aborted", () => reject(new Error("client aborted request body")));
    request.on("error", reject);
  });
}

function sendJson(response, status, value) {
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  response.end(body);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createRelayFaultServer(options) {
  const {
    target: rawTarget,
    scenario,
    seed = 1,
    maxBodyBytes = 1_048_576,
    eventPath = null,
    allowRemoteTarget = false,
  } = options;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 0) throw new TypeError("maxBodyBytes must be a non-negative integer");
  const target = parseAndCheckTarget(rawTarget, allowRemoteTarget);
  const engine = compileScenario(scenario, seed);
  const startedAt = new Date().toISOString();
  const stats = {
    total: 0,
    forwarded: 0,
    synthetic: 0,
    delayed: 0,
    disconnected: 0,
    rejectedBodies: 0,
    upstreamErrors: 0,
    ruleHits: {},
  };
  let nextRequestId = 1;

  if (eventPath) fs.writeFileSync(eventPath, "", { flag: "a" });

  function record(event) {
    if (!eventPath) return;
    fs.appendFileSync(eventPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`);
  }

  function forward(request, response, body, context) {
    return new Promise((resolve) => {
      const transport = target.protocol === "https:" ? https : http;
      const headers = stripHopByHopHeaders(request.headers);
      headers.host = target.host;
      headers["content-length"] = String(body.length);
      const incomingUrl = new URL(request.url, "http://relayfault.local");
      const began = performance.now();
      const upstream = transport.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || undefined,
          method: request.method,
          path: `${incomingUrl.pathname}${incomingUrl.search}`,
          headers,
        },
        (upstreamResponse) => {
          const responseHeaders = stripHopByHopHeaders(upstreamResponse.headers);
          response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
          upstreamResponse.pipe(response);
          upstreamResponse.on("end", () => {
            stats.forwarded += 1;
            record({
              ...context,
              outcome: "forwarded",
              status: upstreamResponse.statusCode ?? 502,
              upstreamMilliseconds: Number((performance.now() - began).toFixed(3)),
            });
            resolve();
          });
        },
      );
      upstream.on("error", (error) => {
        stats.upstreamErrors += 1;
        if (!response.headersSent) sendJson(response, 502, { error: "upstream unavailable" });
        else response.destroy();
        record({ ...context, outcome: "upstream-error", error: error.code ?? error.message });
        resolve();
      });
      upstream.end(body);
    });
  }

  const server = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/__relayfault/status") {
      sendJson(response, 200, {
        service: "relayfault",
        startedAt,
        target: target.origin,
        maxBodyBytes,
        stats,
        scenario: engine.snapshot(),
      });
      return;
    }

    const requestId = nextRequestId;
    nextRequestId += 1;
    stats.total += 1;
    let body;
    try {
      body = await readBody(request, maxBodyBytes);
    } catch (error) {
      if (error.code === "BODY_TOO_LARGE") {
        stats.rejectedBodies += 1;
        sendJson(response, 413, { error: error.message, maxBodyBytes });
        record({ requestId, method: request.method, path: request.url, outcome: "body-rejected" });
      } else if (!response.destroyed) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    const path = new URL(request.url, "http://relayfault.local").pathname;
    const decision = engine.choose({ method: request.method ?? "GET", path });
    const context = {
      requestId,
      method: request.method,
      path: request.url,
      rule: decision.ruleName,
      ruleOrdinal: decision.ruleOrdinal,
      action: decision.action.type,
    };
    if (decision.ruleName) {
      stats.ruleHits[decision.ruleName] = (stats.ruleHits[decision.ruleName] ?? 0) + 1;
    }

    if (decision.action.type === "respond") {
      const responseBody = Buffer.from(decision.action.body ?? "", "utf8");
      const headers = stripHopByHopHeaders(decision.action.headers ?? {});
      headers["content-length"] = String(responseBody.length);
      stats.synthetic += 1;
      response.writeHead(decision.action.status, headers);
      response.end(responseBody);
      record({ ...context, outcome: "synthetic", status: decision.action.status });
      return;
    }

    if (decision.action.type === "disconnect") {
      stats.disconnected += 1;
      record({ ...context, outcome: "disconnected" });
      request.socket.destroy();
      return;
    }

    if (decision.action.type === "delay") {
      stats.delayed += 1;
      await wait(decision.action.appliedMilliseconds);
    }
    await forward(request, response, body, context);
  });

  return { server, stats, target, engine };
}
