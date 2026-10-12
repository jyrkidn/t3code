/**
 * NotesService - markdown notes kept per project and per thread in
 * `<baseDir>/notes`. Plain `.md` files, no database: the file is the note.
 * Every transport (WebSocket, MCP) goes through here, so path safety, version
 * checks, and live updates are the same for the UI and for agents.
 *
 * @module NotesService
 */
// @effect-diagnostics nodeBuiltinImport:off -- note versions hash content synchronously, like attachmentStore.
import * as NodeCrypto from "node:crypto";

import {
  NoteConflictError,
  NotesError,
  type NoteDocument,
  type NoteScope,
  type NoteScopeInput,
  type NoteSummary,
  type NotesCreateInput,
  type NotesListResult,
  type NotesMoveInput,
  type NotesThreadsWithNotesResult,
  type NotesRenameInput,
  type NotesWriteInput,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as NoteOwners from "./NoteOwners.ts";
import {
  THREADS_FOLDER,
  TRASH_FOLDER,
  candidateFileName,
  fallbackProjectNotesKey,
  formatNoteId,
  isSafeSegment,
  noteFolderSegments,
  noteTitle,
  parseNoteId,
  projectNotesKey,
  replaceNoteHeading,
  slugify,
  untitledBase,
  type ParsedNoteId,
} from "./notePaths.ts";

const MAX_NAME_ATTEMPTS = 100;

/** Where a scope's notes live: the project folder, and the thread folder for thread notes. */
interface ResolvedScope {
  readonly key: string;
  readonly threadId?: ThreadId;
}

export class NotesService extends Context.Service<
  NotesService,
  {
    /** Newest first. */
    readonly list: (scope: NoteScopeInput) => Effect.Effect<NotesListResult, NotesError>;
    /** The scope's list now, then again after every change to that project's notes. */
    readonly subscribe: (scope: NoteScopeInput) => Stream.Stream<NotesListResult, NotesError>;
    readonly read: (id: string) => Effect.Effect<NoteDocument, NotesError>;
    readonly create: (input: NotesCreateInput) => Effect.Effect<NoteDocument, NotesError>;
    /** Writes only when the note is still at `expectedVersion`; never overwrites a newer edit. */
    readonly write: (
      input: NotesWriteInput,
    ) => Effect.Effect<NoteSummary, NotesError | NoteConflictError>;
    readonly rename: (input: NotesRenameInput) => Effect.Effect<NoteSummary, NotesError>;
    readonly move: (input: NotesMoveInput) => Effect.Effect<NoteSummary, NotesError>;
    /** Moves the note into the trash folder. */
    readonly delete: (id: string) => Effect.Effect<void, NotesError>;
    /** Threads with at least one note now, then again after every change. */
    readonly subscribeThreadsWithNotes: () => Stream.Stream<
      NotesThreadsWithNotesResult,
      NotesError
    >;
    /** The scopes an agent in `threadId` may use: its own notes and its project's. */
    readonly scopesForThread: (
      threadId: ThreadId,
    ) => Effect.Effect<
      { readonly thread: NoteScopeInput; readonly project: NoteScopeInput },
      NotesError
    >;
    /** Whether the note belongs to the thread or to the thread's project. */
    readonly isVisibleToThread: (id: string, threadId: ThreadId) => Effect.Effect<boolean>;
  }
>()("t3/notes/NotesService") {}

const noteVersion = (content: string) =>
  NodeCrypto.createHash("sha256").update(content).digest("hex").slice(0, 16);

const notFound = (id: string) => new NotesError({ message: "Note not found.", id });
const invalidId = (id: string) => new NotesError({ message: "Invalid note id.", id });

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const owners = yield* NoteOwners.NoteOwners;
  const root = path.resolve(config.baseDir, "notes");
  // One writer at a time: version checks and renames read then write.
  const mutations = yield* Semaphore.make(1);
  // Project folder keys that changed.
  const changes = yield* PubSub.unbounded<string>();

  const failure =
    (message: string, id?: string) =>
    (cause: PlatformError.PlatformError): NotesError =>
      cause.reason._tag === "NotFound" && id !== undefined
        ? notFound(id)
        : new NotesError({ message, ...(id === undefined ? {} : { id }), cause });

  const absolute = (segments: ReadonlyArray<string>): Effect.Effect<string, NotesError> => {
    const resolved = path.resolve(root, ...segments);
    // parseNoteId and isSafeSegment already rule out escapes; this is the backstop.
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return Effect.fail(new NotesError({ message: "Note path escapes the notes folder." }));
    }
    return Effect.succeed(resolved);
  };

  const parse = (id: string) => {
    const parsed = parseNoteId(id);
    return parsed === null ? Effect.fail(invalidId(id)) : Effect.succeed(parsed);
  };

  const projectKey = Effect.fnUntraced(function* (projectId: ProjectId) {
    const project = yield* owners.project(projectId);
    if (Option.isNone(project)) {
      return yield* new NotesError({ message: "Project not found." });
    }
    const key = projectNotesKey({ projectId, repositoryKey: project.value.repositoryKey });
    // Notes written before the repository identity resolved live under the
    // project id; adopt them once the repository key is known.
    const fallback = fallbackProjectNotesKey(projectId);
    if (key !== fallback) {
      const target = yield* absolute([key]);
      const legacy = yield* absolute([fallback]);
      const adopt =
        (yield* fileSystem.exists(legacy).pipe(Effect.orElseSucceed(() => false))) &&
        !(yield* fileSystem.exists(target).pipe(Effect.orElseSucceed(() => true)));
      if (adopt) {
        yield* fileSystem.rename(legacy, target).pipe(Effect.ignore);
      }
    }
    return key;
  });

  const resolveScope = Effect.fnUntraced(function* (scope: NoteScopeInput) {
    if (scope.kind === "project") {
      return { key: yield* projectKey(scope.projectId) } satisfies ResolvedScope;
    }
    if (!isSafeSegment(scope.threadId)) {
      return yield* new NotesError({ message: "Invalid thread id." });
    }
    const thread = yield* owners.thread(scope.threadId);
    if (Option.isNone(thread)) {
      return yield* new NotesError({ message: "Thread not found." });
    }
    return {
      key: yield* projectKey(thread.value.projectId),
      threadId: scope.threadId,
    } satisfies ResolvedScope;
  });

  const scopeOf = (parsed: ParsedNoteId): NoteScope =>
    parsed.kind === "project" ? { kind: "project" } : { kind: "thread", threadId: parsed.threadId };

  const summarize = Effect.fnUntraced(function* (parsed: ParsedNoteId, content: string) {
    const file = yield* absolute(noteFolderSegments(parsed).concat(parsed.file));
    const info = yield* fileSystem
      .stat(file)
      .pipe(Effect.mapError(failure("Failed to read the note.", formatNoteId(parsed))));
    const updatedAt = Option.match(info.mtime, {
      onNone: () => DateTime.formatIso(DateTime.makeUnsafe(0)),
      onSome: (mtime) => DateTime.formatIso(DateTime.makeUnsafe(mtime)),
    });
    return {
      id: formatNoteId(parsed),
      title: noteTitle(content, parsed.file),
      scope: scopeOf(parsed),
      updatedAt,
      version: noteVersion(content),
    } satisfies NoteSummary;
  });

  const readParsed = Effect.fnUntraced(function* (parsed: ParsedNoteId) {
    const id = formatNoteId(parsed);
    const file = yield* absolute(noteFolderSegments(parsed).concat(parsed.file));
    const content = yield* fileSystem
      .readFileString(file)
      .pipe(Effect.mapError(failure("Failed to read the note.", id)));
    return { note: yield* summarize(parsed, content), content } satisfies NoteDocument;
  });

  const listResolved = Effect.fnUntraced(function* (scope: ResolvedScope) {
    const folder = yield* absolute(noteFolderSegments(scope));
    const entries = yield* fileSystem
      .readDirectory(folder)
      .pipe(
        Effect.catch((cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed<ReadonlyArray<string>>([])
            : Effect.fail(new NotesError({ message: "Failed to list notes.", cause })),
        ),
      );
    const notes: Array<NoteSummary> = [];
    for (const entry of entries) {
      if (!entry.endsWith(".md") || !isSafeSegment(entry)) continue;
      const parsed: ParsedNoteId =
        scope.threadId === undefined
          ? { kind: "project", key: scope.key, file: entry }
          : { kind: "thread", key: scope.key, threadId: scope.threadId, file: entry };
      // A file removed between the listing and the read is simply gone.
      const document = yield* readParsed(parsed).pipe(Effect.option);
      if (Option.isSome(document)) notes.push(document.value.note);
    }
    notes.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return { notes } satisfies NotesListResult;
  });

  const list: NotesService["Service"]["list"] = (scope) =>
    resolveScope(scope).pipe(Effect.flatMap(listResolved));

  const subscribe: NotesService["Service"]["subscribe"] = (scope) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const resolved = yield* resolveScope(scope);
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(listResolved(resolved)),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((key) => key === resolved.key),
            Stream.mapEffect(() => listResolved(resolved)),
          ),
        );
      }),
    );

  const read: NotesService["Service"]["read"] = (id) => parse(id).pipe(Effect.flatMap(readParsed));

  /**
   * Claims the first free `<base>.md`, `<base>-2.md`, ... in `folder` by
   * creating it exclusively, so two creates never share a file.
   */
  const claimFile = Effect.fnUntraced(function* (
    folderSegments: ReadonlyArray<string>,
    base: string,
    content: string,
  ) {
    const folder = yield* absolute(folderSegments);
    yield* fileSystem
      .makeDirectory(folder, { recursive: true })
      .pipe(
        Effect.mapError(
          (cause) => new NotesError({ message: "Failed to create the notes folder.", cause }),
        ),
      );
    for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
      const name = candidateFileName(base, attempt);
      const claimed = yield* fileSystem
        .writeFileString(path.join(folder, name), content, { flag: "wx" })
        .pipe(
          Effect.as(true),
          Effect.catch((cause) =>
            cause.reason._tag === "AlreadyExists"
              ? Effect.succeed(false)
              : Effect.fail(new NotesError({ message: "Failed to create the note.", cause })),
          ),
        );
      if (claimed) return name;
    }
    return yield* new NotesError({ message: "No free file name for the note." });
  });

  const publish = (key: string) => PubSub.publish(changes, key).pipe(Effect.asVoid);

  const create: NotesService["Service"]["create"] = (input) =>
    Effect.gen(function* () {
      const scope = yield* resolveScope(input.scope);
      const now = DateTime.formatIso(yield* DateTime.now);
      const base = (input.title === undefined ? "" : slugify(input.title)) || untitledBase(now);
      const content = input.content ?? (input.title === undefined ? "" : `# ${input.title}\n\n`);
      const file = yield* claimFile(noteFolderSegments(scope), base, content);
      const parsed: ParsedNoteId =
        scope.threadId === undefined
          ? { kind: "project", key: scope.key, file }
          : { kind: "thread", key: scope.key, threadId: scope.threadId, file };
      yield* publish(scope.key);
      return { note: yield* summarize(parsed, content), content } satisfies NoteDocument;
    }).pipe(mutations.withPermits(1));

  const write: NotesService["Service"]["write"] = (input) =>
    Effect.gen(function* () {
      const parsed = yield* parse(input.id);
      const current = yield* readParsed(parsed);
      if (current.note.version !== input.expectedVersion) {
        return yield* new NoteConflictError({
          id: input.id,
          currentVersion: current.note.version,
        });
      }
      const file = yield* absolute(noteFolderSegments(parsed).concat(parsed.file));
      // Write beside the note, then rename over it, so a crash never leaves half a note.
      const temporary = `${file}.${noteVersion(input.content)}.tmp`;
      yield* fileSystem
        .writeFileString(temporary, input.content)
        .pipe(
          Effect.andThen(fileSystem.rename(temporary, file)),
          Effect.mapError(failure("Failed to save the note.", input.id)),
        );
      yield* publish(parsed.key);
      return yield* summarize(parsed, input.content);
    }).pipe(mutations.withPermits(1));

  /** Moves a note file to `target` folder under a free name built from `base`. */
  const relocate = Effect.fnUntraced(function* (
    parsed: ParsedNoteId,
    target: { readonly key: string; readonly threadId?: ThreadId },
    base: string,
    content: string,
  ) {
    const source = yield* absolute(noteFolderSegments(parsed).concat(parsed.file));
    // Claiming writes the new content; the old file goes once the claim succeeded.
    const file = yield* claimFile(noteFolderSegments(target), base, content);
    yield* fileSystem
      .remove(source)
      .pipe(Effect.mapError(failure("Failed to move the note.", formatNoteId(parsed))));
    const next: ParsedNoteId =
      target.threadId === undefined
        ? { kind: "project", key: target.key, file }
        : { kind: "thread", key: target.key, threadId: target.threadId, file };
    yield* publish(parsed.key);
    if (target.key !== parsed.key) yield* publish(target.key);
    return yield* summarize(next, content);
  });

  const rename: NotesService["Service"]["rename"] = (input) =>
    Effect.gen(function* () {
      const parsed = yield* parse(input.id);
      const current = yield* readParsed(parsed);
      const base = slugify(input.title) || parsed.file.replace(/\.md$/, "");
      const content = replaceNoteHeading(current.content, input.title);
      if (`${base}.md` === parsed.file) {
        const file = yield* absolute(noteFolderSegments(parsed).concat(parsed.file));
        yield* fileSystem
          .writeFileString(file, content)
          .pipe(Effect.mapError(failure("Failed to rename the note.", input.id)));
        yield* publish(parsed.key);
        return yield* summarize(parsed, content);
      }
      return yield* relocate(
        parsed,
        { key: parsed.key, ...(parsed.kind === "thread" ? { threadId: parsed.threadId } : {}) },
        base,
        content,
      );
    }).pipe(mutations.withPermits(1));

  const move: NotesService["Service"]["move"] = (input) =>
    Effect.gen(function* () {
      const parsed = yield* parse(input.id);
      const current = yield* readParsed(parsed);
      const base = parsed.file.replace(/\.md$/, "");
      if (input.to.kind === "project") {
        if (parsed.kind === "project") return current.note;
        return yield* relocate(parsed, { key: parsed.key }, base, current.content);
      }
      // A note only moves between a project and that project's own threads.
      const target = yield* resolveScope({ kind: "thread", threadId: input.to.threadId });
      if (target.key !== parsed.key) {
        return yield* new NotesError({
          message: "The thread belongs to a different project.",
          id: input.id,
        });
      }
      if (parsed.kind === "thread" && parsed.threadId === input.to.threadId) return current.note;
      return yield* relocate(parsed, target, base, current.content);
    }).pipe(mutations.withPermits(1));

  const remove: NotesService["Service"]["delete"] = (id) =>
    Effect.gen(function* () {
      const parsed = yield* parse(id);
      const source = yield* absolute(noteFolderSegments(parsed).concat(parsed.file));
      const stamp = DateTime.formatIso(yield* DateTime.now).replace(/[:.]/g, "-");
      const trashFolder = yield* absolute([TRASH_FOLDER, stamp, ...noteFolderSegments(parsed)]);
      yield* fileSystem
        .makeDirectory(trashFolder, { recursive: true })
        .pipe(
          Effect.andThen(fileSystem.rename(source, path.join(trashFolder, parsed.file))),
          Effect.mapError(failure("Failed to delete the note.", id)),
        );
      yield* publish(parsed.key);
    }).pipe(mutations.withPermits(1));

  const listDirectory = (segments: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<string>> =>
    absolute(segments).pipe(
      Effect.flatMap((folder) => fileSystem.readDirectory(folder)),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    );

  /** Every `<key>/threads/<thread-id>/` folder holding a note. */
  const threadsWithNotes = Effect.gen(function* () {
    const threadIds = new Set<ThreadId>();
    for (const key of yield* listDirectory([])) {
      if (!isSafeSegment(key) || key === TRASH_FOLDER) continue;
      for (const threadId of yield* listDirectory([key, THREADS_FOLDER])) {
        if (!isSafeSegment(threadId)) continue;
        const files = yield* listDirectory([key, THREADS_FOLDER, threadId]);
        if (files.some((file) => file.endsWith(".md"))) threadIds.add(threadId as ThreadId);
      }
    }
    return { threadIds: [...threadIds] } satisfies NotesThreadsWithNotesResult;
  });

  const subscribeThreadsWithNotes: NotesService["Service"]["subscribeThreadsWithNotes"] = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(threadsWithNotes),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => threadsWithNotes)),
        );
      }),
    );

  const scopesForThread: NotesService["Service"]["scopesForThread"] = (threadId) =>
    owners.thread(threadId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new NotesError({ message: "Thread not found." })),
          onSome: ({ projectId }) =>
            Effect.succeed({
              thread: { kind: "thread", threadId } as const,
              project: { kind: "project", projectId } as const,
            }),
        }),
      ),
    );

  const isVisibleToThread: NotesService["Service"]["isVisibleToThread"] = (id, threadId) =>
    Effect.gen(function* () {
      const parsed = parseNoteId(id);
      if (parsed === null) return false;
      if (parsed.kind === "thread" && parsed.threadId !== threadId) return false;
      const scope = yield* resolveScope({ kind: "thread", threadId });
      return scope.key === parsed.key;
    }).pipe(Effect.orElseSucceed(() => false));

  return NotesService.of({
    list,
    subscribe,
    read,
    create,
    write,
    rename,
    move,
    delete: remove,
    subscribeThreadsWithNotes,
    scopesForThread,
    isVisibleToThread,
  });
});

export const layer = Layer.effect(NotesService, make);
