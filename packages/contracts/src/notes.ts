import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Markdown notes the server keeps in its data dir, per project and per thread.
 * A note id is the note's path relative to the notes folder; clients treat it
 * as opaque and the server validates it on every call.
 */
export const NoteId = TrimmedNonEmptyString.check(Schema.isMaxLength(1024));
export type NoteId = typeof NoteId.Type;

/** Where a note is listed or created. */
export const NoteScopeInput = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("project"), projectId: ProjectId }),
  Schema.Struct({ kind: Schema.Literal("thread"), threadId: ThreadId }),
]);
export type NoteScopeInput = typeof NoteScopeInput.Type;

/** Where a note lives. Project notes carry no project id: the folder is shared by every checkout of a repository. */
export const NoteScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("project") }),
  Schema.Struct({ kind: Schema.Literal("thread"), threadId: ThreadId }),
]);
export type NoteScope = typeof NoteScope.Type;

/** Changes whenever the note's content changes; writes must name the version they edited. */
export const NoteVersion = TrimmedNonEmptyString;
export type NoteVersion = typeof NoteVersion.Type;

export const NoteTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(200));

export const NoteSummary = Schema.Struct({
  id: NoteId,
  /** The first `# heading`, otherwise the file name. */
  title: Schema.String,
  scope: NoteScope,
  updatedAt: IsoDateTime,
  version: NoteVersion,
});
export type NoteSummary = typeof NoteSummary.Type;

export const NoteDocument = Schema.Struct({
  note: NoteSummary,
  content: Schema.String,
});
export type NoteDocument = typeof NoteDocument.Type;

export const NotesListInput = Schema.Struct({ scope: NoteScopeInput });
export type NotesListInput = typeof NotesListInput.Type;

/** Newest first. */
export const NotesListResult = Schema.Struct({ notes: Schema.Array(NoteSummary) });
export type NotesListResult = typeof NotesListResult.Type;

export const NotesReadInput = Schema.Struct({ id: NoteId });
export type NotesReadInput = typeof NotesReadInput.Type;

export const NotesCreateInput = Schema.Struct({
  scope: NoteScopeInput,
  title: Schema.optionalKey(NoteTitle),
  content: Schema.optionalKey(Schema.String),
});
export type NotesCreateInput = typeof NotesCreateInput.Type;

export const NotesWriteInput = Schema.Struct({
  id: NoteId,
  content: Schema.String,
  expectedVersion: NoteVersion,
});
export type NotesWriteInput = typeof NotesWriteInput.Type;

/** Renames the file and, when the note starts with a `# heading`, that heading too. */
export const NotesRenameInput = Schema.Struct({ id: NoteId, title: NoteTitle });
export type NotesRenameInput = typeof NotesRenameInput.Type;

/** Moves a thread note to its project, or a project note to one of the project's threads. */
export const NotesMoveInput = Schema.Struct({
  id: NoteId,
  to: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("project") }),
    Schema.Struct({ kind: Schema.Literal("thread"), threadId: ThreadId }),
  ]),
});
export type NotesMoveInput = typeof NotesMoveInput.Type;

/** Moves the note to the notes trash folder. */
export const NotesDeleteInput = Schema.Struct({ id: NoteId });
export type NotesDeleteInput = typeof NotesDeleteInput.Type;

export const NotesDeleteResult = Schema.Struct({});
export type NotesDeleteResult = typeof NotesDeleteResult.Type;

/** Threads on this environment that have at least one note. */
export const NotesThreadsWithNotesResult = Schema.Struct({ threadIds: Schema.Array(ThreadId) });
export type NotesThreadsWithNotesResult = typeof NotesThreadsWithNotesResult.Type;

export class NotesError extends Schema.TaggedError<NotesError>()("NotesError", {
  message: Schema.String,
  id: Schema.optional(NoteId),
  cause: Schema.optional(Schema.Defect()),
}) {}

/** The note changed since the caller read it. Nothing was written. */
export class NoteConflictError extends Schema.TaggedError<NoteConflictError>()(
  "NoteConflictError",
  {
    id: NoteId,
    currentVersion: NoteVersion,
  },
) {
  override get message(): string {
    return "The note changed since it was opened.";
  }
}
