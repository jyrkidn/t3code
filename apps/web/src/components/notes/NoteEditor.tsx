import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, NoteScope, ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { ArrowLeftIcon } from "lucide-react";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";

import { notesEnvironment, useCanWriteNotes } from "../../state/notes";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

const AUTOSAVE_DELAY_MS = 800;

interface LoadedNote {
  readonly id: string;
  readonly title: string;
  readonly scope: NoteScope;
  /** The content on the server at `version`, the base the draft was edited from. */
  readonly content: string;
  readonly version: string;
}

/** Unsaved is derived from the draft; this tracks only what a save did. */
type SaveState = "idle" | "saving" | "error";

function failureMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}

/**
 * Edits one note with debounced autosave. Every save names the version it was
 * edited from, so an edit made elsewhere in the meantime surfaces as a conflict
 * to resolve here instead of being overwritten.
 */
export function NoteEditor({
  environmentId,
  projectId,
  noteId,
  listedVersion,
  cwd,
  threadRef,
  onBack,
}: {
  readonly environmentId: EnvironmentId;
  /** The thread's project, where a copy of a project note goes. */
  readonly projectId: ProjectId;
  readonly noteId: string;
  /** The version the live note list reports; a change means someone else saved. */
  readonly listedVersion: string | null;
  readonly cwd: string | undefined;
  readonly threadRef: ScopedThreadRef;
  readonly onBack: () => void;
}) {
  const readNote = useAtomCommand(notesEnvironment.read, { reportFailure: false });
  const writeNote = useAtomCommand(notesEnvironment.write, { reportFailure: false });
  const createNote = useAtomCommand(notesEnvironment.create, { reportFailure: false });
  const canWrite = useCanWriteNotes(environmentId);

  const [note, setNote] = useState<LoadedNote | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [conflictVersion, setConflictVersion] = useState<string | null>(null);
  const [mode, setMode] = useState<"raw" | "rendered">("raw");
  const saving = useRef(false);
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    const result = await readNote({ environmentId, input: { id: noteId } });
    if (result._tag !== "Success") {
      setLoadError(failureMessage(squashAtomCommandFailure(result)));
      return;
    }
    const { note: summary, content } = result.value;
    setNote({ ...summary, content });
    setDraft(content);
    setLoadError(null);
    setConflictVersion(null);
    setSaveState("idle");
  }, [environmentId, noteId, readNote]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useEffectEvent(async (expectedVersion?: string) => {
    if (note === null || saving.current || !canWrite) return;
    const content = draft;
    if (content === note.content && expectedVersion === undefined) {
      setSaveState("idle");
      return;
    }
    saving.current = true;
    setSaveState("saving");
    const result = await writeNote({
      environmentId,
      input: { id: note.id, content, expectedVersion: expectedVersion ?? note.version },
    });
    saving.current = false;
    if (result._tag === "Success") {
      setNote((current) =>
        current === null
          ? null
          : { ...current, title: result.value.title, content, version: result.value.version },
      );
      setConflictVersion(null);
      setSaveState("idle");
      return;
    }
    const error = Option.getOrNull(Cause.findErrorOption(result.cause));
    if (error?._tag === "NoteConflictError") {
      setConflictVersion(error.currentVersion);
      setSaveState("idle");
      return;
    }
    setSaveState("error");
    toastManager.add({
      type: "error",
      title: "Failed to save note",
      description: failureMessage(squashAtomCommandFailure(result)),
    });
  });

  // Autosave once typing pauses; a conflict waits for the user to resolve it.
  useEffect(() => {
    if (note === null || draft === note.content || conflictVersion !== null) return;
    timer.current = window.setTimeout(() => void save(), AUTOSAVE_DELAY_MS);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [conflictVersion, draft, note]);

  // Flush a pending edit when the editor closes.
  const flush = useEffectEvent(() => {
    if (note !== null && draft !== note.content && conflictVersion === null) void save();
  });
  useEffect(() => () => flush(), []);

  // Someone else saved: follow them while there is nothing to lose, otherwise conflict.
  const onRemoteVersion = useEffectEvent((version: string) => {
    if (note === null || saving.current || version === note.version) return;
    if (draft === note.content) void load();
    else setConflictVersion(version);
  });
  useEffect(() => {
    if (listedVersion !== null) onRemoteVersion(listedVersion);
  }, [listedVersion, note?.version]);

  const keepMine = () => {
    if (conflictVersion !== null) void save(conflictVersion);
  };
  const saveMineAsCopy = async () => {
    if (note === null) return;
    const result = await createNote({
      environmentId,
      input: {
        scope:
          note.scope.kind === "thread"
            ? { kind: "thread", threadId: note.scope.threadId }
            : { kind: "project", projectId },
        title: `${note.title} (my copy)`,
        content: draft,
      },
    });
    if (result._tag !== "Success") {
      toastManager.add({
        type: "error",
        title: "Failed to save a copy",
        description: failureMessage(squashAtomCommandFailure(result)),
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: `Saved your version as “${result.value.note.title}”`,
    });
    void load();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-2 py-1.5">
        <Button size="icon-xs" variant="ghost" aria-label="Back to notes" onClick={onBack}>
          <ArrowLeftIcon />
        </Button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{note?.title ?? ""}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {!canWrite
            ? "Read only"
            : saveState === "saving"
              ? "Saving…"
              : saveState === "error"
                ? "Not saved"
                : note !== null && draft !== note.content
                  ? "Unsaved"
                  : "Saved"}
        </span>
        <ToggleGroup
          aria-label="Note view"
          className="shrink-0"
          variant="segmented"
          value={[mode]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "raw" || next === "rendered") setMode(next);
          }}
        >
          <Toggle value="raw">Edit</Toggle>
          <Toggle value="rendered">Preview</Toggle>
        </ToggleGroup>
      </div>

      {conflictVersion !== null ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-warning-surface px-3 py-2 text-xs">
          <span className="min-w-0 flex-1">
            This note changed elsewhere since you started editing.
          </span>
          <Button size="xs" variant="outline" onClick={keepMine}>
            Keep mine
          </Button>
          <Button size="xs" variant="outline" onClick={() => void load()}>
            Take theirs
          </Button>
          <Button size="xs" variant="outline" onClick={() => void saveMineAsCopy()}>
            Save mine as copy
          </Button>
        </div>
      ) : null}

      {loadError !== null ? (
        <p className="p-4 text-sm text-muted-foreground">{loadError}</p>
      ) : note === null ? null : mode === "rendered" ? (
        <ScrollArea className="min-h-0 flex-1">
          <ChatMarkdown text={draft} cwd={cwd} threadRef={threadRef} className="px-4 py-3" />
        </ScrollArea>
      ) : (
        <textarea
          aria-label="Note content"
          className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 font-mono text-sm leading-relaxed outline-none"
          value={draft}
          readOnly={!canWrite}
          spellCheck
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (timer.current !== null) window.clearTimeout(timer.current);
            if (conflictVersion === null) void save();
          }}
        />
      )}
    </div>
  );
}
