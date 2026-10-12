import { create } from "zustand";

export type NotesPanelTab = "thread" | "project";

export interface NotesPanelThreadState {
  readonly tab: NotesPanelTab;
  /** The note open in the editor, or null for the list. */
  readonly openNoteId: string | null;
}

const DEFAULT_STATE: NotesPanelThreadState = { tab: "thread", openNoteId: null };

/**
 * What the notes panel shows per thread. Session state: a reload opens the
 * list again, while switching threads keeps each thread's place.
 */
export const useNotesPanelStore = create<{
  readonly byThreadKey: Readonly<Record<string, NotesPanelThreadState>>;
  readonly update: (threadKey: string, patch: Partial<NotesPanelThreadState>) => void;
}>((set) => ({
  byThreadKey: {},
  update: (threadKey, patch) =>
    set((state) => ({
      byThreadKey: {
        ...state.byThreadKey,
        [threadKey]: { ...(state.byThreadKey[threadKey] ?? DEFAULT_STATE), ...patch },
      },
    })),
}));

export function useNotesPanelState(threadKey: string): NotesPanelThreadState {
  return useNotesPanelStore((state) => state.byThreadKey[threadKey] ?? DEFAULT_STATE);
}

/** Opens `noteId` in the thread's notes panel editor. */
export function openNoteInPanel(threadKey: string, noteId: string, tab: NotesPanelTab): void {
  useNotesPanelStore.getState().update(threadKey, { openNoteId: noteId, tab });
}
