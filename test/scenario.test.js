import assert from "node:assert/strict";
import test from "node:test";
import {
  compileScenario,
  explainScenario,
  ScenarioValidationError,
  validateScenario,
} from "../src/scenario.js";

const forward = { type: "forward" };

test("validates and explains an ordered scenario", () => {
  const scenario = {
    version: 1,
    rules: [
      {
        name: "fail first write",
        match: { method: "post", path: "/items" },
        when: { requests: [1] },
        action: { type: "respond", status: 503, body: "retry" },
      },
    ],
    defaultAction: forward,
  };
  assert.equal(validateScenario(scenario), scenario);
  assert.match(explainScenario(scenario), /POST \/items/);
  assert.match(explainScenario(scenario), /matching requests 1/);
});

test("reports multiple precise schema errors", () => {
  assert.throws(
    () =>
      validateScenario({
        version: 2,
        rules: [
          {
            name: "",
            match: { path: "missing-slash" },
            when: { every: 0, probability: 2 },
            action: { type: "respond", status: 700 },
          },
        ],
      }),
    (error) => {
      assert.ok(error instanceof ScenarioValidationError);
      assert.ok(error.errors.length >= 6);
      assert.match(error.message, /version must be 1/);
      assert.match(error.message, /must define exactly one/);
      return true;
    },
  );
});

test("counts ordinals only after method and path matching", () => {
  const engine = compileScenario({
    version: 1,
    rules: [
      {
        name: "second matching API read",
        match: { method: "GET", path: "/api/*" },
        when: { requests: [2] },
        action: { type: "respond", status: 429 },
      },
    ],
    defaultAction: forward,
  });
  assert.equal(engine.choose({ method: "POST", path: "/api/a" }).action.type, "forward");
  assert.equal(engine.choose({ method: "GET", path: "/other" }).action.type, "forward");
  assert.equal(engine.choose({ method: "GET", path: "/api/a" }).action.type, "forward");
  const second = engine.choose({ method: "GET", path: "/api/b" });
  assert.equal(second.action.type, "respond");
  assert.equal(second.ruleOrdinal, 2);
});

test("uses first active rule and tracks rule evidence", () => {
  const engine = compileScenario({
    version: 1,
    rules: [
      { name: "odd special", match: { path: "/x" }, when: { requests: [1, 3] }, action: { type: "disconnect" } },
      { name: "fallback special", match: { path: "/x" }, action: { type: "respond", status: 418 } },
    ],
  });
  assert.equal(engine.choose({ method: "GET", path: "/x" }).action.type, "disconnect");
  assert.equal(engine.choose({ method: "GET", path: "/x" }).action.type, "respond");
  assert.equal(engine.choose({ method: "GET", path: "/x" }).action.type, "disconnect");
  assert.deepEqual(engine.snapshot().rules, [
    { name: "odd special", seen: 3, applied: 2 },
    { name: "fallback special", seen: 1, applied: 1 },
  ]);
});

test("seeded probability produces a repeatable action sequence", () => {
  const scenario = {
    version: 1,
    rules: [
      { name: "coin", match: {}, when: { probability: 0.5 }, action: { type: "disconnect" } },
    ],
    defaultAction: forward,
  };
  const sequence = (seed) => {
    const engine = compileScenario(scenario, seed);
    return Array.from({ length: 12 }, () => engine.choose({ method: "GET", path: "/" }).action.type);
  };
  assert.deepEqual(sequence(20260829), sequence(20260829));
  assert.notDeepEqual(sequence(20260829), sequence(20260830));
});

test("seeded delay jitter stays inside its declared range", () => {
  const engine = compileScenario(
    {
      version: 1,
      rules: [
        {
          name: "slow",
          match: {},
          action: { type: "delay", milliseconds: 50, jitterMilliseconds: 10 },
        },
      ],
    },
    7,
  );
  for (let index = 0; index < 20; index += 1) {
    const milliseconds = engine.choose({ method: "GET", path: "/" }).action.appliedMilliseconds;
    assert.ok(milliseconds >= 50 && milliseconds <= 60);
  }
});
