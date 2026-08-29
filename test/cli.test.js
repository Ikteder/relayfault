import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src", "cli.js");
const example = path.join(root, "examples", "scenario.json");

test("CLI validates and explains the example", () => {
  const validated = spawnSync(process.execPath, [cli, "validate", example], { encoding: "utf8" });
  assert.equal(validated.status, 0, validated.stderr);
  assert.match(validated.stdout, /Valid RelayFault scenario: 2 rule/);
  const explained = spawnSync(process.execPath, [cli, "explain", example], { encoding: "utf8" });
  assert.equal(explained.status, 0, explained.stderr);
  assert.match(explained.stdout, /first two payment attempts fail/);
  assert.match(explained.stdout, /Default action: forward/);
});

test("CLI exits 2 for invalid scenario data", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relayfault-cli-"));
  const invalid = path.join(directory, "invalid.json");
  fs.writeFileSync(invalid, JSON.stringify({ version: 1, rules: [{ name: "bad", match: {}, action: { type: "respond", status: 999 } }] }));
  try {
    const result = spawnSync(process.execPath, [cli, "validate", invalid], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /status must be an integer from 100 to 599/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI rejects unknown serve options", () => {
  const result = spawnSync(
    process.execPath,
    [cli, "serve", "--scenario", example, "--target", "http://127.0.0.1:9000", "--typo", "value"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown option: --typo/);
});
