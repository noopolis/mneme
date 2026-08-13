import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

import {
  canonicalJsonStringify,
  parseCanonicalJson,
  parseCausalEvent,
  parseCausalStreamFinal,
  type CausalEvent,
  type CausalStreamFinal
} from "./causal.js";

interface GoldenCase {
  name: string;
  accept: boolean;
  raw_jsonl: string;
  canonical_hex: string | null;
  sha256: string | null;
}

const acceptedNames = [
  "accept-normative-event", "accept-nested-reordering-and-unicode", "accept-empty-payload", "accept-finite-fraction",
  "accept-positive-1e-6-fixed", "accept-negative-1e-6-fixed", "accept-positive-1e-7-exponent", "accept-negative-1e-7-exponent",
  "accept-positive-below-1e-6", "accept-negative-below-1e-6", "accept-positive-above-1e-6", "accept-negative-above-1e-6",
  "accept-digest-domain-causal-event", "accept-digest-domain-exact-utf8", "accept-digest-domain-exact-bytes",
  "accept-final-seq-zero", "accept-non-empty-final", "accept-multi-stream", "accept-nested-numeric-key-order",
  "accept-foreign-cause-namespace"
] as const;

const rejectedNames = [
  "reject-lone-high-surrogate-runtime-key", "reject-lone-low-surrogate-runtime-key", "reject-unknown-event-top-level",
  "reject-unknown-event-emitter-field", "reject-unknown-final-top-level", "reject-unknown-final-emitter-field",
  "reject-unknown-digest-top-level", "reject-wrong-version-event", "reject-wrong-version-final", "reject-wrong-version-digest",
  "reject-malformed-event-id", "reject-unrecognized-event-id-system", "reject-mismatched-event-id-prefix",
  "reject-bare-cause-id", "reject-repeated-causes", "reject-duplicate-event-id", "reject-duplicate-stream-slot",
  "reject-present-cross-run-cause", "reject-duplicate-final", "reject-below-observed-final", "reject-empty-final-contradiction",
  "reject-unknown-digest-domain", "reject-altered-digest-hash", "reject-altered-digest-subject-bytes",
  "reject-altered-digest-output", "reject-duplicate-decoded-key", "reject-escaped-equivalent-keys", "reject-negative-zero",
  "reject-unsafe-integer", "reject-invalid-unicode", "reject-invalid-json-spelling", "reject-non-finite-json-spelling"
] as const;

const require = createRequire(import.meta.url);
const corpusPath = require.resolve(
  "@noopolis/stele/contracts/goldens/causal-contract.v1.json"
);

const digestTuples = new Set([
  JSON.stringify(["causal-event/canonical-json", "sha-256", "noopolis.canonical-json.v1:utf-8", "lowercase-hex"]),
  JSON.stringify(["content/exact-utf8", "sha-256", "exact-utf8", "lowercase-hex"]),
  JSON.stringify(["content/exact-bytes", "sha-256", "exact-bytes", "lowercase-hex"])
]);

const parseDigestDomain = (value: unknown): void => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid digest domain");
  const record = value as Record<string, unknown>;
  assert.deepEqual(Object.keys(record).sort(), ["hash", "label", "output", "subject_bytes", "version"]);
  if (record.version !== "noopolis.causal-digest-domain.v1"
    || !digestTuples.has(JSON.stringify([record.label, record.hash, record.subject_bytes, record.output]))) {
    throw new Error("invalid digest domain");
  }
};

/** Test-local B41 bundle preflight. Production code stays repo-independent;
 * only the frozen JSON corpus crosses the repository boundary in tests. */
