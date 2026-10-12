import {
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArchiveIcon, EllipsisIcon, NotebookTextIcon, SquareIcon } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";

import { isElectron } from "../../env";
import { useThreadActionMenu } from "../../hooks/useThreadActionMenu";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useClientSettings } from "../../hooks/useSettings";
import { useEscapeToGoBack } from "../../hooks/useNavigateBack";
import { buildProjectGroups, selectProjectGroupingSettings } from "../../logicalProject";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { notesEnvironment, useEnvironmentSupportsNotes } from "../../state/notes";
import { useEnvironmentQuery } from "../../state/query";
import { readEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import type { SidebarThreadSummary } from "../../types";
import { ThreadRowLeadingStatus, ThreadRowTrailingStatus } from "../ThreadStatusIndicators";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  groupSessions,
  resolveSessionAttention,
  sessionLastActivityAt,
  type SessionAttention,
  type SessionsSearch,
  type SessionsSearchPatch,
  type SessionStatusFilter,
} from "./sessions.logic";

const BANDS = [
  { id: "needs-you", label: "Needs you" },
  { id: "working", label: "Working" },
  { id: "idle", label: "Idle" },
  { id: "snoozed", label: "Snoozed" },
] as const;

const STATUS_OPTIONS: ReadonlyArray<{ value: SessionStatusFilter; label: string }> = [
  { value: "all", label: "All live" },
  { value: "needs-you", label: "Needs you" },
  { value: "working", label: "Working" },
  { value: "idle", label: "Idle" },
  { value: "snoozed", label: "Snoozed" },
];

const ATTENTION_LABEL: Partial<Record<SessionAttention, string>> = {
  "usage-limit": "Usage limit",
  error: "Error",
};

const ALL = "__all__";

