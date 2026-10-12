import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentId } from "@t3tools/contracts";

import type { SidebarThreadSummary } from "../../types";

export type SessionBand = "needs-you" | "working" | "idle";

const SESSION_STATUS_FILTERS = ["all", "needs-you", "working", "idle", "snoozed"] as const;
export type SessionStatusFilter = (typeof SESSION_STATUS_FILTERS)[number];

export type SessionsSearch = {
  readonly project?: string;
  readonly environmentId?: EnvironmentId;
  readonly status?: SessionStatusFilter;
};

/** A search update; undefined clears a filter. */
export type SessionsSearchPatch = {
  readonly [K in keyof SessionsSearch]?: SessionsSearch[K] | undefined;
};

export function parseSessionsSearch(raw: Record<string, unknown>): SessionsSearch {
  return {
    ...(typeof raw.project === "string" && raw.project
      ? { project: raw.project.slice(0, 500) }
      : {}),
    ...(typeof raw.environmentId === "string" && raw.environmentId
      ? { environmentId: raw.environmentId as EnvironmentId }
      : {}),
    ...(SESSION_STATUS_FILTERS.includes(raw.status as SessionStatusFilter) && raw.status !== "all"
      ? { status: raw.status as SessionStatusFilter }
      : {}),
  };
}

/** Why a thread sits in the Needs you band, most urgent first. */
export type SessionAttention = "approval" | "input" | "plan" | "usage-limit" | "error";

type SessionThread = Pick<
  SidebarThreadSummary,
  | "archivedAt"
  | "deletedAt"
  | "lineage"
  | "settledOverride"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "hasActionableProposedPlan"
  | "interactionMode"
  | "latestRun"
  | "runtime"
  | "limitRecovery"
  | "snoozedUntil"
  | "snoozedAt"
  | "latestUserMessageAt"
  | "updatedAt"
>;

export function resolveSessionAttention(
  thread: SessionThread,
  now: string,
): SessionAttention | null {
  if (thread.hasPendingApprovals) return "approval";
  if (thread.hasPendingUserInput) return "input";
  if (thread.hasActionableProposedPlan && !isThreadWorking(thread)) return "plan";
  const resetAt = thread.limitRecovery?.resetAt ?? thread.runtime?.usageLimitResetAt ?? null;
  if (resetAt !== null && Date.parse(resetAt) > Date.parse(now)) return "usage-limit";
  if (thread.runtime?.status === "failed" && thread.runtime.lastError) return "error";
  return null;
}

function resolveSessionBand(thread: SessionThread, now: string): SessionBand {
  if (resolveSessionAttention(thread, now) !== null) return "needs-you";
  if (isThreadWorking(thread) && thread.runtime?.status !== "idle") return "working";
  return "idle";
}

/** Live threads: not archived, deleted, settled, or a subagent's child thread. */
function isLiveSession(thread: SessionThread): boolean {
  return (
    thread.archivedAt === null &&
    thread.deletedAt === null &&
    thread.settledOverride !== "settled" &&
    thread.lineage.relationshipToParent !== "subagent"
  );
}

export function sessionLastActivityAt(thread: SessionThread): string {
  const candidates = [
    thread.updatedAt,
    thread.latestUserMessageAt,
    thread.latestRun?.completedAt ?? null,
    thread.latestRun?.requestedAt ?? null,
  ];
  let latest = thread.updatedAt;
  let latestMs = Date.parse(latest);
  for (const candidate of candidates) {
    if (candidate === null) continue;
    const ms = Date.parse(candidate);
    if (Number.isFinite(ms) && (!Number.isFinite(latestMs) || ms > latestMs)) {
      latest = candidate;
      latestMs = ms;
    }
  }
  return latest;
}

export interface SessionGroups<T> {
  readonly "needs-you": ReadonlyArray<T>;
  readonly working: ReadonlyArray<T>;
  readonly idle: ReadonlyArray<T>;
  readonly snoozed: ReadonlyArray<T>;
}

/**
 * Splits live threads into the overview bands, each newest activity first.
 * Snoozed threads leave the bands until they wake, like in the sidebar.
 */
export function groupSessions<T extends SessionThread>(
  threads: ReadonlyArray<T>,
  now: string,
): SessionGroups<T> {
  const groups = {
    "needs-you": [] as T[],
    working: [] as T[],
    idle: [] as T[],
    snoozed: [] as T[],
  };
  for (const thread of threads) {
    if (!isLiveSession(thread)) continue;
    if (effectiveSnoozed(thread, { now })) {
      groups.snoozed.push(thread);
      continue;
    }
    groups[resolveSessionBand(thread, now)].push(thread);
  }
  const byActivity = (left: T, right: T) =>
    Date.parse(sessionLastActivityAt(right)) - Date.parse(sessionLastActivityAt(left));
  for (const list of Object.values(groups)) list.sort(byActivity);
  return groups;
}
