#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createRelayFaultServer, isLoopbackListenHost } from "./proxy.js";
import { explainScenario, ScenarioValidationError, validateScenario } from "./scenario.js";

const HELP = `RelayFault 1.0.0

Usage:
  relayfault validate <scenario.json>
  relayfault explain <scenario.json>
  relayfault serve --scenario <file> --target <origin> [options]

Serve options:
  --listen <host:port>       Loopback listener (default: 127.0.0.1:8787)
  --seed <integer>           Deterministic unsigned seed (default: 1)
  --max-body <bytes>         Request body limit (default: 1048576)
  --events <path>            Append newline-delimited JSON evidence
  --allow-remote-target      Permit a non-loopback upstream target
  --help                     Show this help

The read-only status endpoint is GET /__relayfault/status.
`;

function readScenario(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(`cannot read scenario ${filePath}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`scenario is not valid JSON: ${error.message}`);
  }
}

function parseOptions(args) {
  const options = { flags: new Set() };
  const valuedOptions = new Set(["--scenario", "--target", "--listen", "--seed", "--max-body", "--events"]);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--allow-remote-target") {
      options.flags.add(token);
      continue;
    }
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    if (!valuedOptions.has(token)) throw new Error(`unknown option: ${token}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${token}`);
    options[token] = value;
    index += 1;
  }
  return options;
}

function parseUnsigned(value, label, fallback) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a non-negative integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > 0xffff_ffff) throw new Error(`${label} is out of range`);
  return number;
}

function parseListen(value) {
  const match = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]):(\d+)$/.exec(value);
  if (!match) throw new Error("--listen must be a loopback host and port, such as 127.0.0.1:8787");
  const host = match[1].replace(/^\[|\]$/g, "");
  const port = Number(match[2]);
  if (!isLoopbackListenHost(host) || !Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("--listen contains an invalid loopback host or port");
  }
  return { host, port };
}

async function serve(args) {
  const options = parseOptions(args);
  if (!options["--scenario"]) throw new Error("serve requires --scenario");
  if (!options["--target"]) throw new Error("serve requires --target");
  const scenario = readScenario(options["--scenario"]);
  validateScenario(scenario);
  const listen = parseListen(options["--listen"] ?? "127.0.0.1:8787");
  const seed = parseUnsigned(options["--seed"], "--seed", 1);
  const maxBodyBytes = parseUnsigned(options["--max-body"], "--max-body", 1_048_576);
  const eventPath = options["--events"] ? path.resolve(options["--events"]) : null;
  const relay = createRelayFaultServer({
    target: options["--target"],
    scenario,
    seed,
    maxBodyBytes,
    eventPath,
    allowRemoteTarget: options.flags.has("--allow-remote-target"),
  });
  await new Promise((resolve, reject) => {
    relay.server.once("error", reject);
    relay.server.listen(listen.port, listen.host, resolve);
  });
  const address = relay.server.address();
  console.log(`RelayFault listening on http://${listen.host}:${address.port}`);
  console.log(`Forwarding to ${relay.target.origin} with seed ${seed}`);
  if (eventPath) console.log(`Recording events in ${eventPath}`);

  const close = () => relay.server.close(() => process.exit(0));
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(HELP);
    return;
  }
  const [command, ...rest] = args;
  if (command === "validate" || command === "explain") {
    if (rest.length !== 1) throw new Error(`${command} requires exactly one scenario path`);
    const scenario = readScenario(rest[0]);
    if (command === "validate") {
      validateScenario(scenario);
      console.log(`Valid RelayFault scenario: ${scenario.rules.length} rule(s)`);
    } else {
      console.log(explainScenario(scenario));
    }
    return;
  }
  if (command === "serve") {
    await serve(rest);
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    if (error instanceof ScenarioValidationError) console.error(error.message);
    else console.error(`RelayFault error: ${error.message}`);
    process.exitCode = 2;
  });
}
