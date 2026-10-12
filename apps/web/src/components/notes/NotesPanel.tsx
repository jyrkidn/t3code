import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { NoteScopeInput, NoteSummary, ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { EllipsisIcon, NotebookPenIcon, PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { notesEnvironment, useCanWriteNotes, useEnvironmentSupportsNotes } from "../../state/notes";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { NoteEditor } from "./NoteEditor";
import { useNotesPanelState, useNotesPanelStore, type NotesPanelTab } from "./notesPanelStore";
import { useSendNoteToAgent } from "./useSendNoteToAgent";

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "Something went wrong.",
  });
}

/** The thread's notes and its project's notes, with an editor for the open one. */
export function NotesPanel({
  threadRef,
  projectId,
  cwd,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId;
  readonly cwd: string | undefined;
}) {
  const environmentId = threadRef.environmentId;
  const threadKey = scopedThreadKey(threadRef);
  const supported = useEnvironmentSupportsNotes(environmentId);
  const canWrite = useCanWriteNotes(environmentId);
  const { tab, openNoteId } = useNotesPanelState(threadKey);
  const update = useNotesPanelStore((state) => state.update);

  const scope = useMemo<NoteScopeInput>(
    () =>
      tab === "thread"
        ? { kind: "thread", threadId: threadRef.threadId }
        : { kind: "project", projectId },
    [projectId, tab, threadRef.threadId],
  );
  const listQuery = useEnvironmentQuery(
    supported ? notesEnvironment.listLive({ environmentId, input: { scope } }) : null,
  );
  const notes = listQuery.data?.notes ?? [];

  const createNote = useAtomCommand(notesEnvironment.create, { reportFailure: false });
  const onCreate = async () => {
    const result = await createNote({ environmentId, input: { scope } });
    reportFailure("Failed to create note", result);
    if (result._tag === "Success") update(threadKey, { openNoteId: result.value.note.id });
  };

  if (!supported) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        Update this environment's T3 Code server to keep notes.
      </p>
    );
  }

  if (openNoteId !== null) {
    return (
      <NoteEditor
        key={openNoteId}
        environmentId={environmentId}
        projectId={projectId}
        noteId={openNoteId}
        listedVersion={notes.find((note) => note.id === openNoteId)?.version ?? null}
        cwd={cwd}
        threadRef={threadRef}
        onBack={() => update(threadKey, { openNoteId: null })}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-2 py-1.5">
        <ToggleGroup
          aria-label="Notes scope"
          variant="segmented"
          value={[tab]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "thread" || next === "project") update(threadKey, { tab: next });
          }}
        >
          <Toggle value="thread">This thread</Toggle>
          <Toggle value="project">Project</Toggle>
        </ToggleGroup>
        <div className="flex-1" />
        {canWrite ? (
          <Button size="xs" variant="outline" onClick={() => void onCreate()}>
            <PlusIcon />
            New note
          </Button>
        ) : null}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {listQuery.error !== null ? (
          <p className="p-4 text-sm text-muted-foreground">{listQuery.error}</p>
        ) : notes.length === 0 && listQuery.isSuccess ? (
          <div className="flex flex-col items-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <NotebookPenIcon className="size-5" />
            {tab === "thread" ? "No notes for this thread yet." : "No project notes yet."}
          </div>
        ) : (
          <ul className="flex flex-col p-1">
            {notes.map((note) => (
              <NoteRow
                key={note.id}
                note={note}
                tab={tab}
                threadRef={threadRef}
                canWrite={canWrite}
                onOpen={() => update(threadKey, { openNoteId: note.id })}
              />
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}

function NoteRow({
  note,
  tab,
  threadRef,
  canWrite,
  onOpen,
}: {
  readonly note: NoteSummary;
  readonly tab: NotesPanelTab;
  readonly threadRef: ScopedThreadRef;
  readonly canWrite: boolean;
  readonly onOpen: () => void;
}) {
  const environmentId = threadRef.environmentId;
  const [renaming, setRenaming] = useState(false);
  const renameNote = useAtomCommand(notesEnvironment.rename, { reportFailure: false });
  const moveNote = useAtomCommand(notesEnvironment.move, { reportFailure: false });
  const deleteNote = useAtomCommand(notesEnvironment.delete, { reportFailure: false });
  const sendToAgent = useSendNoteToAgent(threadRef);

  const commitRename = async (title: string) => {
    setRenaming(false);
    const trimmed = title.trim();
    if (trimmed.length === 0 || trimmed === note.title) return;
    reportFailure(
      "Failed to rename note",
      await renameNote({ environmentId, input: { id: note.id, title: trimmed } }),
    );
  };

  return (
    <li className="group flex min-w-0 items-center gap-1 rounded-md hover:bg-accent/60">
      {renaming ? (
        <Input
          aria-label="Note title"
          size="sm"
          autoFocus
          defaultValue={note.title}
          onBlur={(event) => void commitRename(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void commitRename(event.currentTarget.value);
            if (event.key === "Escape") setRenaming(false);
          }}
        />
      ) : (
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={onOpen}
        >
          <span className="min-w-0 flex-1 truncate text-sm">{note.title}</span>
          <span className="shrink-0 text-xs text-muted-foreground/70">
            {formatRelativeTimeLabel(note.updatedAt)}
          </span>
        </button>
      )}
      <span className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 has-data-popup-open:opacity-100">
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Actions for ${note.title}`}
              />
            }
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => sendToAgent(note, "plain")}>Send to agent</MenuItem>
            <MenuItem onClick={() => sendToAgent(note, "jira")}>
              Create a Jira issue from this note
            </MenuItem>
            <MenuItem onClick={() => sendToAgent(note, "confluence")}>
              Turn this note into a Confluence page
            </MenuItem>
            <MenuItem onClick={() => sendToAgent(note, "summarize")}>
              Summarise this thread into this note
            </MenuItem>
            {canWrite ? <MenuSeparator /> : null}
            {canWrite ? (
              <>
                <MenuItem onClick={() => setRenaming(true)}>Rename</MenuItem>
                {tab === "thread" ? (
                  <MenuItem
                    onClick={async () =>
                      reportFailure(
                        "Failed to move note",
                        await moveNote({
                          environmentId,
                          input: { id: note.id, to: { kind: "project" } },
                        }),
                      )
                    }
                  >
                    Move to project
                  </MenuItem>
                ) : (
                  <MenuItem
                    onClick={async () =>
                      reportFailure(
                        "Failed to move note",
                        await moveNote({
                          environmentId,
                          input: {
                            id: note.id,
                            to: { kind: "thread", threadId: threadRef.threadId },
                          },
                        }),
                      )
                    }
                  >
                    Move to this thread
                  </MenuItem>
                )}
                <MenuItem
                  variant="destructive"
                  onClick={async () =>
                    reportFailure(
                      "Failed to delete note",
                      await deleteNote({ environmentId, input: { id: note.id } }),
                    )
                  }
                >
                  Delete
                </MenuItem>
              </>
            ) : null}
          </MenuPopup>
        </Menu>
      </span>
    </li>
  );
}
