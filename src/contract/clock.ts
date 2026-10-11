/** Epoch milliseconds used for memory timestamps and visibility, never latency. */
export type MemoryClock = () => number;

export interface MemoryClockOptions {
  clock?: MemoryClock;
}

export const wallClock: MemoryClock = () => Date.now();

/** Default envelope lifetime, also reserved by offset-clock startup validation. */
export const MEMORY_TOOL_ENVELOPE_TTL_MS = 5 * 60_000;

const MIN_TIMESTAMP_MS = Date.parse("0000-01-01T00:00:00.000Z");
const MAX_TIMESTAMP_MS = Date.parse("9999-12-31T23:59:59.999Z");

const validateClockTimestamp = (timestamp: number): void => {
  if (!Number.isFinite(timestamp) || timestamp < MIN_TIMESTAMP_MS
    || timestamp + MEMORY_TOOL_ENVELOPE_TTL_MS > MAX_TIMESTAMP_MS) {
    throw new Error("clock configuration produces a timestamp or envelope expiry outside the storage date range (years 0000–9999)");
  }
};

/** Resolve one clock for a composition; absent dependencies are not supplied dependencies.
 * Legacy dependencies without clocks remain valid when no clock is configured or exposed.
 * Otherwise every supplied dependency must expose the same function, including inherited clocks.
 */
export const resolveClock = (
  configured?: MemoryClock,
  dependencies: readonly (MemoryClockOptions | undefined)[] = []
): MemoryClock => {
  const supplied = dependencies.filter((dependency): dependency is MemoryClockOptions => dependency !== undefined);
  const clock = configured ?? supplied.find((dependency) => dependency.clock !== undefined)?.clock;
  if (clock === undefined) return wallClock;
  if (supplied.some((dependency) => dependency.clock !== clock)) {
    throw new Error("Mneme dependency clock must match the configured clock or inherited clock; every supplied dependency must expose it");
  }
  validateClockTimestamp(clock());
  return clock;
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
  return () => originMs + (realNow() - anchor);
};
