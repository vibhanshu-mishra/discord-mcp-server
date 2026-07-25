import { test } from "node:test";
import assert from "node:assert/strict";
import { OutputPolicy } from "../src/analytics/qualitative/contentPolicy.js";
import { Pseudonymizer } from "../src/analytics/qualitative/pseudonymizer.js";
import { redactMentions, sanitizeLinks } from "../src/analytics/qualitative/redaction.js";
import { makeQualConfig, Q } from "./qualitative-helpers.js";

// 2. Content cannot be returned unless BOTH storage and output are enabled.
test("excerpts require both content storage and content output enabled", () => {
  const cfg = makeQualConfig({ allowContentOutput: true });
  // storage off → no excerpt even when output allowed and requested.
  assert.equal(new OutputPolicy(false, cfg).excerpt("hello world", true), null);
  // output off → no excerpt even when storage on.
  assert.equal(
    new OutputPolicy(true, makeQualConfig({ allowContentOutput: false })).excerpt("hi", true),
    null,
  );
  // both on + requested → excerpt returned.
  assert.equal(new OutputPolicy(true, cfg).excerpt("hello world", true)?.text, "hello world");
  // both on but not requested → null.
  assert.equal(new OutputPolicy(true, cfg).excerpt("hello world", false), null);
});

test("disabledReason explains which gate is closed, without content", () => {
  assert.match(
    new OutputPolicy(false, makeQualConfig()).disabledReason()!,
    /content storage is disabled/i,
  );
  assert.match(
    new OutputPolicy(true, makeQualConfig({ allowContentOutput: false })).disabledReason()!,
    /content output is disabled/i,
  );
  assert.equal(
    new OutputPolicy(true, makeQualConfig({ allowContentOutput: true })).disabledReason(),
    null,
  );
});

// 3. Excerpt limits are enforced (truncation with marker).
test("excerpts are truncated to the configured limit and marked", () => {
  const cfg = makeQualConfig({ allowContentOutput: true, maxExcerptCharacters: 20 });
  const policy = new OutputPolicy(true, cfg);
  const ex = policy.excerpt("this message is definitely longer than twenty characters", true)!;
  assert.ok(ex.text.length <= 21, "within limit plus ellipsis"); // 20 + '…'
  assert.equal(ex.truncated, true);
  assert.ok(ex.text.endsWith("…"));
});

// 9. Mention redaction covers users, roles, channels, everyone, here.
test("mention redaction covers every mention type", () => {
  const raw =
    "hey <@123456789012345678> and <@!223456789012345678> see <@&323456789012345678> in <#423456789012345678> @everyone @here";
  const out = redactMentions(raw);
  assert.ok(out.includes("[member]"));
  assert.ok(out.includes("[role]"));
  assert.ok(out.includes("[channel]"));
  assert.ok(out.includes("[everyone]"));
  assert.ok(out.includes("[here]"));
  assert.ok(!/\d{17,20}/.test(out), "no raw mention IDs remain");
});

// 10/11. URL query strings/fragments are removed; attachment/signed URLs sanitised.
test("links are reduced to origin, dropping query and fragment", () => {
  assert.equal(
    sanitizeLinks("see https://example.com/path?token=secret#frag now"),
    "see https://example.com now",
  );
  assert.equal(
    sanitizeLinks("file https://cdn.discordapp.com/attachments/1/2/x.png?ex=abc&hm=def"),
    "file https://cdn.discordapp.com",
  );
  assert.ok(!sanitizeLinks("https://x.com/a?tok=SIGNED").includes("SIGNED"));
});

test("excerpt applies redaction and link sanitisation together", () => {
  const cfg = makeQualConfig({ allowContentOutput: true, redactMentions: true });
  const policy = new OutputPolicy(true, cfg);
  const ex = policy.excerpt("hi <@123456789012345678> visit https://site.com/p?k=SECRET", true)!;
  assert.ok(ex.text.includes("[member]"));
  assert.ok(!ex.text.includes("SECRET"));
  assert.ok(!/\d{17,20}/.test(ex.text));
});

// 7/8. Pseudonymisation removes IDs/names and is consistent within one response.
test("pseudonymisation assigns stable generic labels and hides IDs", () => {
  const staff = new Set([Q.staff1]);
  const p = new Pseudonymizer(makeQualConfig({ pseudonymizeUsers: true }), true, staff, Q.primary);
  const a1 = p.identify(Q.member1);
  const a2 = p.identify(Q.member2);
  const a1again = p.identify(Q.member1);
  assert.equal(a1.label, "Member 1");
  assert.equal(a2.label, "Member 2");
  assert.equal(a1again.label, "Member 1", "same user → same label within one response");
  assert.equal(a1.userId, undefined, "no raw user ID exposed");
  assert.equal(a1.isStaff, false);
  assert.equal(p.identify(Q.staff1).label, "Staff 1");
  assert.equal(p.identify(Q.staff1).isStaff, true);
  assert.equal(p.identify(Q.primary).label, "Primary User");
});

test("pseudonymisation off exposes raw IDs only when content output is enabled", () => {
  const staff = new Set([Q.staff1]);
  const cfg = makeQualConfig({ pseudonymizeUsers: false });
  // content output ON → raw id allowed.
  assert.equal(new Pseudonymizer(cfg, true, staff, null).identify(Q.member1).userId, Q.member1);
  // content output OFF → neither id nor label, but staff flag preserved.
  const off = new Pseudonymizer(cfg, false, staff, null).identify(Q.staff1);
  assert.equal(off.userId, undefined);
  assert.equal(off.label, undefined);
  assert.equal(off.isStaff, true);
});
