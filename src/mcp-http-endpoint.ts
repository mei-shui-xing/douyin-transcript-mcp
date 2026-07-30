import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { log } from "./logger.js";
import { decideSessionCapacity } from "./mcp-session-policy.js";

type SessionEntry = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  createdAt: number;
  lastSeenAt: number;
};

export type StreamableMcpEndpoint = {
  handlePost(req: Request, res: Response): Promise<void>;
  handleGet(req: Request, res: Response): Promise<void>;
  handleDelete(req: Request, res: Response): Promise<void>;
  close(): Promise<void>;
  stats(): { activeSessions: number; pendingInitializations: number };
};

export function createStreamableMcpEndpoint(options: {
  endpointName: string;
  createServer: () => McpServer;
  sessionTtlMs: number;
  sessionIdleEvictionMs: number;
  maxSessions: number;
  transportFactory?: (
    transportOptions: ConstructorParameters<typeof StreamableHTTPServerTransport>[0],
  ) => StreamableHTTPServerTransport;
}): StreamableMcpEndpoint {
  const sessions = new Map<string, SessionEntry>();
  let pendingInitializations = 0;
  let endpointClosed = false;
  const initializingResourceClosers = new Set<(reason: string) => Promise<void>>();

  const closeDetachedSession = async (
    id: string,
    entry: SessionEntry,
    reason: string,
  ): Promise<void> => {
    await entry.transport.close().catch(() => undefined);
    await entry.server.close().catch(() => undefined);
    log("mcp_endpoint_session_closed", {
      endpoint: options.endpointName,
      sessionId: id,
      reason,
    });
  };

  const detachSession = (id: string): SessionEntry | undefined => {
    const entry = sessions.get(id);
    if (!entry) return undefined;
    sessions.delete(id);
    return entry;
  };

  const closeSession = async (id: string, reason: string): Promise<void> => {
    const entry = detachSession(id);
    if (!entry) return;
    await closeDetachedSession(id, entry, reason);
  };

  const reserveInitialization = (now: number): {
    cleanup: Promise<void>;
  } | null => {
    if (endpointClosed) return null;
    const decision = decideSessionCapacity({
      sessions: Array.from(sessions, ([id, entry]) => ({
        id,
        createdAt: entry.createdAt,
        lastSeenAt: entry.lastSeenAt,
      })),
      now,
      ttlMs: options.sessionTtlMs,
      idleEvictionMs: options.sessionIdleEvictionMs,
      maxSessions: options.maxSessions,
      pendingInitializations,
    });
    if (!decision.capacityAvailable) return null;

    const detached: Array<{ id: string; entry: SessionEntry; reason: string }> = [];
    for (const id of decision.expiredIds) {
      const entry = detachSession(id);
      if (entry) detached.push({ id, entry, reason: "expired_before_initialize" });
    }
    if (decision.evictId) {
      const entry = detachSession(decision.evictId);
      if (entry) {
        detached.push({
          id: decision.evictId,
          entry,
          reason: "idle_lru_capacity_replacement",
        });
      }
    }

    // This synchronous increment is the capacity reservation. It happens
    // before cleanup or any other await, so concurrent initialize requests see
    // the reserved slot and cannot collectively exceed maxSessions.
    pendingInitializations += 1;
    return {
      cleanup: Promise.all(detached.map(item =>
        closeDetachedSession(item.id, item.entry, item.reason))).then(() => undefined),
    };
  };

  const handlePost = async (req: Request, res: Response): Promise<void> => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId && sessions.has(sessionId)) {
        const entry = sessions.get(sessionId)!;
        if (Date.now() - entry.lastSeenAt > options.sessionTtlMs) {
          await closeSession(sessionId, "expired_on_post");
        } else {
          entry.lastSeenAt = Date.now();
          await entry.transport.handleRequest(req, res, req.body);
          return;
        }
      }

      if (isInitializeRequest(req.body)) {
        const reservation = reserveInitialization(Date.now());
        if (!reservation) {
          log("mcp_endpoint_session_capacity_rejected", {
            endpoint: options.endpointName,
            activeSessions: sessions.size,
            pendingInitializations,
            maxSessions: options.maxSessions,
          });
          res.setHeader("Retry-After", "5");
          res.status(429).json({
            jsonrpc: "2.0",
            error: { code: -32002, message: "MCP session capacity reached." },
            id: (req.body as { id?: unknown } | undefined)?.id ?? null,
          });
          return;
        }
        let reservationHeld = true;
        const releaseReservation = (): void => {
          if (!reservationHeld) return;
          reservationHeld = false;
          pendingInitializations = Math.max(0, pendingInitializations - 1);
        };
        let server: McpServer | undefined;
        let transport: StreamableHTTPServerTransport | undefined;
        let initializedSessionId: string | undefined;
        let resourcesClosed = false;
        const closeCreatedResources = async (reason: string): Promise<void> => {
          if (resourcesClosed) return;
          resourcesClosed = true;
          if (initializedSessionId) {
            const current = sessions.get(initializedSessionId);
            if (!transport || current?.transport === transport) {
              sessions.delete(initializedSessionId);
            }
          }
          await transport?.close().catch(() => undefined);
          await server?.close().catch(() => undefined);
          log("mcp_endpoint_initialization_resources_closed", {
            endpoint: options.endpointName,
            initialized: Boolean(initializedSessionId),
            reason,
          });
        };
        try {
          await reservation.cleanup;
          if (endpointClosed) throw new Error("MCP_ENDPOINT_CLOSED");
          if (sessionId && !sessions.has(sessionId)) {
            delete req.headers["mcp-session-id"];
          }
          server = options.createServer();
          const transportOptions = {
            sessionIdGenerator: () => randomUUID(),
            enableJsonResponse: false,
            onsessioninitialized: (id: string) => {
              const now = Date.now();
              initializedSessionId = id;
              sessions.set(id, {
                transport: transport!,
                server: server!,
                createdAt: now,
                lastSeenAt: now,
              });
              // Atomically transition the reserved slot into an active session.
              releaseReservation();
              log("mcp_endpoint_session_initialized", {
                endpoint: options.endpointName,
                sessionId: id,
              });
            },
          };
          transport = options.transportFactory
            ? options.transportFactory(transportOptions)
            : new StreamableHTTPServerTransport(transportOptions);
          const activeTransport = transport;
          initializingResourceClosers.add(closeCreatedResources);
          activeTransport.onclose = () => {
            const id = activeTransport.sessionId;
            if (id && sessions.get(id)?.transport === activeTransport) sessions.delete(id);
          };
          await server.connect(activeTransport);
          if (endpointClosed) throw new Error("MCP_ENDPOINT_CLOSED");
          await activeTransport.handleRequest(req, res, req.body);
          const retained = Boolean(
            initializedSessionId
            && sessions.get(initializedSessionId)?.transport === activeTransport,
          );
          if (!retained) await closeCreatedResources("initialize_completed_without_session");
        } catch (error) {
          await closeCreatedResources("initialize_failed");
          throw error;
        } finally {
          initializingResourceClosers.delete(closeCreatedResources);
          releaseReservation();
        }
        return;
      }

      res.status(404).json({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "Resource not found: MCP session expired; initialize a new session.",
        },
        id: null,
      });
    } catch (error) {
      log("mcp_endpoint_http_error", {
        endpoint: options.endpointName,
        errorType: error instanceof Error ? error.name : "unknown",
      });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal MCP server error" },
          id: null,
        });
      }
    }
  };

  const handleGet = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const entry = sessionId ? sessions.get(sessionId) : undefined;
    if (!entry) {
      res.status(404).send("Resource not found: missing or expired MCP session ID");
      return;
    }
    if (Date.now() - entry.lastSeenAt > options.sessionTtlMs) {
      await closeSession(sessionId!, "expired_on_get");
      res.status(404).send("Resource not found: expired MCP session ID");
      return;
    }
    entry.lastSeenAt = Date.now();
    await entry.transport.handleRequest(req, res);
  };

  const handleDelete = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const entry = sessionId ? sessions.get(sessionId) : undefined;
    if (!entry) {
      res.status(404).send("Resource not found: missing or expired MCP session ID");
      return;
    }
    entry.lastSeenAt = Date.now();
    await entry.transport.handleRequest(req, res);
    if (sessions.has(sessionId!)) await closeSession(sessionId!, "client_delete");
    else await entry.server.close().catch(() => undefined);
  };

  const cleanupExpiredSessions = setInterval(() => {
    const cutoff = Date.now() - options.sessionTtlMs;
    for (const [id, entry] of sessions) {
      if (entry.lastSeenAt >= cutoff) continue;
      void closeSession(id, "periodic_expiry");
    }
  }, Math.min(60_000, Math.max(10_000, Math.floor(options.sessionTtlMs / 4))));
  cleanupExpiredSessions.unref();

  return {
    handlePost,
    handleGet,
    handleDelete,
    async close() {
      endpointClosed = true;
      clearInterval(cleanupExpiredSessions);
      await Promise.all([
        ...[...sessions.keys()].map(id => closeSession(id, "endpoint_shutdown")),
        ...[...initializingResourceClosers].map(closeResources =>
          closeResources("endpoint_shutdown_during_initialize")),
      ]);
    },
    stats: () => ({ activeSessions: sessions.size, pendingInitializations }),
  };
}
