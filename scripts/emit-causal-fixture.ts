#!/usr/bin/env -S node --import tsx
/**
 * Emits a sample `memory.recalled` noopolis.causal-event.v1 envelope as
 * JSONL to stdout, by driving a real JsonlMemoryRuntime through a seeded
 * recall (recordTurn to register a memory, then prepareTurn to trigger a
 * causal-stamped recall of it) against a throwaway runtime home.
 *
 * This is the mneme fixture emitter B92 (root conformance harness) will
 * eventually invoke by path to validate real sibling output against
 * specs/causal-event.v1.schema.json + seq contiguity + payload minimums.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createMemoryRuntime } from "../src/runtime/runtime.js";

const FIXTURE_RUN_ID = process.env.NOOPOLIS_RUN_ID?.trim() || "fixture-run-mneme";
const FIXTURE_AGENT_ID = "fixture-agent";

const main = async (): Promise<void> => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), "noopolis-mneme-causal-fixture-"));
  process.env.NOOPOLIS_RUN_ID = FIXTURE_RUN_ID;

  try {
    const runtime = createMemoryRuntime({
      agentId: FIXTURE_AGENT_ID,
      runtimeHomePath: runtimeHome,
      tokenBudget: 600
    });

    const principal = {
      agentId: FIXTURE_AGENT_ID,
      scope: "room" as const,
      qualifier: "noopolis:fixture-room"
    };

    await runtime.recordTurn({
      principal,
      prompt: {
        principal,
        sections: [{ heading: "Note", text: "Fixture roadmap milestone alpha." }],
        rawHint: "seed"
      },
      request: {
        eventId: "fixture:evt-source",
        kind: "manual",
        text: "Fixture roadmap milestone alpha.",
        context: { networkId: "noopolis", roomId: "fixture-room" }
      },
      result: "completed",
      outputText: "Done.",
      toolEvents: []
    });

    await runtime.prepareTurn({
      eventId: "fixture:evt-wake",
      kind: "message",
      from: "fixture-operator",
      text: "roadmap milestone",
      context: { networkId: "noopolis", roomId: "fixture-room" }
    });

    const causalPath = path.join(runtimeHome, "memory", "causal.jsonl");
    const jsonl = await readFile(causalPath, "utf8");
    process.stdout.write(jsonl.endsWith("\n") ? jsonl : `${jsonl}\n`);
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
  }
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
