import type { MemoryEvent } from "../contract/types.js";

/**
 * Tag stamped on every event `recordTurn` writes about a turn (the wake
 * request, the agent output, echoed packet sections, the tool summary). These
 * events are the turn's audit trail: they stay in the ledger, but they are not
 * memories and must never be recall candidates — recalling them re-injects
 * stale wake envelopes and old room messages into every later wake.
 */
export const TURN_AUDIT_TAG = "turn-audit";

const LEGACY_WAKE_REQUEST = /^Wake request \S+ from [^\n]*?: /u;
const LEGACY_SECTION_ECHO = /^[^\n]*: memory\.[a-z]+: /u;
const LEGACY_TOOL_SUMMARY = /^Observed \d+ tool event\(s\) during turn\.$/u;

/**
 * Ledgers written before {@link TURN_AUDIT_TAG} existed carry the same turn
 * records untagged. They are recognised by the exact shapes `recordTurn`
 * produced: event type, tags, and the fixed text template together. Memory
 * tool writes are stamped with a kernel `origin`, so an event carrying one is
 * never treated as a legacy turn record.
 */
const isLegacyTurnRecord = (event: MemoryEvent): boolean => {
  if (event.origin !== undefined || event.content.kind !== "text") {
    return false;
  }
  const text = event.content.text;
  switch (event.type) {
    case "memory.claimed":
      return LEGACY_WAKE_REQUEST.test(text);
    case "memory.observed":
      return (event.tags.includes("output") && text.startsWith("Agent output:"))
        || (event.tags.includes("section") && LEGACY_SECTION_ECHO.test(text));
    case "memory.summarized":
      return event.tags.includes("tool") && event.tags.includes("summary") && LEGACY_TOOL_SUMMARY.test(text);
    default:
      return false;
  }
};

export const isTurnAuditEvent = (event: MemoryEvent): boolean =>
  event.tags.includes(TURN_AUDIT_TAG) || isLegacyTurnRecord(event);
