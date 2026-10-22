// Real repositories/services/routes; tmux and runtime effects are inert recorders.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcriptRoutes } from "../src/routes/transcripts.js";
import { discoverResumeToken } from "../src/domain/agent-images/resume-token-discovery.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SelfAttachService } from "../src/domain/self-attach-service.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { WhoamiService } from "../src/domain/whoami-service.js";
import { TranscriptStore } from "../src/domain/transcript-store.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { rigsRoutes } from "../src/routes/rigs.js";
import { transportRoutes } from "../src/routes/transport.js";

describe("attached team address preserves physical custody", () => {
  let db: ReturnType<typeof createDb>, rigs: RigRepository, pods: PodRepository, sessions: SessionRegistry, bus: EventBus;
  let attach: SelfAttachService, transport: SessionTransport, tmux: TmuxAdapter, app: Hono;
  let transcriptRoot: string;
  let writes: Array<{ target: string; text: string }>;
  beforeEach(() => {
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    rigs = new RigRepository(db); pods = new PodRepository(db); sessions = new SessionRegistry(db); bus = new EventBus(db);
    transcriptRoot = mkdtempSync(join(tmpdir(), "attach-history-"));
    writes = [];
    tmux = { hasSession: async () => true, probeSession: async () => ({ state: "present" }),
      capturePaneContent: async () => "plain terminal", getPaneCommand: async () => "sh",
      sendText: async (target: string, text: string) => { writes.push({ target, text }); return { ok: true }; },
      sendKeys: async () => ({ ok: true }), createSession: vi.fn(async () => ({ ok: false, code: "session_exists", message: "inert" })),
    } as unknown as TmuxAdapter;
    attach = new SelfAttachService({ db, rigRepo: rigs, podRepo: pods, sessionRegistry: sessions, eventBus: bus, tmuxAdapter: tmux });
    transport = new SessionTransport({ db, rigRepo: rigs, sessionRegistry: sessions, tmuxAdapter: tmux, sleep: async () => {} });
    app = new Hono(); app.use("*", async (c, next) => { c.set("selfAttachService" as never, attach); c.set("sessionTransport" as never, transport); await next(); });
    app.route("/api/rigs", rigsRoutes); app.route("/api/transport", transportRoutes());
  });
  afterEach(() => { db.close(); rmSync(transcriptRoot, { recursive: true, force: true }); });
  const context = (tmuxSession: string) => ({ attachmentType: "tmux" as const, tmuxSession, tmuxWindow: "@12", tmuxPane: "%42" });

  it("validates and persists a relay through the actual attach route", async () => {
    const rig = rigs.createRig("relay-api");
    pods.createPod(rig.id, "agents", "Agents");
    const body = { podNamespace: "agents", memberName: "remote", runtime: "codex", ...context("relay-local"),
      relay: { kind: "ssh-tmux", host: "worker", session: "wm-remote" } };
    for (const relay of [{ ...body.relay, host: "-oProxyCommand=x" }, { ...body.relay, session: "a;cmd" }]) {
      const response = await app.request(`/api/rigs/${rig.id}/attach-self`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, relay }) });
      expect(response.status).toBe(400);
    }
    const response = await app.request(`/api/rigs/${rig.id}/attach-self`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(response.status).toBe(201);
    const result = await response.json() as { nodeId: string };
    expect(sessions.getBindingForNode(result.nodeId)?.relay).toEqual(body.relay);
    tmux.getSshRelay = () => body.relay as { kind: "ssh-tmux"; host: string; session: string };
    tmux.getPaneCommand = async () => "ssh";
    tmux.getPanePid = async () => 999999999;
    const delivery = await transport.send("relay-local", "must not reach an unverified remote shell");
    expect(delivery).toMatchObject({ ok: false, sent: false, reason: "target_runtime_unverified" });
    expect(writes).toEqual([]);
  });

});
