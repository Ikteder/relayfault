const ACTION_TYPES = new Set(["forward", "delay", "respond", "disconnect"]);
const RULE_KEYS = new Set(["name", "match", "when", "action"]);
const MATCH_KEYS = new Set(["method", "path"]);
const WHEN_KEYS = new Set(["requests", "every", "probability"]);

export class ScenarioValidationError extends Error {
  constructor(errors) {
    super(`Invalid scenario:\n${errors.map((error) => `- ${error}`).join("\n")}`);
    this.name = "ScenarioValidationError";
    this.errors = errors;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unknownKeys(value, allowed, location, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      errors.push(`${location}.${key} is not supported`);
    }
  }
}

function validateHeaders(value, location, errors) {
  if (value === undefined) return;
  if (!isObject(value)) {
    errors.push(`${location} must be an object of string values`);
    return;
  }
  for (const [name, headerValue] of Object.entries(value)) {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
      errors.push(`${location} contains invalid header name ${JSON.stringify(name)}`);
    }
    if (typeof headerValue !== "string" || /[\r\n]/.test(headerValue)) {
      errors.push(`${location}.${name} must be a string without line breaks`);
    }
  }
}

function validateAction(action, location, errors) {
  if (!isObject(action)) {
    errors.push(`${location} must be an object`);
    return;
  }
  if (!ACTION_TYPES.has(action.type)) {
    errors.push(`${location}.type must be forward, delay, respond, or disconnect`);
    return;
  }

  const allowed = {
    forward: new Set(["type"]),
    delay: new Set(["type", "milliseconds", "jitterMilliseconds"]),
    respond: new Set(["type", "status", "headers", "body"]),
    disconnect: new Set(["type"]),
  }[action.type];
  unknownKeys(action, allowed, location, errors);

  if (action.type === "delay") {
    if (!Number.isInteger(action.milliseconds) || action.milliseconds < 0 || action.milliseconds > 600_000) {
      errors.push(`${location}.milliseconds must be an integer from 0 to 600000`);
    }
    if (
      action.jitterMilliseconds !== undefined &&
      (!Number.isInteger(action.jitterMilliseconds) ||
        action.jitterMilliseconds < 0 ||
        action.jitterMilliseconds > 600_000)
    ) {
      errors.push(`${location}.jitterMilliseconds must be an integer from 0 to 600000`);
    }
  }

  if (action.type === "respond") {
    if (!Number.isInteger(action.status) || action.status < 100 || action.status > 599) {
      errors.push(`${location}.status must be an integer from 100 to 599`);
    }
    validateHeaders(action.headers, `${location}.headers`, errors);
    if (action.body !== undefined && typeof action.body !== "string") {
      errors.push(`${location}.body must be a string`);
    } else if (Buffer.byteLength(action.body ?? "", "utf8") > 65_536) {
      errors.push(`${location}.body must be at most 65536 UTF-8 bytes`);
    }
  }
}

function validateRule(rule, index, names, errors) {
  const location = `rules[${index}]`;
  if (!isObject(rule)) {
    errors.push(`${location} must be an object`);
    return;
  }
  unknownKeys(rule, RULE_KEYS, location, errors);

  if (typeof rule.name !== "string" || rule.name.trim() === "") {
    errors.push(`${location}.name must be a non-empty string`);
  } else if (names.has(rule.name)) {
    errors.push(`${location}.name must be unique`);
  } else {
    names.add(rule.name);
  }

  if (!isObject(rule.match)) {
    errors.push(`${location}.match must be an object`);
  } else {
    unknownKeys(rule.match, MATCH_KEYS, `${location}.match`, errors);
    if (rule.match.method !== undefined && !/^[A-Za-z]+$/.test(rule.match.method)) {
      errors.push(`${location}.match.method must contain letters only`);
    }
    if (rule.match.path !== undefined) {
      if (typeof rule.match.path !== "string" || !rule.match.path.startsWith("/")) {
        errors.push(`${location}.match.path must be a string beginning with /`);
      } else if (rule.match.path.includes("*") && !rule.match.path.endsWith("*")) {
        errors.push(`${location}.match.path may use * only as its final character`);
      } else if ((rule.match.path.match(/\*/g) ?? []).length > 1) {
        errors.push(`${location}.match.path may contain at most one *`);
      }
    }
  }

  if (rule.when !== undefined) {
    if (!isObject(rule.when)) {
      errors.push(`${location}.when must be an object`);
    } else {
      unknownKeys(rule.when, WHEN_KEYS, `${location}.when`, errors);
      const selectors = WHEN_KEYS.size - [...WHEN_KEYS].filter((key) => rule.when[key] === undefined).length;
      if (selectors !== 1) {
        errors.push(`${location}.when must define exactly one of requests, every, or probability`);
      }
      if (rule.when.requests !== undefined) {
        if (
          !Array.isArray(rule.when.requests) ||
          rule.when.requests.length === 0 ||
          rule.when.requests.some((value) => !Number.isInteger(value) || value < 1)
        ) {
          errors.push(`${location}.when.requests must be a non-empty array of positive integers`);
        } else if (new Set(rule.when.requests).size !== rule.when.requests.length) {
          errors.push(`${location}.when.requests must not contain duplicates`);
        }
      }
      if (rule.when.every !== undefined && (!Number.isInteger(rule.when.every) || rule.when.every < 1)) {
        errors.push(`${location}.when.every must be a positive integer`);
      }
      if (
        rule.when.probability !== undefined &&
        (typeof rule.when.probability !== "number" ||
          !Number.isFinite(rule.when.probability) ||
          rule.when.probability < 0 ||
          rule.when.probability > 1)
      ) {
        errors.push(`${location}.when.probability must be a finite number from 0 to 1`);
      }
    }
  }

  validateAction(rule.action, `${location}.action`, errors);
}