/** Re-evaluates time-based state (snooze wakes, limit resets, relative labels) once a minute. */
function useMinuteClock(): string {
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date().toISOString()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

function failureToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

interface ProjectOption {
  readonly key: string;
  readonly label: string;
}

export function SessionsPage({
  search,
  onSearchChange,
}: {
  readonly search: SessionsSearch;
  readonly onSearchChange: (next: SessionsSearchPatch) => void;
}) {
  useEscapeToGoBack();
  const now = useMinuteClock();
  const threads = useThreadShells();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);

  const projectGroupByRef = useMemo(() => {
    const groups = buildProjectGroups({
      projects,
      settings: groupingSettings,
      preferredEnvironmentId: primaryEnvironmentId,
    });
    const map = new Map<string, ProjectOption>();
    for (const group of groups) {
      for (const ref of group.memberProjectRefs) {
        map.set(scopedProjectKey(ref), { key: group.key, label: group.label });
      }
    }
    return map;
  }, [groupingSettings, primaryEnvironmentId, projects]);

  const environmentLabelById = useMemo(
    () =>
      new Map(environments.map((environment) => [environment.environmentId, environment.label])),
    [environments],
  );

  const projectOf = useCallback(
    (thread: SidebarThreadSummary) =>
      projectGroupByRef.get(
        scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
      ) ?? null,
    [projectGroupByRef],
  );

  const filtered = useMemo(
    () =>
      threads.filter(
        (thread) =>
          (search.environmentId === undefined || thread.environmentId === search.environmentId) &&
          (search.project === undefined || projectOf(thread)?.key === search.project),
      ),
    [projectOf, search.environmentId, search.project, threads],
  );
  const groups = useMemo(() => groupSessions(filtered, now), [filtered, now]);

  const projectOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const thread of threads) {
      const project = projectOf(thread);
      if (project) options.set(project.key, project.label);
    }
    return [...options]
      .map(([key, label]) => ({ key, label }))
      .toSorted((left, right) => left.label.localeCompare(right.label));
  }, [projectOf, threads]);

  const status = search.status ?? "all";
  const visibleBands = BANDS.filter((band) =>
    status === "all" ? band.id !== "snoozed" : band.id === status,
  );
  const visibleCount = visibleBands.reduce((sum, band) => sum + groups[band.id].length, 0);

  // One action menu for the whole page: a row asks for it with its ref and the click position.
  const [menuRequest, setMenuRequest] = useState<{
    readonly ref: ScopedThreadRef;
    readonly position: { x: number; y: number };
  } | null>(null);
  const navigate = useNavigate();
  const { openMenu } = useThreadActionMenu({
    threadRef: menuRequest?.ref ?? null,
    projectCwd: null,
    onStartRename: () => {
      if (menuRequest === null) return;
      void navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: menuRequest.ref.environmentId,
          threadId: menuRequest.ref.threadId,
        },
      });
    },
  });
  // openMenu is rebuilt for the new target in the render that follows a request.
  const openRequestedMenu = useEffectEvent((position: { x: number; y: number }) =>
    openMenu(position),
  );
  useEffect(() => {
    if (menuRequest !== null) openRequestedMenu(menuRequest.position);
  }, [menuRequest]);

  const onOpenMenu = useCallback((ref: ScopedThreadRef, position: { x: number; y: number }) => {
    setMenuRequest({ ref, position });
  }, []);

  const { settleThread } = useThreadActions();
  const interruptTurn = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const onSettle = useCallback(
    async (ref: ScopedThreadRef) => {
      const result = await settleThread(ref);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        failureToast("Failed to settle thread", squashAtomCommandFailure(result));
      }
    },
    [settleThread],
  );
  const onStop = useCallback(
    async (ref: ScopedThreadRef) => {
      const result = await interruptTurn({
        environmentId: ref.environmentId,
        input: { threadId: ref.threadId },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        failureToast("Failed to stop thread", squashAtomCommandFailure(result));
      }
    },
    [interruptTurn],
  );

  const filterSelect = (input: {
    label: string;
    value: string;
    options: ReadonlyArray<{ value: string; label: string }>;
    onChange: (value: string) => void;
  }) => (
    <Select value={input.value} onValueChange={(value) => input.onChange(String(value))}>
      <SelectTrigger
        aria-label={input.label}
        size="compact"
        variant="ghost"
        className="w-auto min-w-0"
      >
        <SelectValue>
          {input.options.find((option) => option.value === input.value)?.label}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {input.options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Sessions breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">Sessions</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="min-w-0 flex-1" />
          <div className="flex shrink items-center gap-1">
            {filterSelect({
              label: "Filter by status",
              value: status,
              options: STATUS_OPTIONS,
              onChange: (value) =>
                onSearchChange({
                  ...search,
                  status: value === "all" ? undefined : (value as SessionStatusFilter),
                }),
            })}
            {projectOptions.length > 1
              ? filterSelect({
                  label: "Filter by project",
                  value: search.project ?? ALL,
                  options: [
                    { value: ALL, label: "All projects" },
                    ...projectOptions.map((option) => ({ value: option.key, label: option.label })),
                  ],
                  onChange: (value) =>
                    onSearchChange({ ...search, project: value === ALL ? undefined : value }),
                })
              : null}
            {environments.length > 1
              ? filterSelect({
                  label: "Filter by environment",
                  value: search.environmentId ?? ALL,
                  options: [
                    { value: ALL, label: "All machines" },
                    ...environments.map((environment) => ({
                      value: environment.environmentId,
                      label: environment.label,
                    })),
                  ],
                  onChange: (value) =>
                    onSearchChange({
                      ...search,
                      environmentId: value === ALL ? undefined : (value as EnvironmentId),
                    }),
                })
              : null}
          </div>
        </WorkspacePageHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <WorkspacePageContainer width="expanded" className="gap-6">
            {visibleCount === 0 ? (
              <p className="text-sm text-muted-foreground">No live sessions match these filters.</p>
            ) : (
              visibleBands.map((band) =>
                groups[band.id].length === 0 ? null : (
                  <section key={band.id} aria-label={band.label} className="flex flex-col gap-1">
                    <h2 className="px-2 pb-1 text-xs font-medium text-muted-foreground">
                      {band.label}
                      <span className="ml-1.5 tabular-nums text-muted-foreground/60">
                        {groups[band.id].length}
                      </span>
                    </h2>
                    {groups[band.id].map((thread) => (
                      <SessionRow
                        key={`${thread.environmentId}:${thread.id}`}
                        thread={thread}
                        now={now}
                        working={band.id === "working"}
                        projectLabel={projectOf(thread)?.label ?? null}
                        environmentLabel={
                          environments.length > 1
                            ? (environmentLabelById.get(thread.environmentId) ?? null)
                            : null
                        }
                        onOpenMenu={onOpenMenu}
                        onSettle={onSettle}
                        onStop={onStop}
                      />
                    ))}
                  </section>
                ),
              )
            )}
          </WorkspacePageContainer>
        </div>
      </div>
    </SidebarInset>
  );
}

const SessionRow = memo(function SessionRow({
  thread,
  now,
  working,
  projectLabel,
  environmentLabel,
  onOpenMenu,
  onSettle,
  onStop,
}: {
  readonly thread: SidebarThreadSummary;
  readonly now: string;
  readonly working: boolean;
  readonly projectLabel: string | null;
  readonly environmentLabel: string | null;
  readonly onOpenMenu: (ref: ScopedThreadRef, position: { x: number; y: number }) => void;
  readonly onSettle: (ref: ScopedThreadRef) => Promise<void>;
  readonly onStop: (ref: ScopedThreadRef) => Promise<void>;
}) {
  const ref = useMemo(
    () => scopeThreadRef(thread.environmentId, thread.id),
    [thread.environmentId, thread.id],
  );
  const attention = resolveSessionAttention(thread, now);
  const attentionLabel = attention === null ? null : (ATTENTION_LABEL[attention] ?? null);
  const lastActivity = formatRelativeTimeLabel(sessionLastActivityAt(thread));
  const branch = thread.branch ?? null;
  const meta = [
    projectLabel,
    environmentLabel,
    branch,
    thread.runtime?.providerName ?? thread.providerInstanceId,
    thread.modelSelection.model,
  ].filter((part): part is string => typeof part === "string" && part.length > 0);

  const canOperate = readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);

  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    onOpenMenu(ref, { x: event.clientX, y: event.clientY });
  };

  return (
    <div
      className="group flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-accent/60"
      onContextMenu={onContextMenu}
    >
      <Link
        to="/$environmentId/$threadId"
        params={{ environmentId: thread.environmentId, threadId: thread.id }}
        className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="flex min-w-0 items-center gap-2 text-sm">
          <ThreadRowLeadingStatus thread={thread} />
          <span className="min-w-0 truncate">{thread.title}</span>
          <ThreadNotesIndicator thread={thread} />
          {attentionLabel ? (
            <span className="shrink-0 text-3xs text-destructive">{attentionLabel}</span>
          ) : null}
        </span>
        {meta.length > 0 ? (
          <span className="min-w-0 truncate text-xs text-muted-foreground/70">
            {meta.join(" · ")}
          </span>
        ) : null}
      </Link>
      <ThreadRowTrailingStatus thread={thread} />
      <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground/70">
        {lastActivity}
      </span>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
        {working && canOperate ? (
          <RowAction label="Stop" onClick={() => void onStop(ref)}>
            <SquareIcon />
          </RowAction>
        ) : null}
        {canOperate ? (
          <RowAction label="Settle" onClick={() => void onSettle(ref)}>
            <ArchiveIcon />
          </RowAction>
        ) : null}
        <RowAction
          label="More actions"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            onOpenMenu(ref, { x: rect.left, y: rect.bottom });
          }}
        >
          <EllipsisIcon />
        </RowAction>
      </div>
    </div>
  );
});

function RowAction({
  label,
  onClick,
  children,
}: {
  readonly label: string;
  readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button size="icon-xs" variant="ghost-muted" aria-label={label} onClick={onClick} />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** Marks threads that have notes. Rows on one environment share its single stream. */
function ThreadNotesIndicator({ thread }: { readonly thread: SidebarThreadSummary }) {
  const supported = useEnvironmentSupportsNotes(thread.environmentId);
  const threadsWithNotes = useEnvironmentQuery(
    supported
      ? notesEnvironment.threadsWithNotesLive({ environmentId: thread.environmentId, input: {} })
      : null,
  ).data?.threadIds;
  if (!threadsWithNotes?.includes(thread.id)) return null;
  return (
    <NotebookTextIcon aria-label="Has notes" className="size-3 shrink-0 text-muted-foreground" />
  );
}
