/**
 * NoteOwners - looks up the projects and threads notes belong to, so
 * NotesService can file a note without depending on orchestration directly.
 *
 * @module NoteOwners
 */
import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";

export class NoteOwners extends Context.Service<
  NoteOwners,
  {
    /** The project's repository key when known; None when the project does not exist. */
    readonly project: (
      projectId: ProjectId,
    ) => Effect.Effect<Option.Option<{ readonly repositoryKey: string | null }>>;
    /** The thread's project; None when the thread does not exist. */
    readonly thread: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<{ readonly projectId: ProjectId }>>;
  }
>()("t3/notes/NoteOwners") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  return NoteOwners.of({
    project: (projectId) =>
      projects.getShell(projectId).pipe(
        Effect.map(
          Option.map((shell) => ({
            repositoryKey: shell.repositoryIdentity?.canonicalKey ?? null,
          })),
        ),
        // A lookup failure files nothing; the caller reports the project as missing.
        Effect.orElseSucceed(() => Option.none()),
      ),
    thread: (threadId) =>
      threads.getThreadShell(threadId).pipe(
        Effect.map((shell) =>
          shell === null ? Option.none() : Option.some({ projectId: shell.projectId }),
        ),
        Effect.orElseSucceed(() => Option.none()),
      ),
  });
});

export const layer = Layer.effect(NoteOwners, make);