export function validateScenario(value) {
  const errors = [];
  if (!isObject(value)) {
    throw new ScenarioValidationError(["scenario must be a JSON object"]);
  }
  unknownKeys(value, new Set(["version", "rules", "defaultAction"]), "scenario", errors);
  if (value.version !== 1) errors.push("version must be 1");
  if (!Array.isArray(value.rules)) {
    errors.push("rules must be an array");
  } else {
    const names = new Set();
    value.rules.forEach((rule, index) => validateRule(rule, index, names, errors));
  }
  if (value.defaultAction !== undefined) {
    validateAction(value.defaultAction, "defaultAction", errors);
  }
  if (errors.length > 0) throw new ScenarioValidationError(errors);
  return value;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pathMatches(pattern, path) {
  if (pattern === undefined) return true;
  if (pattern.endsWith("*")) return path.startsWith(pattern.slice(0, -1));
  return path === pattern;
}

function ruleMatches(rule, request) {
  const methodMatches = rule.match.method === undefined || rule.match.method.toUpperCase() === request.method.toUpperCase();
  return methodMatches && pathMatches(rule.match.path, request.path);
}

function whenMatches(when, ordinal, random) {
  if (when === undefined) return true;
  if (when.requests !== undefined) return when.requests.includes(ordinal);
  if (when.every !== undefined) return ordinal % when.every === 0;
  return random() < when.probability;
}

function materializeAction(action, random) {
  const copy = structuredClone(action);
  if (copy.type === "delay") {
    const jitter = copy.jitterMilliseconds ?? 0;
    copy.appliedMilliseconds = copy.milliseconds + (jitter === 0 ? 0 : Math.floor(random() * (jitter + 1)));
  }
  return copy;
}

export function compileScenario(value, seed = 1) {
  const scenario = validateScenario(value);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new TypeError("seed must be an unsigned 32-bit integer");
  }
  const random = mulberry32(seed);
  const counters = scenario.rules.map(() => ({ seen: 0, applied: 0 }));

  return {
    choose(request) {
      for (let index = 0; index < scenario.rules.length; index += 1) {
        const rule = scenario.rules[index];
        if (!ruleMatches(rule, request)) continue;
        const counter = counters[index];
        counter.seen += 1;
        if (!whenMatches(rule.when, counter.seen, random)) continue;
        counter.applied += 1;
        return {
          ruleName: rule.name,
          ruleOrdinal: counter.seen,
          action: materializeAction(rule.action, random),
        };
      }
      return {
        ruleName: null,
        ruleOrdinal: null,
        action: materializeAction(scenario.defaultAction ?? { type: "forward" }, random),
      };
    },
    snapshot() {
      return {
        seed,
        rules: scenario.rules.map((rule, index) => ({ name: rule.name, ...counters[index] })),
      };
    },
  };
}

export function explainScenario(value) {
  const scenario = validateScenario(value);
  const lines = [`Scenario version ${scenario.version}`, `${scenario.rules.length} ordered rule(s)`];
  scenario.rules.forEach((rule, index) => {
    const method = rule.match.method?.toUpperCase() ?? "ANY";
    const path = rule.match.path ?? "/*";
    let when = "every matching request";
    if (rule.when?.requests) when = `matching requests ${rule.when.requests.join(", ")}`;
    if (rule.when?.every) when = `every ${rule.when.every} matching request(s)`;
    if (rule.when?.probability !== undefined) when = `${rule.when.probability} seeded probability`;
    const action = rule.action.type === "delay" ? `delay ${rule.action.milliseconds} ms then forward` : rule.action.type;
    lines.push(`${index + 1}. ${rule.name}: ${method} ${path}, ${when}, action ${action}`);
  });
  lines.push(`Default action: ${(scenario.defaultAction ?? { type: "forward" }).type}`);
  return lines.join("\n");
}
