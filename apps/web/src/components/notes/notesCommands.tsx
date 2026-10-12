import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { NoteScopeInput, NoteSummary, ScopedProjectRef } from "@t3tools/contracts";
import { NotebookPenIcon, NotebookTextIcon } from "lucide-react";
import { useCallback } from "react";

import { useRightPanelStore } from "../../rightPanelStore";
import { notesEnvironment, useEnvironmentSupportsNotes } from "../../state/notes";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import type { SidebarThreadSummary } from "../../types";
import type { CommandPaletteActionItem, CommandPaletteGroup } from "../CommandPalette.logic";
import { toastManager } from "../ui/toast";
import { openNoteInPanel, type NotesPanelTab } from "./notesPanelStore";

type ActiveThread = Pick<SidebarThreadSummary, "environmentId" | "id" | "projectId"> | null;

function openNotesPanel(thread: NonNullable<ActiveThread>, noteId: string, tab: NotesPanelTab) {
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  openNoteInPanel(scopedThreadKey(threadRef), noteId, tab);
  useRightPanelStore.getState().open(threadRef, "notes");
}

/**
 * New scratch note: in the active thread when there is one, otherwise in the
 * fallback project, and opened in the thread's notes panel when it can be.
 */
export function useCreateScratchNote() {
  const createNote = useAtomCommand(notesEnvironment.create, { reportFailure: false });
  return useCallback(
    async (input: {
      readonly activeThread: ActiveThread;
      readonly fallbackProjectRef: ScopedProjectRef | null;
    }) => {
      const { activeThread, fallbackProjectRef } = input;
      const target: {
        environmentId: SidebarThreadSummary["environmentId"];
        scope: NoteScopeInput;
      } | null =
        activeThread !== null
          ? {
              environmentId: activeThread.environmentId,
              scope: { kind: "thread", threadId: activeThread.id },
            }
          : fallbackProjectRef !== null
            ? {
                environmentId: fallbackProjectRef.environmentId,
                scope: { kind: "project", projectId: fallbackProjectRef.projectId },
              }
            : null;
      if (target === null) {
        toastManager.add({ type: "info", title: "Open a thread or project to create a note." });
        return;
      }
      const result = await createNote({
        environmentId: target.environmentId,
        input: { scope: target.scope },
      });
      if (result._tag !== "Success") {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Failed to create note",
          description: error instanceof Error ? error.message : "Something went wrong.",
        });
        return;
      }
      if (activeThread !== null) {
        openNotesPanel(activeThread, result.value.note.id, "thread");
      } else {
        toastManager.add({
          type: "success",
          title: "Project note created",
          description: "Find it under Notes in any of the project's threads.",
        });
      }
    },
    [createNote],
  );
}

const EMPTY_NOTES: ReadonlyArray<NoteSummary> = [];

/**
 * Palette entries for notes: toggle and create, plus a search-only group of
 * the active thread's and its project's notes by title.
 */
export function useNoteCommandPaletteItems(input: {
  readonly activeThread: ActiveThread;
  readonly fallbackProjectRef: ScopedProjectRef | null;
  readonly iconClassName: string;
}): {
  readonly actionItems: ReadonlyArray<CommandPaletteActionItem>;
  readonly searchGroups: ReadonlyArray<CommandPaletteGroup>;
} {
  const { activeThread, fallbackProjectRef, iconClassName } = input;
  const supported = useEnvironmentSupportsNotes(
    activeThread?.environmentId ?? fallbackProjectRef?.environmentId ?? null,
  );
  const createScratchNote = useCreateScratchNote();
  const threadNotes = useEnvironmentQuery(
    supported && activeThread
      ? notesEnvironment.listLive({
          environmentId: activeThread.environmentId,
          input: { scope: { kind: "thread", threadId: activeThread.id } },
        })
      : null,
  ).data?.notes;
  const projectNotes = useEnvironmentQuery(
    supported && activeThread
      ? notesEnvironment.listLive({
          environmentId: activeThread.environmentId,
          input: { scope: { kind: "project", projectId: activeThread.projectId } },
        })
      : null,
  ).data?.notes;

  if (!supported) return { actionItems: [], searchGroups: [] };

  const actionItems: CommandPaletteActionItem[] = [
    {
      kind: "action",
      value: "action:notes-new",
      searchTerms: ["new note", "scratch", "notes", "markdown", "write"],
      title: "New scratch note",
      icon: <NotebookPenIcon className={iconClassName} />,
      shortcutCommand: "notes.new",
      run: () => createScratchNote({ activeThread, fallbackProjectRef }),
    },
  ];
  if (activeThread !== null) {
    actionItems.push({
      kind: "action",
      value: "action:notes-toggle",
      searchTerms: ["notes", "scratch", "toggle notes", "panel"],
      title: "Toggle notes",
      icon: <NotebookTextIcon className={iconClassName} />,
      shortcutCommand: "notes.toggle",
      run: async () => {
        useRightPanelStore
          .getState()
          .toggle(scopeThreadRef(activeThread.environmentId, activeThread.id), "notes");
      },
    });
  }

  const noteItem = (note: NoteSummary, tab: NotesPanelTab): CommandPaletteActionItem => ({
    kind: "action",
    value: `note:${note.id}`,
    searchTerms: [note.title, "note"],
    title: note.title,
    description: tab === "thread" ? "Thread note" : "Project note",
    icon: <NotebookTextIcon className={iconClassName} />,
    run: async () => {
      if (activeThread !== null) openNotesPanel(activeThread, note.id, tab);
    },
  });
  const items = [
    ...(threadNotes ?? EMPTY_NOTES).map((note) => noteItem(note, "thread")),
    ...(projectNotes ?? EMPTY_NOTES).map((note) => noteItem(note, "project")),
  ];
  return {
    actionItems,
    searchGroups: items.length > 0 ? [{ value: "notes-search", label: "Notes", items }] : [],
  };
}
