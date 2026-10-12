import {
  type NoteConflictError,
  type NotesError,
  OrchestratorMcpFailure,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as NotesService from "../../../notes/NotesService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { NotesToolkit } from "./tools.ts";

const toFailure = (error: NotesError | NoteConflictError) =>
  error._tag === "NoteConflictError"
    ? new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `The note changed since you read it and is now at version ${error.currentVersion}. Nothing was written: read it again, keep the user's changes, and retry.`,
      })
    : new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });

const notFound = new OrchestratorMcpFailure({
  code: "invalid_request",
  message: "No such note in this thread or its project. List notes for valid ids.",
});

/** The calling thread, once it holds the notes capability. */
const callerThread = Effect.gen(function* () {
  yield* McpInvocationContext.requireMcpCapability("notes").pipe(
    Effect.mapError(
      (error) => new OrchestratorMcpFailure({ code: "capability_denied", message: error.message }),
    ),
  );
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "Notes tools");
  return thread.threadId;
});

const make = Effect.gen(function* () {
  const notes = yield* NotesService.NotesService;

  /** Agents only reach their own thread's notes and their project's. */
  const visibleNote = (threadId: ThreadId, id: string) =>
    notes
      .isVisibleToThread(id, threadId)
      .pipe(Effect.flatMap((visible) => (visible ? Effect.void : Effect.fail(notFound))));

  return {
    t3_notes_list: McpToolAccess.readsAsCaller((input) =>
      Effect.gen(function* () {
        const threadId = yield* callerThread;
        const scopes = yield* notes.scopesForThread(threadId).pipe(Effect.mapError(toFailure));
        const which = input.scope ?? "all";
        const threadNotes =
          which === "project"
            ? []
            : (yield* notes.list(scopes.thread).pipe(Effect.mapError(toFailure))).notes;
        const projectNotes =
          which === "thread"
            ? []
            : (yield* notes.list(scopes.project).pipe(Effect.mapError(toFailure))).notes;
        return { notes: [...threadNotes, ...projectNotes] };
      }),
    ),
    t3_notes_read: McpToolAccess.readsAsCaller((input) =>
      Effect.gen(function* () {
        const threadId = yield* callerThread;
        yield* visibleNote(threadId, input.id);
        return yield* notes.read(input.id).pipe(Effect.mapError(toFailure));
      }),
    ),
    t3_notes_create: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const threadId = yield* callerThread;
        const scopes = yield* notes.scopesForThread(threadId).pipe(Effect.mapError(toFailure));
        return yield* notes
          .create({
            scope: input.scope === "thread" ? scopes.thread : scopes.project,
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.content === undefined ? {} : { content: input.content }),
          })
          .pipe(Effect.mapError(toFailure));
      }),
    ),
    t3_notes_write: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const threadId = yield* callerThread;
        yield* visibleNote(threadId, input.id);
        const note = yield* notes.write(input).pipe(Effect.mapError(toFailure));
        return { note };
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof NotesToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(NotesToolkit, make);
