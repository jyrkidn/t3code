import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as NoteOwners from "./NoteOwners.ts";
import * as NotesService from "./NotesService.ts";

const projectId = ProjectId.make("project-1");
const otherProjectId = ProjectId.make("project-2");
const threadId = ThreadId.make("thread-1");
const siblingThreadId = ThreadId.make("thread-2");
const foreignThreadId = ThreadId.make("thread-3");

/** Two projects; project-1 has threads 1 and 2, project-2 has thread 3. */
const withNotes = <A, E>(
  body: (input: {
    readonly notes: NotesService.NotesService["Service"];
    readonly notesDir: string;
    readonly repositoryKey: Ref.Ref<string | null>;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-notes-" });
    const repositoryKey = yield* Ref.make<string | null>(null);
    const owners = Layer.succeed(NoteOwners.NoteOwners, {
      project: (id) =>
        id === projectId || id === otherProjectId
          ? Ref.get(repositoryKey).pipe(
              Effect.map((key) =>
                Option.some({ repositoryKey: id === projectId ? key : "other/repo" }),
              ),
            )
          : Effect.succeed(Option.none()),
      thread: (id) =>
        Effect.succeed(
          id === threadId || id === siblingThreadId
            ? Option.some({ projectId })
            : id === foreignThreadId
              ? Option.some({ projectId: otherProjectId })
              : Option.none(),
        ),
    });
    return yield* Effect.gen(function* () {
      const notes = yield* NotesService.NotesService;
      return yield* body({ notes, notesDir: path.join(baseDir, "notes"), repositoryKey });
    }).pipe(
      Effect.provide(
        NotesService.layer.pipe(
          Layer.provide(Layer.mergeAll(owners, ServerConfig.layerTest(baseDir, baseDir))),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("creates, lists and reads project and thread notes separately", () =>
  withNotes(({ notes }) =>
    Effect.gen(function* () {
      const project = yield* notes.create({
        scope: { kind: "project", projectId },
        title: "Release plan",
      });
      const thread = yield* notes.create({ scope: { kind: "thread", threadId } });
      assert.equal(project.note.title, "Release plan");
      assert.equal(project.content, "# Release plan\n\n");
      assert.match(thread.note.id, /threads\/thread-1\/\d{4}-\d{2}-\d{2}-untitled\.md$/);
      assert.deepEqual(thread.note.scope, { kind: "thread", threadId });

      const projectList = yield* notes.list({ kind: "project", projectId });
      assert.deepEqual(
        projectList.notes.map((note) => note.id),
        [project.note.id],
      );
      const threadList = yield* notes.list({ kind: "thread", threadId });
      assert.deepEqual(
        threadList.notes.map((note) => note.id),
        [thread.note.id],
      );
      assert.equal((yield* notes.read(project.note.id)).content, "# Release plan\n\n");
    }),
  ),
);

it.effect("adds a suffix when a name is taken", () =>
  withNotes(({ notes }) =>
    Effect.gen(function* () {
      const scope = { kind: "project", projectId } as const;
      const first = yield* notes.create({ scope, title: "Ideas" });
      const second = yield* notes.create({ scope, title: "Ideas" });
      assert.isTrue(first.note.id.endsWith("/ideas.md"));
      assert.isTrue(second.note.id.endsWith("/ideas-2.md"));
    }),
  ),
);

it.effect("rejects a write against a stale version and keeps the newer content", () =>
  withNotes(({ notes }) =>
    Effect.gen(function* () {
      const created = yield* notes.create({ scope: { kind: "project", projectId } });
      const first = yield* notes.write({
        id: created.note.id,
        content: "mine",
        expectedVersion: created.note.version,
      });
      const conflict = yield* Effect.flip(
        notes.write({
          id: created.note.id,
          content: "theirs",
          expectedVersion: created.note.version,
        }),
      );
      assert.equal(conflict._tag, "NoteConflictError");
      if (conflict._tag === "NoteConflictError") {
        assert.equal(conflict.currentVersion, first.version);
      }
      assert.equal((yield* notes.read(created.note.id)).content, "mine");
    }),
  ),
);

it.effect("refuses ids that leave the notes folder or the known shapes", () =>
  withNotes(({ notes }) =>
    Effect.gen(function* () {
      for (const id of [
        "../secrets.md",
        "key/../../escape.md",
        "/etc/passwd.md",
        ".trash/x/note.md",
        "key/notes.txt",
        "key/threads/thread-1/nested/deep.md",
      ]) {
        const failure = yield* Effect.flip(notes.read(id));
        assert.equal(failure._tag, "NotesError", id);
      }
    }),
  ),
);

it.effect("moves notes between a thread and its project, but not to another project", () =>
  withNotes(({ notes }) =>
    Effect.gen(function* () {
      const created = yield* notes.create({ scope: { kind: "thread", threadId }, title: "Todo" });
      const moved = yield* notes.move({ id: created.note.id, to: { kind: "project" } });
      assert.deepEqual(moved.scope, { kind: "project" });
      assert.lengthOf((yield* notes.list({ kind: "thread", threadId })).notes, 0);

      const toSibling = yield* notes.move({
        id: moved.id,
        to: { kind: "thread", threadId: siblingThreadId },
      });
      assert.deepEqual(toSibling.scope, { kind: "thread", threadId: siblingThreadId });

      const failure = yield* Effect.flip(
        notes.move({ id: toSibling.id, to: { kind: "thread", threadId: foreignThreadId } }),
      );
      assert.equal(failure._tag, "NotesError");
    }),
  ),
);

it.effect("renames the file and the heading", () =>
  withNotes(({ notes }) =>
    Effect.gen(function* () {
      const created = yield* notes.create({
        scope: { kind: "project", projectId },
        title: "Draft",
        content: "# Draft\n\nbody\n",
      });
      const renamed = yield* notes.rename({ id: created.note.id, title: "Final spec" });
      assert.isTrue(renamed.id.endsWith("/final-spec.md"));
      assert.equal((yield* notes.read(renamed.id)).content, "# Final spec\n\nbody\n");
      assert.equal((yield* Effect.flip(notes.read(created.note.id)))._tag, "NotesError");
    }),
  ),
);

it.effect("moves deleted notes to the trash", () =>
  withNotes(({ notes, notesDir }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const created = yield* notes.create({ scope: { kind: "project", projectId } });
      yield* notes.delete(created.note.id);
      assert.lengthOf((yield* notes.list({ kind: "project", projectId })).notes, 0);
      const trashed = yield* fileSystem.readDirectory(`${notesDir}/.trash`, { recursive: true });
      assert.isTrue(trashed.some((entry) => entry.endsWith(".md")));
    }),
  ),
);

it.effect("keeps notes written before the repository was known", () =>
  withNotes(({ notes, repositoryKey }) =>
    Effect.gen(function* () {
      const created = yield* notes.create({ scope: { kind: "project", projectId } });
      assert.isTrue(created.note.id.startsWith("project-project-1/"));
      yield* Ref.set(repositoryKey, "github.com/acme/app");
      const listed = yield* notes.list({ kind: "project", projectId });
      assert.lengthOf(listed.notes, 1);
      assert.isTrue(listed.notes[0]!.id.startsWith("github-com-acme-app/"));
    }),
  ),
);

it.effect("limits a thread to its own notes and its project's notes", () =>
  withNotes(({ notes }) =>
    Effect.gen(function* () {
      const own = yield* notes.create({ scope: { kind: "thread", threadId } });
      const sibling = yield* notes.create({ scope: { kind: "thread", threadId: siblingThreadId } });
      const project = yield* notes.create({ scope: { kind: "project", projectId } });
      const foreign = yield* notes.create({ scope: { kind: "thread", threadId: foreignThreadId } });
      assert.isTrue(yield* notes.isVisibleToThread(own.note.id, threadId));
      assert.isTrue(yield* notes.isVisibleToThread(project.note.id, threadId));
      assert.isFalse(yield* notes.isVisibleToThread(sibling.note.id, threadId));
      assert.isFalse(yield* notes.isVisibleToThread(foreign.note.id, threadId));
    }),
  ),
);

it.effect("streams a fresh list when a note in the scope changes", () =>
  withNotes(({ notes }) =>
    Effect.gen(function* () {
      const subscribed = yield* Deferred.make<void>();
      const fiber = yield* notes.subscribe({ kind: "thread", threadId }).pipe(
        Stream.tap(() => Deferred.succeed(subscribed, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Deferred.await(subscribed);
      const created = yield* notes.create({ scope: { kind: "thread", threadId }, title: "Live" });
      const lists = yield* Fiber.join(fiber);
      assert.deepEqual(
        Array.from(lists, (list) => list.notes.map((note) => note.id)),
        [[], [created.note.id]],
      );
    }),
  ),
);

it.effect("reports which threads have notes", () =>
  withNotes(({ notes }) =>
    Effect.gen(function* () {
      yield* notes.create({ scope: { kind: "project", projectId } });
      const created = yield* notes.create({ scope: { kind: "thread", threadId } });
      const first = yield* notes
        .subscribeThreadsWithNotes()
        .pipe(Stream.take(1), Stream.runCollect);
      assert.deepEqual(Array.from(first)[0]?.threadIds, [threadId]);
      yield* notes.delete(created.note.id);
      const second = yield* notes
        .subscribeThreadsWithNotes()
        .pipe(Stream.take(1), Stream.runCollect);
      assert.deepEqual(Array.from(second)[0]?.threadIds, []);
    }),
  ),
);