const validateGoldenBundle = (raw: string): string => {
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  if (!lines.length) throw new Error("empty causal bundle");
  const events: CausalEvent[] = [];
  const finals: CausalStreamFinal[] = [];
  const eventIds = new Set<string>();
  const slots = new Set<string>();
  const finalKeys = new Set<string>();

  for (const line of lines) {
    const value = parseCanonicalJson(line.trim());
    if (!value || typeof value !== "object" || !("version" in value)) throw new Error("unknown causal record");
    const version = (value as { version?: unknown }).version;
    if (version === "noopolis.causal-event.v1") {
      const event = parseCausalEvent(value);
      if (eventIds.has(event.event_id)) throw new Error("duplicate event id");
      eventIds.add(event.event_id);
      const slot = JSON.stringify([event.run_id, event.emitter.system, event.emitter.stream_id, event.emitter.seq]);
      if (slots.has(slot)) throw new Error("duplicate stream slot");
      slots.add(slot);
      events.push(event);
    } else if (version === "noopolis.causal-stream-final.v1") {
      const final = parseCausalStreamFinal(value);
      const key = JSON.stringify([final.run_id, final.emitter.system, final.emitter.stream_id]);
      if (finalKeys.has(key)) throw new Error("duplicate stream final");
      finalKeys.add(key);
      finals.push(final);
    } else if (version === "noopolis.causal-digest-domain.v1") {
      parseDigestDomain(value);
    } else {
      throw new Error("unknown causal record version");
    }
  }

  const byId = new Map(events.map((event) => [event.event_id, event]));
  for (const event of events) {
    for (const causeId of event.cause_event_ids) {
      const cause = byId.get(causeId);
      if (cause && cause.run_id !== event.run_id) throw new Error("present cause belongs to another run");
    }
  }
  for (const final of finals) {
    const observed = events
      .filter((event) => event.run_id === final.run_id
        && event.emitter.system === final.emitter.system
        && event.emitter.stream_id === final.emitter.stream_id)
      .reduce((maximum, event) => Math.max(maximum, event.emitter.seq), 0);
    if (final.final_seq < observed || (final.final_seq === 0 && observed > 0)) throw new Error("invalid stream final");
  }
  return lines.map((line) => canonicalJsonStringify(parseCanonicalJson(line.trim()))).join("\n");
};

const loadCorpus = async (): Promise<GoldenCase[]> => {
  const parsed = JSON.parse(await readFile(corpusPath, "utf8")) as unknown;
  assert.ok(Array.isArray(parsed));
  return parsed.map((value) => {
    assert.ok(value && typeof value === "object" && !Array.isArray(value));
    const record = value as Record<string, unknown>;
    assert.deepEqual(Object.keys(record).sort(), ["accept", "canonical_hex", "name", "raw_jsonl", "sha256"]);
    assert.equal(typeof record.name, "string");
    assert.equal(typeof record.accept, "boolean");
    assert.equal(typeof record.raw_jsonl, "string");
    assert.ok(record.canonical_hex === null || typeof record.canonical_hex === "string");
    assert.ok(record.sha256 === null || typeof record.sha256 === "string");
    return record as unknown as GoldenCase;
  });
};

test("B41 frozen corpus matches the expected accepted and rejected inventories exactly", async () => {
  const corpus = await loadCorpus();
  const expectedCount = acceptedNames.length + rejectedNames.length;
  assert.equal(corpus.length, expectedCount);
  assert.equal(new Set(corpus.map((entry) => entry.name)).size, expectedCount);
  assert.deepEqual(new Set(corpus.filter((entry) => entry.accept).map((entry) => entry.name)), new Set(acceptedNames));
  assert.deepEqual(new Set(corpus.filter((entry) => !entry.accept).map((entry) => entry.name)), new Set(rejectedNames));
  for (const entry of corpus) {
    if (entry.accept) {
      assert.match(entry.canonical_hex ?? "", /^[0-9a-f]{2,}$/);
      assert.match(entry.sha256 ?? "", /^[0-9a-f]{64}$/);
    } else {
      assert.equal(entry.canonical_hex, null);
      assert.equal(entry.sha256, null);
    }
  }
});

test("B41 accepted corpus cases validate with byte-for-byte canonical oracles", async () => {
  for (const entry of (await loadCorpus()).filter((candidate) => candidate.accept)) {
    const canonical = validateGoldenBundle(entry.raw_jsonl);
    assert.equal(Buffer.from(canonical).toString("hex"), entry.canonical_hex, entry.name);
    assert.equal(createHash("sha256").update(canonical).digest("hex"), entry.sha256, entry.name);
  }
});

test("B41 every rejected corpus case fails Mneme's independent preflight", async () => {
  for (const entry of (await loadCorpus()).filter((candidate) => !candidate.accept)) {
    assert.throws(() => validateGoldenBundle(entry.raw_jsonl), /.+/, entry.name);
  }
});
