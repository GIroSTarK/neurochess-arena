export const requestPolicies = {
  bootstrap: { ip: 120, principal: 120, inFlight: 32 },
  auth: { ip: 3600, principal: 3600, inFlight: 128 },
  discovery: { ip: 120, principal: 20, inFlight: 32 },
  creation: { ip: 240, principal: 30, inFlight: 32 },
  commands: { ip: 6000, principal: 600, inFlight: 64 },
  control: { ip: 4800, principal: 240, inFlight: 64 },
  reads: { ip: 12_000, principal: 1200, inFlight: 128 },
  credentials: { ip: 240, principal: 30, inFlight: 32 },
  analysisRead: { ip: 4800, principal: 600, inFlight: 64 },
  analysisWrite: { ip: 9600, principal: 2400, inFlight: 64 },
  invitation: { ip: 30, principal: 30, inFlight: 32 },
  join: { ip: 120, principal: 30, inFlight: 32 },
  handshake: { ip: 240, principal: 60, inFlight: 0 },
  fallback: { ip: 120, principal: 120, inFlight: 32 },
} as const;

export type RequestPolicy = keyof typeof requestPolicies;
export interface RequestBudget {
  ip: number;
  principal: number;
  inFlight: number;
}

export function requestPolicy(method: string, route: string | undefined): RequestPolicy {
  if (route === "/guest-session") return "bootstrap";
  if (route === "/api/auth/*") return "auth";
  if (route === "/providers/models") return "discovery";
  if (route === "/rooms/realtime") return "handshake";
  if (route === "/rooms/invitations/resolve") return "invitation";
  if (route === "/rooms/join") return "join";
  if (route === "/games/:gameId/analysis") {
    return method === "POST" ? "analysisWrite" : "analysisRead";
  }
  if (method === "GET" || method === "HEAD") {
    return route &&
      ["/games", "/rooms", "/credentials", "/profile", "/sandbox/games"].some((prefix) =>
        route.startsWith(prefix),
      )
      ? "reads"
      : "fallback";
  }
  if (method === "POST") {
    if (["/games", "/rooms", "/rooms/creation-operation", "/sandbox/games"].includes(route ?? "")) {
      return "creation";
    }
    if (route === "/games/:gameId/controller" || route === "/games/:gameId/lifecycle") {
      return "control";
    }
    if (route?.startsWith("/credentials") || route?.startsWith("/profile")) return "credentials";
    if (route?.startsWith("/games/") || route === "/rooms/:gameId/invitation") return "commands";
  }
  return "fallback";
}
