/**
 * Pure path rules for the notes folder. A note id is its path relative to the
 * folder, in one of two shapes:
 *
 * - `<project-key>/<slug>.md` for project notes;
 * - `<project-key>/threads/<thread-id>/<slug>.md` for thread notes.
 *
 * Every id that reaches the filesystem passes `parseNoteId`, which only admits
 * these shapes with plain segments, so no id can name a path outside the folder.
 *
 * @module notePaths
 */
import type { ThreadId } from "@t3tools/contracts";

export const TRASH_FOLDER = ".trash";
export const THREADS_FOLDER = "threads";

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeSegment(segment: string): boolean {
  return segment.length <= 200 && SEGMENT.test(segment) && !segment.includes("..");
}

/** Lowercase `[a-z0-9-]` runs, capped so a long title still makes one short path segment. */
export function slugify(text: string, maxLength = 60): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, maxLength)
    .replace(/-+$/, "");
}

/**
 * The folder a project's notes live in. A repository identity keeps notes with
 * the repository across removing and re-adding the project; without one the
 * project id is all there is.
 */
export function projectNotesKey(input: {
  readonly projectId: string;
  readonly repositoryKey: string | null;
}): string {
  const fromRepository = input.repositoryKey === null ? "" : slugify(input.repositoryKey, 120);
  return fromRepository.length > 0 ? fromRepository : fallbackProjectNotesKey(input.projectId);
}

export function fallbackProjectNotesKey(projectId: string): string {
  return `project-${slugify(projectId, 100) || "unknown"}`;
}

export type ParsedNoteId =
  | { readonly kind: "project"; readonly key: string; readonly file: string }
  | {
      readonly kind: "thread";
      readonly key: string;
      readonly threadId: ThreadId;
      readonly file: string;
    };

export function parseNoteId(id: string): ParsedNoteId | null {
  const segments = id.split("/");
  if (!segments.every(isSafeSegment)) return null;
  const file = segments.at(-1)!;
  if (!file.endsWith(".md") || file.length <= 3) return null;
  const key = segments[0]!;
  if (key === TRASH_FOLDER || key === THREADS_FOLDER) return null;
  if (segments.length === 2) return { kind: "project", key, file };
  if (segments.length === 4 && segments[1] === THREADS_FOLDER) {
    return { kind: "thread", key, threadId: segments[2] as ThreadId, file };
  }
  return null;
}

export function formatNoteId(note: ParsedNoteId): string {
  return note.kind === "project"
    ? `${note.key}/${note.file}`
    : `${note.key}/${THREADS_FOLDER}/${note.threadId}/${note.file}`;
}

/** The note's folder, relative to the notes root, as path segments. */
export function noteFolderSegments(
  note: Pick<ParsedNoteId, "key"> & { readonly threadId?: ThreadId | undefined },
): ReadonlyArray<string> {
  return note.threadId === undefined ? [note.key] : [note.key, THREADS_FOLDER, note.threadId];
}

/** The first `# heading`, otherwise the file name without `.md`. */
export function noteTitle(content: string, file: string): string {
  for (const line of content.split("\n")) {
    const match = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) return match[1]!;
  }
  return file.replace(/\.md$/, "");
}

/** Swaps the first `# heading` for `title`; content without one is unchanged. */
export function replaceNoteHeading(content: string, title: string): string {
  const lines = content.split("\n");
  const index = lines.findIndex((line) => /^#\s+/.test(line));
  if (index === -1) return content;
  lines[index] = `# ${title}`;
  return lines.join("\n");
}

/** `<base>.md`, then `<base>-2.md`, `<base>-3.md`, ... */
export function candidateFileName(base: string, attempt: number): string {
  return attempt === 1 ? `${base}.md` : `${base}-${attempt}.md`;
}

/** `YYYY-MM-DD-untitled` for an ISO timestamp. */
export function untitledBase(nowIso: string): string {
  return `${nowIso.slice(0, 10)}-untitled`;
}
