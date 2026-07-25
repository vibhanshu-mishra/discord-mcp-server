import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { validateQualitativeConfig } from "../src/analytics/qualitative/config.js";
import { Q } from "./qualitative-helpers.js";

const ENV = [
  "DISCORD_ANALYTICS_ALLOW_CONTENT_OUTPUT",
  "DISCORD_ANALYTICS_MAX_EXCERPT_CHARACTERS",
  "DISCORD_ANALYTICS_MAX_EVIDENCE_MESSAGES",
  "DISCORD_ANALYTICS_REDACT_MENTIONS",
  "DISCORD_ANALYTICS_PSEUDONYMIZE_USERS",
  "DISCORD_ANALYTICS_QUALITATIVE_EXCLUDED_CHANNEL_IDS",
  "DISCORD_ANALYTICS_QUALITATIVE_INCLUDE_STAFF",
  "DISCORD_ANALYTICS_TOPIC_MIN_MESSAGES",
  "DISCORD_ANALYTICS_TOPIC_LIMIT",
  "DISCORD_ANALYTICS_QUESTION_SIMILARITY_THRESHOLD",
];
afterEach(() => ENV.forEach((k) => delete process.env[k]));

// 1. Content output defaults to false.
test("content output defaults to false", () => {
  assert.equal(validateQualitativeConfig().config.allowContentOutput, false);
});

test("defaults are sane and privacy-preserving", () => {
  const { config } = validateQualitativeConfig();
  assert.equal(config.maxExcerptCharacters, 240);
  assert.equal(config.maxEvidenceMessages, 100);
  assert.equal(config.redactMentions, true);
  assert.equal(config.pseudonymizeUsers, true);
  assert.equal(config.includeStaff, false);
  assert.equal(config.questionSimilarityThreshold, 0.65);
});

// 3/4. Excerpt and evidence limits are clamped to safe maxima.
test("excerpt and evidence limits are clamped", () => {
  process.env.DISCORD_ANALYTICS_MAX_EXCERPT_CHARACTERS = "100000";
  process.env.DISCORD_ANALYTICS_MAX_EVIDENCE_MESSAGES = "100000";
  const { config, errors } = validateQualitativeConfig();
  assert.equal(config.maxExcerptCharacters, 1000);
  assert.equal(config.maxEvidenceMessages, 500);
  assert.ok(errors.length >= 2);
});

test("invalid similarity threshold falls back safely", () => {
  process.env.DISCORD_ANALYTICS_QUESTION_SIMILARITY_THRESHOLD = "5";
  const { config, errors } = validateQualitativeConfig();
  assert.equal(config.questionSimilarityThreshold, 0.65);
  assert.ok(errors.some((e) => e.includes("SIMILARITY")));
});

// 5. Invalid excluded channel IDs are rejected.
test("invalid excluded channel IDs are rejected", () => {
  process.env.DISCORD_ANALYTICS_QUALITATIVE_EXCLUDED_CHANNEL_IDS = `${Q.excluded},not-an-id`;
  const { config, errors } = validateQualitativeConfig();
  assert.deepEqual(config.excludedChannelIds, [Q.excluded]);
  assert.ok(errors.some((e) => e.includes("invalid snowflake")));
});

test("invalid booleans fail safely to defaults", () => {
  process.env.DISCORD_ANALYTICS_ALLOW_CONTENT_OUTPUT = "maybe";
  const { config, errors } = validateQualitativeConfig();
  assert.equal(config.allowContentOutput, false);
  assert.ok(errors.some((e) => e.includes("ALLOW_CONTENT_OUTPUT")));
});
