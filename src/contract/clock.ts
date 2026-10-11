/** Epoch milliseconds used for memory timestamps and visibility, never latency. */
export type MemoryClock = () => number;

export interface MemoryClockOptions {
  clock?: MemoryClock;
}

export const wallClock: MemoryClock = () => Date.now();

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
  const anchor = anchorMs ?? realNow();
  if (!Number.isSafeInteger(anchor)) {
    throw new Error("clock anchor must be a safe integer epoch millisecond value");
  }
  return () => originMs + (realNow() - anchor);
};
