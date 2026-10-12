import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * Atoms for an environment's markdown notes. Lists are live subscriptions per
 * scope; reading is a command so an open editor decides when to reload.
 */
export function createNotesEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  // Saves of one note must land in order, or a stale autosave could follow a newer one.
  const writes = createAtomCommandScheduler();
  const serial = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  return {
    /** Live note list for a scope: snapshot on subscribe, fresh list after every change. */
    listLive: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:notes:list-live",
      tag: WS_METHODS.notesSubscribe,
    }),
    /** Which threads have notes, for indicators across the environment. */
    threadsWithNotesLive: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:notes:threads-with-notes-live",
      tag: WS_METHODS.notesSubscribeThreadsWithNotes,
    }),
    read: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:notes:read",
      tag: WS_METHODS.notesRead,
    }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:notes:create",
      tag: WS_METHODS.notesCreate,
    }),
    write: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:notes:write",
      tag: WS_METHODS.notesWrite,
      scheduler: writes,
      concurrency: serial,
    }),
    rename: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:notes:rename",
      tag: WS_METHODS.notesRename,
      scheduler: writes,
      concurrency: serial,
    }),
    move: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:notes:move",
      tag: WS_METHODS.notesMove,
      scheduler: writes,
      concurrency: serial,
    }),
    delete: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:notes:delete",
      tag: WS_METHODS.notesDelete,
      scheduler: writes,
      concurrency: serial,
    }),
  };
}
