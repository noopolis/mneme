import type {
  MemoryForgetArguments,
  MemoryPromoteArguments,
  MemoryRegisterArguments,
  MemorySummarizeArguments
} from "../contract/types.js";
import { hasText, isMemoryContent, isPlainObject, isSensitivity, isVisibility } from "./support.js";

export type RegisterMutationArguments = MemoryRegisterArguments;

const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));

export const isRegisterArguments = (value: unknown): value is RegisterMutationArguments => {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["scope", "kind", "content", "visibility", "sensitivity", "source_type", "confidence", "memory_id"])) {
    return false;
  }

  return hasText(value.scope)
    && hasText(value.kind)
    && hasText(value.visibility)
    && hasText(value.sensitivity)
    && hasText(value.source_type)
    && isVisibility(value.visibility)
    && isSensitivity(value.sensitivity)
    && isPlainObject(value.content)
    && isMemoryContent(value.content)
    && (value.confidence === undefined || (typeof value.confidence === "number" && Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1))
    && (value.memory_id === undefined || hasText(value.memory_id));
};

export const isSummarizeArguments = (value: unknown): value is MemorySummarizeArguments =>
  isPlainObject(value) && hasOnlyKeys(value, ["scope", "horizon"]) && hasText(value.scope);

export const isForgetArguments = (value: unknown): value is MemoryForgetArguments => {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["scope", "event_ids", "reason"])) {
    return false;
  }

  return hasText(value.scope)
    && Array.isArray(value.event_ids)
    && value.event_ids.length > 0
    && value.event_ids.length <= 256
    && value.event_ids.every((id) => typeof id === "string")
    && new Set(value.event_ids).size === value.event_ids.length;
};

export const isPromoteArguments = (value: unknown): value is MemoryPromoteArguments =>
  isPlainObject(value)
  && hasOnlyKeys(value, ["scope", "memory_id", "reason"])
  && hasText(value.scope)
  && hasText(value.memory_id);
