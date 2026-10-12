import { useAtomValue } from "@effect/atom-react";
import { createNotesEnvironmentAtoms } from "@t3tools/client-runtime/state/notes";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useServerConfigs } from "./entities";

export const notesEnvironment = createNotesEnvironmentAtoms(connectionAtomRuntime);

/** Notes UI shows only for environments whose server keeps notes. */
export function useEnvironmentSupportsNotes(environmentId: EnvironmentId | null): boolean {
  const configs = useServerConfigs();
  return (
    environmentId !== null && configs.get(environmentId)?.environment.capabilities.notes === true
  );
}

export function useCanWriteNotes(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(notesEnvironment.write.permissionAtom(environmentId));
}
