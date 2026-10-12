import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { SessionsPage } from "../components/sessions/SessionsPage";
import {
  parseSessionsSearch,
  type SessionsSearchPatch,
} from "../components/sessions/sessions.logic";

export const Route = createFileRoute("/_chat/sessions")({
  validateSearch: parseSessionsSearch,
  component: SessionsRouteView,
});

function SessionsRouteView() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <SessionsPage
      search={search}
      onSearchChange={(next: SessionsSearchPatch) =>
        void navigate({ search: parseSessionsSearch(next), replace: true })
      }
    />
  );
}
