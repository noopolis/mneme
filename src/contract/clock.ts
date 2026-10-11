/** Epoch milliseconds used for memory timestamps and visibility, never latency. */
export type MemoryClock = () => number;

export interface MemoryClockOptions {
  clock?: MemoryClock;
}

export const wallClock: MemoryClock = () => Date.now();

/** Default envelope lifetime, reserved by validation on every custom clock read. */
export const MEMORY_TOOL_ENVELOPE_TTL_MS = 5 * 60_000;

const MIN_TIMESTAMP_MS = Date.parse("0000-01-01T00:00:00.000Z");
const MAX_TIMESTAMP_MS = Date.parse("9999-12-31T23:59:59.999Z");

const validateClockTimestamp = (timestamp: number): void => {
  if (!Number.isFinite(timestamp) || timestamp < MIN_TIMESTAMP_MS
    || timestamp + MEMORY_TOOL_ENVELOPE_TTL_MS > MAX_TIMESTAMP_MS) {
    throw new RangeError("clock configuration or sample produces a timestamp or envelope expiry outside the storage date range (years 0000–9999)");
  }
};

// Both a source and its wrapper map to the same wrapper, preserving composition identity.
const validatedClocks = new WeakMap<MemoryClock, MemoryClock>();
const validatedClock = (clock: MemoryClock): MemoryClock => {
  if (clock === wallClock) return clock;
  const existing = validatedClocks.get(clock);
  if (existing) return existing;
  const validated = () => {
    const timestamp = clock();
    validateClockTimestamp(timestamp);
    return timestamp;
  };
  validatedClocks.set(clock, validated);
  validatedClocks.set(validated, validated);
  return validated;
};

/** Sample directly without a configuration-time read; explicit envelope fields need no sample. */
export const sampleClock = (clock: MemoryClock = wallClock): number => validatedClock(clock)();

/** Resolve one clock for a composition; absent dependencies are not supplied dependencies.
 * Without configuration, legacy dependencies may omit clocks or expose the default wall clock.
 * Otherwise every supplied dependency must expose the same source, raw or already validated.
 */
export const resolveClock = (
  configured?: MemoryClock,
  dependencies: readonly (MemoryClockOptions | undefined)[] = []
): MemoryClock => {
  const supplied = dependencies.filter((dependency): dependency is MemoryClockOptions => dependency !== undefined);
  if (configured === undefined && supplied.every((dependency) => dependency.clock === undefined || dependency.clock === wallClock)) {
    return wallClock;
  }
  const clock = configured ?? supplied.find((dependency) => dependency.clock !== undefined)?.clock;
  const validated = validatedClock(clock ?? wallClock);
  if (supplied.some((dependency) => dependency.clock === undefined || validatedClock(dependency.clock) !== validated)) {
    throw new Error("Mneme dependency clock must match the configured clock or inherited clock; every supplied dependency must expose it");
  }
  validated();
  return validated;
};

export interface OffsetClockOptions {
  /** ISO-8601 instant with an explicit offset or Z. */
  origin: string;
  /** Real epoch milliseconds corresponding to origin; defaults to construction time. */
  anchorMs?: number;
  /** Real time source, injectable for deterministic use of this helper. */
  realNow?: MemoryClock;
}

/** Builds an advancing clock: origin + (realNow() - anchorMs). */
export const createOffsetClock = ({ origin, anchorMs, realNow = wallClock }: OffsetClockOptions): MemoryClock => {
  const parts = /^(\d{4}|[+-]\d{6})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/u.exec(origin);
  const originMs = Date.parse(origin);
  const year = Number(parts?.[1]);
  const month = Number(parts?.[2]);
  const day = Number(parts?.[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (!parts || !Number.isFinite(originMs) || !daysInMonth || day < 1 || day > daysInMonth) {
    throw new Error("clock origin must be a valid ISO-8601 instant with an offset or Z");
  }
  const initialRealMs = realNow();
  const anchor = anchorMs ?? initialRealMs;
  if (!Number.isSafeInteger(anchor)) {
    throw new Error("clock anchor must be a safe integer epoch millisecond value");
  }
  const initialMs = originMs + (initialRealMs - anchor);
  validateClockTimestamp(initialMs);
  return validatedClock(() => originMs + (realNow() - anchor));
};
