/**
 * Unit tests for DS_TEMPLATE_V1 generator
 * Run: npx ts-node --esm test/ds-inject/template-v1.test.ts
 *      OR: node --loader ts-node/esm test/ds-inject/template-v1.test.ts
 */
import assert from "assert";
import { computeStaleness, generateDsTemplateV1, DomPayload } from "../../src/ds-inject/template-v1.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makePayload(overrides: Partial<DomPayload> = {}): DomPayload {
  const now = Date.now();
  return {
    timestamp: now,
    timestamp_iso: new Date(now).toISOString(),
    symbol: "BTCUSDT",
    exchange: "binance",
    levels: {
      bid: Array.from({ length: 20 }, (_, i) => ({
        price: 67500 - i * 0.5,
        size: 1.0 + i * 0.1,
        cumulative: (i + 1) * 1.0,
      })),
      ask: Array.from({ length: 20 }, (_, i) => ({
        price: 67501 + i * 0.5,
        size: 0.5 + i * 0.1,
        cumulative: (i + 1) * 0.5,
      })),
    },
    summary: {
      bid_total_size: 21.0,
      ask_total_size: 10.5,
      bid_ask_ratio: 2.0,
      spread: 1.0,
      spread_bps: 1.48,
      mid_price: 67500.5,
      imbalance: 0.3333,
    },
    metadata: {
      levels_count: 20,
      update_latency_ms: 5,
      source: "websocket",
      version: "1.0",
      staleness_tier: "fresh",
      data_age_ms: 0,
    },
    ...overrides,
  };
}

// ─── staleness tests ──────────────────────────────────────────────────────────

function test_staleness_fresh() {
  const result = computeStaleness(Date.now() - 30_000); // 30s old
  assert.strictEqual(result.tier, "fresh");
  assert.ok(result.age_ms < 60_000);
  console.log("  ✅ staleness fresh");
}

function test_staleness_aging() {
  const result = computeStaleness(Date.now() - 120_000); // 2 min old
  assert.strictEqual(result.tier, "aging");
  console.log("  ✅ staleness aging");
}

function test_staleness_stale() {
  const result = computeStaleness(Date.now() - 400_000); // 6.7 min old
  assert.strictEqual(result.tier, "stale");
  console.log("  ✅ staleness stale");
}

// ─── generator tests ──────────────────────────────────────────────────────────

function test_generator_valid_pine_header() {
  const payload = makePayload();
  const staleness = computeStaleness(payload.timestamp);
  const src = generateDsTemplateV1(payload, staleness, "TEST_CYCLE_001");
  assert.ok(src.startsWith("//@version=6"), "must start with //@version=6");
  assert.ok(src.includes('indicator("DS_LEVELS_BTC"'), "must declare indicator");
  assert.ok(src.includes('shorttitle="DS_BTC"'), "must have shorttitle");
  console.log("  ✅ generator: valid Pine header");
}

function test_generator_contains_imbalance() {
  const payload = makePayload();
  const staleness = computeStaleness(payload.timestamp);
  const src = generateDsTemplateV1(payload, staleness, "TEST_CYCLE_001");
  assert.ok(src.includes("IMBALANCE"), "must include IMBALANCE constant");
  assert.ok(src.includes("0.3333"), "must encode imbalance value");
  console.log("  ✅ generator: imbalance encoded");
}

function test_generator_staleness_fresh_code() {
  const payload = makePayload();
  const staleness = computeStaleness(payload.timestamp);
  const src = generateDsTemplateV1(payload, staleness, "TEST");
  assert.ok(src.includes("STALE_CODE  = 0.0"), "fresh = code 0");
  assert.ok(!src.includes("bgcolor(STALE_CODE == 2.0") || src.includes("na"), "fresh = no red bg");
  console.log("  ✅ generator: fresh staleness code=0");
}

function test_generator_staleness_stale_code() {
  const payload = makePayload({ timestamp: Date.now() - 400_000 });
  const staleness = computeStaleness(payload.timestamp);
  const src = generateDsTemplateV1(payload, staleness, "TEST");
  assert.ok(src.includes("STALE_CODE  = 2.0"), "stale = code 2");
  assert.ok(src.includes("STALE"), "stale label present");
  console.log("  ✅ generator: stale staleness code=2");
}

function test_generator_5_bid_5_ask_levels() {
  const payload = makePayload();
  const staleness = computeStaleness(payload.timestamp);
  const src = generateDsTemplateV1(payload, staleness, "TEST");
  // Check bid levels B0..B4
  for (let i = 0; i < 5; i++) {
    assert.ok(src.includes(`B${i}_P`), `missing B${i}_P`);
    assert.ok(src.includes(`B${i}_S`), `missing B${i}_S`);
    assert.ok(src.includes(`A${i}_P`), `missing A${i}_P`);
    assert.ok(src.includes(`A${i}_S`), `missing A${i}_S`);
  }
  console.log("  ✅ generator: 5 bid + 5 ask levels");
}

function test_generator_missing_levels_padded() {
  // Payload with only 3 bid levels
  const payload = makePayload();
  payload.levels.bid = payload.levels.bid.slice(0, 3);
  const staleness = computeStaleness(payload.timestamp);
  const src = generateDsTemplateV1(payload, staleness, "TEST");
  // B3 and B4 should be padded with 0
  assert.ok(src.includes("B3_P = 0.00"), "missing B3 padded");
  assert.ok(src.includes("B4_P = 0.00"), "missing B4 padded");
  console.log("  ✅ generator: missing levels padded with zeros");
}

function test_generator_label_deleted() {
  const payload = makePayload();
  const staleness = computeStaleness(payload.timestamp);
  const src = generateDsTemplateV1(payload, staleness, "TEST");
  assert.ok(src.includes("var label _lbl = na"), "must declare var label");
  assert.ok(src.includes("label.delete(_lbl)"), "must delete before new");
  console.log("  ✅ generator: label delete pattern present");
}

function test_generator_cycle_id_in_comment() {
  const payload = makePayload();
  const staleness = computeStaleness(payload.timestamp);
  const src = generateDsTemplateV1(payload, staleness, "DS_INJECT_20260520_C001");
  assert.ok(src.includes("DS_INJECT_20260520_C001"), "cycle ID in generated script");
  console.log("  ✅ generator: cycle ID embedded in script");
}

// ─── Run ──────────────────────────────────────────────────────────────────────

console.log("\nDS_TEMPLATE_V1 unit tests");
console.log("─".repeat(40));

let passed = 0; let failed = 0;

const tests = [
  test_staleness_fresh,
  test_staleness_aging,
  test_staleness_stale,
  test_generator_valid_pine_header,
  test_generator_contains_imbalance,
  test_generator_staleness_fresh_code,
  test_generator_staleness_stale_code,
  test_generator_5_bid_5_ask_levels,
  test_generator_missing_levels_padded,
  test_generator_label_deleted,
  test_generator_cycle_id_in_comment,
];

for (const t of tests) {
  try {
    t();
    passed++;
  } catch (err) {
    console.error(`  ❌ ${t.name}: ${err}`);
    failed++;
  }
}

console.log("─".repeat(40));
console.log(`RESULT: ${passed} pass / ${failed} fail`);
if (failed > 0) process.exit(1);
