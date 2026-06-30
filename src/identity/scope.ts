import { sanitizePrincipalQualifier } from "./ids.js";
import type { WakeMemoryContext, MemoryPrincipalRef, MemoryContext, MemoryWakeKind } from "../contract/types.js";

export interface ResolvedScopePlan {
  activePrincipal: MemoryPrincipalRef;
  readableScopes: MemoryPrincipalRef[];
  candidateScopes: MemoryPrincipalRef[];
  deniedScopes: MemoryPrincipalRef[];
}

const roomPrincipal = (agentId: string, context?: WakeMemoryContext): MemoryPrincipalRef | undefined => {
  if (!context?.networkId || !context.roomId) {
    return undefined;
  }
  return {
    agentId,
    scope: "room",
    qualifier: `${context.networkId}:${context.roomId}`
  };
};

const teamPrincipal = (agentId: string, context?: WakeMemoryContext): MemoryPrincipalRef | undefined => {
  if (!context?.teamId) {
    return undefined;
  }
  return {
    agentId,
    scope: "team",
    qualifier: context.teamId
  };
};

const pairPrincipals = (
  agentId: string,
  context?: WakeMemoryContext
): MemoryPrincipalRef[] => {
  const peers = context?.pairPeers ?? [];
  return [...new Set(peers
    .map((peer) => sanitizePrincipalQualifier(peer))
    .filter((peer): peer is string => Boolean(peer))
  )]
    .sort()
    .map((peer) => ({
      agentId,
      scope: "pair",
      qualifier: peer
    }));
};

const taskPrincipal = (agentId: string, context?: WakeMemoryContext): MemoryPrincipalRef | undefined => {
  if (!context?.taskId) {
    return undefined;
  }
  return {
    agentId,
    scope: "task",
    qualifier: context.taskId
  };
};

const rolePrincipal = (agentId: string, context?: WakeMemoryContext): MemoryPrincipalRef | undefined => {
  if (!context?.roleId) {
    return undefined;
  }
  return {
    agentId,
    scope: "role",
    qualifier: context.roleId
  };
};

export const resolveScopePlan = (input: {
  agentId: string;
  context?: WakeMemoryContext;
  wake: { id?: string; kind: MemoryWakeKind; from?: string };
}): ResolvedScopePlan => {
  const global: MemoryPrincipalRef = {
    agentId: input.agentId,
    scope: "global"
  };
  const fromPeer = input.context?.from;
  const fromPair = fromPeer ? [{
    agentId: input.agentId,
    scope: "pair" as const,
    qualifier: sanitizePrincipalQualifier(fromPeer) ?? fromPeer.trim().toLowerCase()
  }] : [];
  const room = roomPrincipal(input.agentId, input.context);
  const team = teamPrincipal(input.agentId, input.context);
  const task = taskPrincipal(input.agentId, input.context);
  const role = rolePrincipal(input.agentId, input.context);
  const pairEntries = pairPrincipals(input.agentId, input.context);
  const pairPrincipal = fromPair[0] ?? pairEntries[0];
  const isMessage = input.wake.kind === "message" || input.wake.kind === "manual";

  const activePrincipal: MemoryPrincipalRef = (
    (isMessage && fromPair.length > 0) ? fromPair[0]
    : room ? room
    : team ? team
    : task ? task
    : role ? role
    : global
  );

  const readableScopes = [
    global,
    activePrincipal,
    room,
    team,
    task,
    role
  ].filter((value): value is MemoryPrincipalRef => Boolean(value));

  if (isMessage && (pairEntries.length > 0 || pairPrincipal)) {
    const pairs = [...pairEntries, ...(pairPrincipal ? [pairPrincipal] : [])];
    readableScopes.push(...pairs);
  }

  const candidateScopes = [
    global,
    roomPrincipal(input.agentId, input.context),
    teamPrincipal(input.agentId, input.context),
    ...pairEntries,
    ...(fromPair[0] ? [fromPair[0]] : []),
    taskPrincipal(input.agentId, input.context),
    rolePrincipal(input.agentId, input.context)
  ].filter((value): value is MemoryPrincipalRef => Boolean(value));

  const deniedScopes: MemoryPrincipalRef[] = [];

  return {
    activePrincipal,
    readableScopes,
    candidateScopes,
    deniedScopes
  };
};

export const readMemoryContext = (
  event: { kind: MemoryWakeKind; from?: string; text: string; id?: string; context?: WakeMemoryContext }
): WakeMemoryContext => {
  const context = event.context ?? {};

  const participants = (context as WakeMemoryContext).participants;
  const pairPeers = context.pairPeers ?? participants;
  const resolvedParticipants = participants ?? pairPeers;

  return {
    from: event.from ?? context.from,
    networkId: context.networkId,
    roomId: context.roomId,
    teamId: context.teamId,
    taskId: context.taskId,
    roleId: context.roleId,
    pairPeers,
    artifactPaths: context.artifactPaths,
    participants: resolvedParticipants
  };
};
