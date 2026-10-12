import { NoteSummary, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const NOTES_SCOPE =
  "Notes are markdown files the user keeps in T3 Code, outside the repository: this thread's notes and its project's notes, which every thread of the project shares.";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
];

const NoteIdParameter = Schema.String.annotate({
  description: "A note id from t3_notes_list or t3_notes_create.",
});

const NoteDocumentResult = Schema.Struct({
  note: NoteSummary,
  content: Schema.String,
});

const ListNotesTool = Tool.make("t3_notes_list", {
  description: `List notes, newest first. ${NOTES_SCOPE} Each note has an id, a title (its first # heading), its scope, and a version to pass to t3_notes_write.`,
  parameters: Schema.Struct({
    scope: Schema.optional(
      Schema.Literals(["thread", "project", "all"]).annotate({
        description: "Which notes to list. Defaults to all: this thread's, then the project's.",
      }),
    ),
  }),
  success: Schema.Struct({ notes: Schema.Array(NoteSummary) }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List notes")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ReadNoteTool = Tool.make("t3_notes_read", {
  description: `Read a note's markdown and its current version. ${NOTES_SCOPE}`,
  parameters: Schema.Struct({ id: NoteIdParameter }),
  success: NoteDocumentResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read note")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const CreateNoteTool = Tool.make("t3_notes_create", {
  description: `Create a note in this thread or in its project. With a title and no content it starts as "# <title>". ${NOTES_SCOPE}`,
  parameters: Schema.Struct({
    scope: Schema.Literals(["thread", "project"]).annotate({
      description:
        "thread for this thread's notes, project for notes every thread of the project sees.",
    }),
    title: Schema.optional(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
        description: "Names the file and, without content, the heading.",
      }),
    ),
    content: Schema.optional(Schema.String.annotate({ description: "The note's markdown." })),
  }),
  success: NoteDocumentResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Create note")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const WriteNoteTool = Tool.make("t3_notes_write", {
  description: `Replace a note's markdown. Pass the version you read: if the user edited the note since, nothing is written and you get a conflict, so read it again, keep their changes, and retry. ${NOTES_SCOPE}`,
  parameters: Schema.Struct({
    id: NoteIdParameter,
    content: Schema.String.annotate({ description: "The note's full new markdown." }),
    expectedVersion: Schema.String.annotate({
      description: "The version from t3_notes_read, t3_notes_list or t3_notes_create.",
    }),
  }),
  success: Schema.Struct({ note: NoteSummary }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Write note")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const NotesToolkit = Toolkit.make(
  ListNotesTool,
  ReadNoteTool,
  CreateNoteTool,
  WriteNoteTool,
);
