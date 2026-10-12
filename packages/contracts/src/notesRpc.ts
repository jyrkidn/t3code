import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  NoteConflictError,
  NoteDocument,
  NotesCreateInput,
  NotesDeleteInput,
  NotesDeleteResult,
  NotesError,
  NotesListInput,
  NotesListResult,
  NotesMoveInput,
  NotesReadInput,
  NotesRenameInput,
  NotesWriteInput,
  NoteSummary,
  NotesThreadsWithNotesResult,
} from "./notes.ts";

// Kept apart from rpc.ts so the fork's notes feature only registers there.
export const NOTES_WS_METHODS = {
  notesList: "notes.list",
  notesSubscribe: "notes.subscribe",
  notesRead: "notes.read",
  notesCreate: "notes.create",
  notesWrite: "notes.write",
  notesRename: "notes.rename",
  notesMove: "notes.move",
  notesDelete: "notes.delete",
  notesSubscribeThreadsWithNotes: "notes.subscribeThreadsWithNotes",
} as const;

const NotesRpcError = Schema.Union([NotesError, EnvironmentAuthorizationError]);

const NotesListRpc = Rpc.make(NOTES_WS_METHODS.notesList, {
  payload: NotesListInput,
  success: NotesListResult,
  error: NotesRpcError,
});

/** Streams a scope's note list: one snapshot on subscribe, then a fresh list after every change. */
const NotesSubscribeRpc = Rpc.make(NOTES_WS_METHODS.notesSubscribe, {
  payload: NotesListInput,
  success: NotesListResult,
  error: NotesRpcError,
  stream: true,
});

const NotesReadRpc = Rpc.make(NOTES_WS_METHODS.notesRead, {
  payload: NotesReadInput,
  success: NoteDocument,
  error: NotesRpcError,
});

const NotesCreateRpc = Rpc.make(NOTES_WS_METHODS.notesCreate, {
  payload: NotesCreateInput,
  success: NoteDocument,
  error: NotesRpcError,
});

const NotesWriteRpc = Rpc.make(NOTES_WS_METHODS.notesWrite, {
  payload: NotesWriteInput,
  success: NoteSummary,
  error: Schema.Union([NotesError, NoteConflictError, EnvironmentAuthorizationError]),
});

const NotesRenameRpc = Rpc.make(NOTES_WS_METHODS.notesRename, {
  payload: NotesRenameInput,
  success: NoteSummary,
  error: NotesRpcError,
});

const NotesMoveRpc = Rpc.make(NOTES_WS_METHODS.notesMove, {
  payload: NotesMoveInput,
  success: NoteSummary,
  error: NotesRpcError,
});

const NotesDeleteRpc = Rpc.make(NOTES_WS_METHODS.notesDelete, {
  payload: NotesDeleteInput,
  success: NotesDeleteResult,
  error: NotesRpcError,
});

/** Streams which threads have notes: one snapshot on subscribe, then again after every change. */
const NotesSubscribeThreadsWithNotesRpc = Rpc.make(
  NOTES_WS_METHODS.notesSubscribeThreadsWithNotes,
  {
    payload: Schema.Struct({}),
    success: NotesThreadsWithNotesResult,
    error: NotesRpcError,
    stream: true,
  },
);

export const NOTES_RPCS = [
  NotesListRpc,
  NotesSubscribeRpc,
  NotesReadRpc,
  NotesCreateRpc,
  NotesWriteRpc,
  NotesRenameRpc,
  NotesMoveRpc,
  NotesDeleteRpc,
  NotesSubscribeThreadsWithNotesRpc,
] as const;
