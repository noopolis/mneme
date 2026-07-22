import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

import { canonicalJsonStringify, hashCanonicalJson, parseCanonicalJson } from "../contract/causal.js";
import type { MemoryToolCall, MemoryToolCallEnvelope } from "../contract/types.js";

/**
 * A deployment-owned handoff. It is deliberately not derived from model
 * arguments: only an adapter holding the deployment secret can issue it.
 */
export interface MemoryAuthorityHandoff {
  readonly bankId: string;
  readonly runtimeId: string;
  issue(call: Omit<MemoryToolCall, "envelope"> & { envelope: Omit<MemoryToolCallEnvelope, "authority"> }): string;
}

export interface MemoryAuthorityConfig {
  /** Kept by the trusted runtime/deployment adapter; never put in a tool call. */
  readonly secret: string;
  /** Exact memory bank this authority may speak for. */
  readonly bankId: string;
  /** Stable id of the runtime instance that consumes the authority. */
  readonly runtimeId: string;
}

const canonicalEnvelope = <T extends Omit<MemoryToolCallEnvelope, "authority"> | MemoryToolCallEnvelope>(envelope: T): T => {
  const principal = envelope.principal.qualifier === undefined
    ? { agentId: envelope.principal.agentId, scope: envelope.principal.scope }
    : envelope.principal;
  return { ...envelope, principal } as T;
};

const authorityPayload = (call: Omit<MemoryToolCall, "envelope"> & { envelope: Omit<MemoryToolCallEnvelope, "authority"> }): string => {
  return canonicalJsonStringify({
    argument_sha256: hashCanonicalJson(call.arguments),
    request_id: call.request_id,
    tool: call.tool,
    // Sign the complete unsigned envelope rather than reconstructing a
    // partial security view. This binds nested principal data, finite scope
    // grants, wake mode, session/audience fields, and every future envelope
    // field to the same canonical handoff.
    envelope: canonicalEnvelope(call.envelope)
  });
};

const deepFreezeJson = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreezeJson(child);
  return Object.freeze(value);
};

/**
 * Takes the only call snapshot that may cross an asynchronous authority
 * boundary. Canonical round-tripping rejects accessors, cycles, symbols,
 * sparse arrays, undefined values, and other non-JSON mutation tricks while
 * also detaching every nested object from the caller.
 */
export const snapshotMemoryToolCall = (call: MemoryToolCall): MemoryToolCall => {
  const snapshot = parseCanonicalJson(canonicalJsonStringify({ ...call, envelope: canonicalEnvelope(call.envelope) }));
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    throw new Error("invalid authority call snapshot");
  }
  return deepFreezeJson(snapshot) as MemoryToolCall;
};

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const signature = (config: MemoryAuthorityConfig, payload: string): string => createHmac("sha256", config.secret)
  .update(canonicalJsonStringify({ bank_id: config.bankId, runtime_id: config.runtimeId, payload }))
  .digest("hex");

export const createMemoryAuthorityHandoff = (config: MemoryAuthorityConfig): MemoryAuthorityHandoff => {
  const trusted = Object.freeze({ ...config });
  return Object.freeze({
    bankId: trusted.bankId,
    runtimeId: trusted.runtimeId,
    issue: (call: Omit<MemoryToolCall, "envelope"> & { envelope: Omit<MemoryToolCallEnvelope, "authority"> }) => {
      if (call.envelope.principal.agentId !== trusted.bankId) {
        throw new Error("authority principal does not own this memory bank");
      }
      return signature(trusted, authorityPayload(call));
    }
  });
};

export const createEphemeralMemoryAuthority = (
  bankId: string,
  runtimeId: string
): { config: MemoryAuthorityConfig; handoff: MemoryAuthorityHandoff } => {
  const config = { bankId, runtimeId, secret: randomBytes(32).toString("base64url") };
  return { config, handoff: createMemoryAuthorityHandoff(config) };
};

interface AuthorityReceipt {
  version: "mneme.authority-receipt.v1";
  authority_hash: string;
  nonce_hash: string;
  request_hash: string;
  consumed_at: string;
}

const parseAuthorityReceipt = (line: string): AuthorityReceipt => {
  const value = parseCanonicalJson(line);
  if (canonicalJsonStringify(value) !== line || !value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid authority receipt ledger");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\u0000") !== ["authority_hash", "consumed_at", "nonce_hash", "request_hash", "version"].join("\u0000")
    || record.version !== "mneme.authority-receipt.v1"
    || typeof record.authority_hash !== "string" || !/^[0-9a-f]{64}$/.test(record.authority_hash)
    || typeof record.nonce_hash !== "string" || !/^[0-9a-f]{64}$/.test(record.nonce_hash)
    || typeof record.request_hash !== "string" || !/^[0-9a-f]{64}$/.test(record.request_hash)
    || typeof record.consumed_at !== "string" || !Number.isFinite(Date.parse(record.consumed_at))) {
    throw new Error("invalid authority receipt ledger");
  }
  return record as unknown as AuthorityReceipt;
};

