import type { NoteSummary, ScopedThreadRef } from "@t3tools/contracts";
import { useCallback } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { toastManager } from "../ui/toast";

export type NotePromptPreset = "plain" | "jira" | "confluence" | "summarize";

/**
 * The prompt for a preset. Agents read and write notes through the T3 notes
 * MCP tools, so the prompt names the note by id and says how to write back.
 * Jira and Confluence come from the user's own MCP servers; T3 only words the ask.
 */
function notePrompt(note: Pick<NoteSummary, "id" | "title">, preset: NotePromptPreset) {
  const reference = `my T3 note "${note.title}" (read it with t3_notes_read, id \`${note.id}\`)`;
  const writeBack =
    "write it back to the top of the note with t3_notes_write, passing the version you read and keeping everything else in the note";
  switch (preset) {
    case "plain":
      return `Use ${reference} as context.\n\n`;
    case "jira":
      return `Create a Jira issue from ${reference}. Use the note for the summary and description. Once the issue exists, ${writeBack.replace("write it back", "write its key and link back")}.`;
    case "confluence":
      return `Turn ${reference} into a Confluence page. Once the page exists, ${writeBack.replace("write it back", "write its URL back")}.`;
    case "summarize":
      return `Summarise this thread so far into ${reference}. Keep what is already in the note and save the summary with t3_notes_write, passing the version you read.`;
  }
}

/**
 * Puts a note's prompt in the thread's composer for the user to review and
 * send. Nothing is sent automatically, and an existing draft is kept: the
 * prompt goes after it.
 */
export function useSendNoteToAgent(threadRef: ScopedThreadRef) {
  return useCallback(
    (note: NoteSummary, preset: NotePromptPreset) => {
      const store = useComposerDraftStore.getState();
      const existing = store.getComposerDraft(threadRef)?.prompt ?? "";
      const prompt = notePrompt(note, preset);
      store.setPrompt(
        threadRef,
        existing.trim().length === 0 ? prompt : `${existing.trimEnd()}\n\n${prompt}`,
      );
      toastManager.add({
        type: "info",
        title: "Note prompt added to the composer",
        description: "Review it, then send.",
      });
    },
    [threadRef],
  );
}
