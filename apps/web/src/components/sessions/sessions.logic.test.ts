import { describe, expect, it } from "vite-plus/test";

import type { SidebarThreadSummary } from "../../types";
import { groupSessions, parseSessionsSearch, resolveSessionAttention } from "./sessions.logic";

const NOW = "2026-10-12T12:00:00.000Z";

type Fixture = Parameters<typeof groupSessions>[0][number] & { readonly id: string };

function thread(id: string, overrides: Partial<Fixture> = {}): Fixture {
  return {
    id,
    archivedAt: null,
    deletedAt: null,
    lineage: { relationshipToParent: null } as unknown as SidebarThreadSummary["lineage"],
    settledOverride: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    interactionMode: "default",
    latestRun: null,
    runtime: null,
    limitRecovery: null,
    snoozedUntil: null,
    snoozedAt: null,
    latestUserMessageAt: null,
    updatedAt: "2026-10-12T10:00:00.000Z",
    ...overrides,
  } as Fixture;
}

function runtime(
  status: NonNullable<SidebarThreadSummary["runtime"]>["status"],
  extra: Partial<NonNullable<SidebarThreadSummary["runtime"]>> = {},
) {
  return {
    status,
    activeRunId: null,
    providerInstanceId: "codex",
    providerName: null,
    lastError: null,
    updatedAt: "2026-10-12T10:00:00.000Z",
    ...extra,
  } as NonNullable<SidebarThreadSummary["runtime"]>;
}

const ids = (list: ReadonlyArray<Fixture>) => list.map((entry) => entry.id);

describe("groupSessions", () => {
  it("bands threads by what they need from the user", () => {
    const groups = groupSessions(
      [
        thread("approval", { hasPendingApprovals: true, runtime: runtime("waiting") }),
        thread("running", { runtime: runtime("running") }),
        thread("errored", { runtime: runtime("failed", { lastError: "boom" }) }),
        thread("limited", {
          runtime: runtime("failed", { usageLimitResetAt: "2026-10-12T13:00:00.000Z" }),
        }),
        thread("done", { runtime: runtime("completed") }),
      ],
      NOW,
    );
    expect(ids(groups["needs-you"]).toSorted()).toEqual(["approval", "errored", "limited"]);
    expect(ids(groups.working)).toEqual(["running"]);
    expect(ids(groups.idle)).toEqual(["done"]);
  });

  it("drops settled, archived, deleted and subagent threads", () => {
    const groups = groupSessions(
      [
        thread("settled", { settledOverride: "settled" }),
        thread("archived", { archivedAt: NOW }),
        thread("deleted", { deletedAt: NOW }),
        thread("subagent", {
          lineage: {
            relationshipToParent: "subagent",
          } as unknown as SidebarThreadSummary["lineage"],
        }),
        thread("live"),
      ],
      NOW,
    );
    expect(ids(groups.idle)).toEqual(["live"]);
    expect(groups["needs-you"]).toHaveLength(0);
    expect(groups.working).toHaveLength(0);
  });

  it("parks snoozed threads until they wake", () => {
    const groups = groupSessions(
      [
        thread("snoozed", { snoozedUntil: "2026-10-13T08:00:00.000Z", snoozedAt: NOW }),
        thread("woke", {
          snoozedUntil: "2026-10-12T08:00:00.000Z",
          snoozedAt: "2026-10-11T08:00:00.000Z",
        }),
      ],
      NOW,
    );
    expect(ids(groups.snoozed)).toEqual(["snoozed"]);
    expect(ids(groups.idle)).toEqual(["woke"]);
  });

  it("orders each band by latest activity", () => {
    const groups = groupSessions(
      [
        thread("older", { updatedAt: "2026-10-12T09:00:00.000Z" }),
        thread("newer", {
          updatedAt: "2026-10-12T08:00:00.000Z",
          latestUserMessageAt: "2026-10-12T11:00:00.000Z",
        }),
      ],
      NOW,
    );
    expect(ids(groups.idle)).toEqual(["newer", "older"]);
  });
});

describe("resolveSessionAttention", () => {
  it("ignores a usage limit that already reset", () => {
    expect(
      resolveSessionAttention(
        thread("x", {
          runtime: runtime("completed", { usageLimitResetAt: "2026-10-12T11:00:00.000Z" }),
        }),
        NOW,
      ),
    ).toBeNull();
  });
});

describe("parseSessionsSearch", () => {
  it("keeps known filters and drops the rest", () => {
    expect(parseSessionsSearch({ status: "working", project: "p", bogus: 1 })).toEqual({
      status: "working",
      project: "p",
    });
    expect(parseSessionsSearch({ status: "nope" })).toEqual({});
    expect(parseSessionsSearch({ status: "all" })).toEqual({});
  });
});