/** Durable, secret-free replay verifier. One process queue also serializes
 * independently re-opened guards in this Node process. */
export class MemoryAuthorityGuard {
  private static queues = new Map<string, Promise<void>>();
  private readonly receiptPath: string;
  private readonly receiptDir: string;
  private readonly dirPath: string;
  private readonly config?: MemoryAuthorityConfig;

  constructor(runtimeHomePath: string, config?: MemoryAuthorityConfig) {
    this.dirPath = path.join(runtimeHomePath, "memory");
    this.receiptPath = path.join(this.dirPath, "authority-receipts.jsonl");
    this.receiptDir = path.join(this.dirPath, "authority-receipts");
    this.config = config ? Object.freeze({ ...config }) : undefined;
  }

  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    const prior = MemoryAuthorityGuard.queues.get(this.receiptPath) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = prior.then(() => current);
    MemoryAuthorityGuard.queues.set(this.receiptPath, queued);
    await prior;
    try { return await work(); } finally {
      release();
      if (MemoryAuthorityGuard.queues.get(this.receiptPath) === queued) MemoryAuthorityGuard.queues.delete(this.receiptPath);
    }
  }

  async consume(call: MemoryToolCall, now = Date.now()): Promise<MemoryToolCall> {
    if (!this.config?.secret || !this.config.bankId || !this.config.runtimeId) throw new Error("missing trusted authority verifier");
    // This executes synchronously before the first await below. Verification,
    // replay reservation, execution, and evidence all use this detached,
    // immutable value rather than caller-owned mutable references.
    const snapshot = snapshotMemoryToolCall(call);
    const { envelope } = snapshot;
    if (envelope.version !== "mneme.memory.tool.v1") throw new Error("unsupported authority envelope");
    if (!envelope.wake_id || !envelope.thread_id || !envelope.conversation_scope || !envelope.audience_key || !envelope.nonce || !snapshot.request_id) throw new Error("incomplete authority envelope");
    if (!/^(simfile|moltnet|mneme|daimon):.+$/.test(envelope.wake_id)) throw new Error("invalid authority causal parent");
    const expiry = Date.parse(envelope.expires_at);
    if (!Number.isFinite(expiry) || expiry <= now) throw new Error("expired authority envelope");
    const { authority, ...unsignedEnvelope } = envelope;
    if (!authority) throw new Error("missing authority handoff");
    if (envelope.principal.agentId !== this.config.bankId) throw new Error("authority bank mismatch");
    const payload = authorityPayload({ request_id: snapshot.request_id, tool: snapshot.tool, arguments: snapshot.arguments, envelope: unsignedEnvelope });
    const expected = signature(this.config, payload);
    const supplied = Buffer.from(authority ?? "", "utf8");
    const expectedBytes = Buffer.from(expected, "utf8");
    if (supplied.length !== expectedBytes.length || !timingSafeEqual(supplied, expectedBytes)) throw new Error("invalid authority handoff");
    const authorityHash = hash(authority);
    const nonceHash = hash(`${envelope.principal.agentId}\u0000${envelope.thread_id}\u0000${envelope.nonce}`);
    const requestHash = hash(snapshot.request_id);
    await this.withLock(async () => {
      await mkdir(this.dirPath, { recursive: true });
      await mkdir(this.receiptDir, { recursive: true });
      let receipts: AuthorityReceipt[] = [];
      try {
        const text = await readFile(this.receiptPath, "utf8");
        if (text && !text.endsWith("\n")) throw new Error("invalid authority receipt ledger");
        receipts = text ? text.slice(0, -1).split("\n").map(parseAuthorityReceipt) : [];
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      }
      if (receipts.some((receipt) => receipt.authority_hash === authorityHash || receipt.nonce_hash === nonceHash || receipt.request_hash === requestHash)) {
        throw new Error("replayed authority envelope");
      }
      const receipt: AuthorityReceipt = { version: "mneme.authority-receipt.v1", authority_hash: authorityHash, nonce_hash: nonceHash, request_hash: requestHash, consumed_at: new Date().toISOString() };
      // `wx` is the cross-process reservation: a second runtime can never
      // pass the read-then-append window. A partial reservation is safe — it
      // burns the authority rather than permitting a duplicate execution.
      try {
        for (const key of [`authority-${authorityHash}`, `nonce-${nonceHash}`, `request-${requestHash}`]) {
          const marker = await open(path.join(this.receiptDir, key), "wx");
          await marker.close();
        }
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") throw new Error("replayed authority envelope");
        throw error;
      }
      await appendFile(this.receiptPath, `${canonicalJsonStringify(receipt)}\n`, "utf8");
    });
    return snapshot;
  }
}
