import { createHash, randomUUID } from "node:crypto";

import type {
  MemoryEvent,
  MemoryPrincipalRef,
  MemoryEventInput
} from "../contract/types.js";

export const canonicalPrincipalKey = (principal: MemoryPrincipalRef): string => {
  const parts = [`agent:${principal.agentId}`, `scope:${principal.scope}`];
  if (principal.qualifier) {
    parts.push(`qualifier:${principal.qualifier}`);
  }
  return parts.join("/");
};

export const canonicalScopeKey = (scope?: string): string => scope?.trim().toLowerCase() ?? "";

export const pairScopeId = (left: string, right: string): string => {
  const sorted = [left, right].map((value) => value.trim()).sort();
  return `${sorted[0]}::${sorted[1]}`;
};

export const makeEventId = (): string => `evt_${randomUUID()}`;

export const makeChecksum = (event: MemoryEventInput | MemoryEvent): string => {
  const content = JSON.stringify(event);
  return createHash("sha256").update(content).digest("hex");
};

export const memoryScopeId = (principal: MemoryPrincipalRef): string =>
  canonicalPrincipalKey(principal);

export const sanitizePrincipalQualifier = (value?: string): string | undefined => {
  if (!value) {
    return value;
  }
  return value.trim().toLowerCase();
};
