import { describe, expect, test, vi, afterEach, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

vi.mock("../../src/browser/reattach.js", () => ({ resumeBrowserSession: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("browser reattach end-to-end (simulated)", () => {
  test("marks session completed after reconnection", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-reattach-"));
    const { setOracleHomeDirOverrideForTest } = await import("../../src/oracleHome.js");
    setOracleHomeDirOverrideForTest(tmpHome);

    try {
      const { resumeBrowserSession } = await import("../../src/browser/reattach.js");
      const resumeMock = vi.mocked(resumeBrowserSession);
      resumeMock.mockResolvedValue({
        answerText: "ok text",
        answerMarkdown: "ok markdown",
        assistantTurn: {
          messageId: "message-final",
          turnId: "conversation-turn-final",
          turnIndex: 3,
          modelSlug: "gpt-5-6-pro",
          responseSha256: createHash("sha256").update("ok markdown").digest("hex"),
          capturedAt: "2026-07-21T20:00:00.000Z",
        },
      });

      const { sessionStore } = await import("../../src/sessionStore.js");
      const { attachSession } = await import("../../src/cli/sessionDisplay.js");

      await sessionStore.ensureStorage();
      const sessionMeta = await sessionStore.createSession(
        {
          prompt: "Test prompt",
          model: "gpt-5.2-pro",
          mode: "browser",
          browserConfig: {},
        },
        "/repo",
      );
      await sessionStore.updateModelRun(sessionMeta.id, "gpt-5.2-pro", {
        status: "running",
        startedAt: new Date().toISOString(),
      });
      await sessionStore.updateSession(sessionMeta.id, {
        status: "running",
        startedAt: new Date().toISOString(),
        mode: "browser",
        browser: {
          config: {},
          runtime: {
            chromePort: 51559,
            chromeHost: "127.0.0.1",
            chromeTargetId: "t-1",
            tabUrl: "https://chatgpt.com/c/demo",
          },
        },
        response: { status: "running", incompleteReason: "chrome-disconnected" },
      });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await attachSession(sessionMeta.id, { suppressMetadata: true, renderPrompt: false });

      logSpy.mockRestore();

      const updated = await sessionStore.readSession(sessionMeta.id);
      expect(updated?.status).toBe("completed");
      expect(updated?.response?.status).toBe("completed");
      expect(updated?.browser?.runtime?.assistantTurn).toMatchObject({
        messageId: "message-final",
        turnIndex: 3,
        modelSlug: "gpt-5-6-pro",
        responseSha256: createHash("sha256").update("ok markdown").digest("hex"),
      });
      expect(resumeMock).toHaveBeenCalledTimes(1);
      const runs = updated?.models ?? [];
      expect(runs.some((r) => r.status === "completed")).toBe(true);
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      setOracleHomeDirOverrideForTest(null);
    }
  }, 20_000);

  test("refuses to mark a normal reattach completed without exact turn evidence", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-reattach-"));
    const { setOracleHomeDirOverrideForTest } = await import("../../src/oracleHome.js");
    setOracleHomeDirOverrideForTest(tmpHome);

    try {
      const { resumeBrowserSession } = await import("../../src/browser/reattach.js");
      vi.mocked(resumeBrowserSession).mockResolvedValue({
        answerText: "captured text",
        answerMarkdown: "captured markdown",
      });
      const { sessionStore } = await import("../../src/sessionStore.js");
      const { attachSession } = await import("../../src/cli/sessionDisplay.js");

      await sessionStore.ensureStorage();
      const sessionMeta = await sessionStore.createSession(
        {
          prompt: "Test prompt",
          model: "gpt-5-pro",
          mode: "browser",
          browserConfig: {},
        },
        "/repo",
      );
      await sessionStore.updateModelRun(sessionMeta.id, "gpt-5-pro", {
        status: "running",
        startedAt: new Date().toISOString(),
      });
      await sessionStore.updateSession(sessionMeta.id, {
        status: "running",
        startedAt: new Date().toISOString(),
        mode: "browser",
        browser: {
          config: {},
          runtime: {
            chromePort: 51559,
            chromeHost: "127.0.0.1",
            chromeTargetId: "t-1",
            tabUrl: "https://chatgpt.com/c/demo",
          },
        },
        response: { status: "running", incompleteReason: "chrome-disconnected" },
      });
      vi.spyOn(console, "log").mockImplementation(() => {});

      await attachSession(sessionMeta.id, { suppressMetadata: true, renderPrompt: false });

      const updated = await sessionStore.readSession(sessionMeta.id);
      expect(updated?.status).toBe("error");
      expect(updated?.response?.status).toBe("incomplete");
      expect(updated?.browser?.runtime?.assistantTurn).toBeUndefined();
      expect(updated?.errorMessage).toMatch(/incomplete exact assistant-turn evidence/i);
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      setOracleHomeDirOverrideForTest(null);
    }
  }, 20_000);

  test("does not reattach an errored chrome-disconnected session without a conversation URL", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-reattach-"));
    const { setOracleHomeDirOverrideForTest } = await import("../../src/oracleHome.js");
    setOracleHomeDirOverrideForTest(tmpHome);

    try {
      const { resumeBrowserSession } = await import("../../src/browser/reattach.js");
      const resumeMock = vi.mocked(resumeBrowserSession);
      resumeMock.mockResolvedValue({ answerText: "should not happen", answerMarkdown: "nope" });

      const { sessionStore } = await import("../../src/sessionStore.js");
      const { attachSession } = await import("../../src/cli/sessionDisplay.js");

      await sessionStore.ensureStorage();
      const sessionMeta = await sessionStore.createSession(
        {
          prompt: "Test prompt",
          model: "gpt-5.2-pro",
          mode: "browser",
          browserConfig: {},
        },
        "/repo",
      );
      await sessionStore.updateSession(sessionMeta.id, {
        status: "error",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        mode: "browser",
        browser: {
          config: {},
          runtime: {
            chromePort: 51559,
            chromeHost: "127.0.0.1",
            chromeTargetId: "t-1",
            tabUrl: "https://chatgpt.com/",
          },
        },
        response: { status: "error", incompleteReason: "chrome-disconnected" },
      });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await attachSession(sessionMeta.id, { suppressMetadata: true, renderPrompt: false });

      logSpy.mockRestore();

      expect(resumeMock).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      setOracleHomeDirOverrideForTest(null);
    }
  }, 20_000);

  test("reattaches a live chrome-disconnected session with a stale cached URL", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-reattach-"));
    const { setOracleHomeDirOverrideForTest } = await import("../../src/oracleHome.js");
    setOracleHomeDirOverrideForTest(tmpHome);

    try {
      const { resumeBrowserSession } = await import("../../src/browser/reattach.js");
      const resumeMock = vi.mocked(resumeBrowserSession);
      resumeMock.mockResolvedValue({
        answerText: "ok text",
        answerMarkdown: "ok markdown",
        assistantTurn: {
          messageId: "message-final",
          turnIndex: 3,
          modelSlug: "gpt-5-6-pro",
          responseSha256: createHash("sha256").update("ok markdown").digest("hex"),
          capturedAt: "2026-07-21T20:00:00.000Z",
        },
      });

      const { sessionStore } = await import("../../src/sessionStore.js");
      const { attachSession } = await import("../../src/cli/sessionDisplay.js");

      await sessionStore.ensureStorage();
      const sessionMeta = await sessionStore.createSession(
        {
          prompt: "Test prompt",
          model: "gpt-5.2-pro",
          mode: "browser",
          browserConfig: {},
        },
        "/repo",
      );
      await sessionStore.updateSession(sessionMeta.id, {
        status: "running",
        startedAt: new Date().toISOString(),
        mode: "browser",
        browser: {
          config: {},
          runtime: {
            chromeProfileRoot: path.join(tmpHome, "chrome-profile"),
            chromeHost: "127.0.0.1",
            chromeTargetId: "t-1",
            tabUrl: "https://chatgpt.com/",
            promptSubmitted: true,
          },
        },
        response: { status: "running", incompleteReason: "chrome-disconnected" },
      });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await attachSession(sessionMeta.id, { suppressMetadata: true, renderPrompt: false });

      logSpy.mockRestore();

      expect(resumeMock).toHaveBeenCalledTimes(1);
      const updated = await sessionStore.readSession(sessionMeta.id);
      expect(updated?.status).toBe("completed");
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      setOracleHomeDirOverrideForTest(null);
    }
  }, 20_000);

  test("reattaches completed Deep Research sessions that only captured a tool placeholder", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-reattach-"));
    const { setOracleHomeDirOverrideForTest } = await import("../../src/oracleHome.js");
    setOracleHomeDirOverrideForTest(tmpHome);

    try {
      const { resumeBrowserSession } = await import("../../src/browser/reattach.js");
      const resumeMock = vi.mocked(resumeBrowserSession);
      const recoveredReport =
        "# Deep report\n\nRecovered report body [1](<https://example.com/source>) [2]";
      resumeMock.mockResolvedValue({
        answerText: recoveredReport,
        answerMarkdown: recoveredReport,
        assistantTurn: {
          messageId: "message-fresh",
          finalMessageId: "message-fresh-final",
          turnId: "conversation-turn-4",
          turnIndex: 3,
          modelSlug: "gpt-5-5-instant",
          resolvedModelSlug: "gpt-5-5-instant",
          defaultModelSlug: "gpt-5-6-pro",
          deepResearchVersion: "standard",
          metadataSource: "chatgpt-conversation-record",
          responseSha256: createHash("sha256").update(recoveredReport).digest("hex"),
          capturedAt: "2026-07-15T00:00:00.000Z",
        },
        citationStatus: { total: 2, linked: 1, missingIndexes: [2] },
        // Persistence must not trust this producer-supplied array. It must
        // rebuild the citation warning from the fresh report/status pair.
        warnings: [],
      });

      const { sessionStore } = await import("../../src/sessionStore.js");
      const { attachSession } = await import("../../src/cli/sessionDisplay.js");

      await sessionStore.ensureStorage();
      const sessionMeta = await sessionStore.createSession(
        {
          prompt: "Deep research prompt",
          model: "gpt-5.5-pro",
          mode: "browser",
          browserConfig: { researchMode: "deep" },
        },
        "/repo",
      );
      await sessionStore.updateModelRun(sessionMeta.id, "gpt-5.5-pro", {
        status: "completed",
        usage: { inputTokens: 0, outputTokens: 3, reasoningTokens: 0, totalTokens: 3 },
      });
      await sessionStore.updateSession(sessionMeta.id, {
        status: "completed",
        mode: "browser",
        usage: { inputTokens: 0, outputTokens: 3, reasoningTokens: 0, totalTokens: 3 },
        browser: {
          config: { researchMode: "deep" },
          modelSelection: {
            requestedModel: "Pro",
            resolvedLabel: "Pro",
            strategy: "select",
            status: "already-selected",
            verified: true,
            source: "chatgpt-model-picker",
            capturedAt: "2026-07-15T00:00:00.000Z",
          },
          runtime: {
            chromePort: 51559,
            chromeHost: "127.0.0.1",
            chromeTargetId: "t-1",
            tabUrl: "https://chatgpt.com/c/deep",
            assistantTurn: {
              messageId: "message-stale",
              turnIndex: 1,
              modelSlug: "gpt-4o",
              responseSha256: "f".repeat(64),
              capturedAt: "2026-07-14T00:00:00.000Z",
            },
          },
          warnings: [
            {
              code: "browser-deep-research-provenance-incomplete",
              severity: "warning",
              message: "Stale provenance warning.",
            },
            {
              code: "browser-deep-research-citations-incomplete",
              severity: "warning",
              message: "Stale citation warning.",
            },
            {
              code: "browser-pro-fast-large-run",
              severity: "warning",
              message: "Unrelated warning must survive.",
            },
          ],
        },
        response: { status: "completed" },
      });
      const paths = await sessionStore.getPaths(sessionMeta.id);
      await fs.writeFile(paths.log, "Answer:\nCalled tool\n", "utf8");

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await attachSession(sessionMeta.id, { suppressMetadata: true, renderPrompt: false });

      logSpy.mockRestore();

      const updated = await sessionStore.readSession(sessionMeta.id);
      const log = await sessionStore.readLog(sessionMeta.id);
      expect(updated?.status).toBe("completed");
      expect(updated?.response?.status).toBe("completed");
      expect(updated?.browser?.runtime?.assistantTurn).toMatchObject({
        messageId: "message-fresh",
        turnIndex: 3,
        modelSlug: "gpt-5-5-instant",
        responseSha256: createHash("sha256").update(recoveredReport).digest("hex"),
      });
      expect(updated?.browser?.citationStatus).toEqual({
        total: 2,
        linked: 1,
        missingIndexes: [2],
      });
      expect(updated?.browser?.warnings).toEqual([
        expect.objectContaining({ code: "browser-pro-fast-large-run" }),
        expect.objectContaining({
          code: "browser-deep-research-citations-incomplete",
          details: { total: 2, linked: 1, missingIndexes: [2] },
        }),
      ]);
      expect(resumeMock).toHaveBeenCalledTimes(1);
      expect(log).toContain("Recovered report body");
      expect(log).not.toContain("Called tool");
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      setOracleHomeDirOverrideForTest(null);
    }
  }, 20_000);

  test("reattaches completed Deep Research placeholders from a project URL", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-reattach-"));
    const { setOracleHomeDirOverrideForTest } = await import("../../src/oracleHome.js");
    setOracleHomeDirOverrideForTest(tmpHome);

    try {
      const { resumeBrowserSession } = await import("../../src/browser/reattach.js");
      const resumeMock = vi.mocked(resumeBrowserSession);
      const recoveredReport = "# Deep report\n\nRecovered report body.";
      resumeMock.mockResolvedValue({
        answerText: recoveredReport,
        answerMarkdown: recoveredReport,
        assistantTurn: {
          messageId: "message-project",
          finalMessageId: "message-project-final",
          turnIndex: 2,
          modelSlug: "gpt-5-5-instant",
          resolvedModelSlug: "gpt-5-5-instant",
          defaultModelSlug: "gpt-5-6-pro",
          deepResearchVersion: "standard",
          metadataSource: "chatgpt-conversation-record",
          responseSha256: createHash("sha256").update(recoveredReport).digest("hex"),
          capturedAt: "2026-07-15T00:00:00.000Z",
        },
        citationStatus: { total: 0, linked: 0, missingIndexes: [] },
      });

      const { sessionStore } = await import("../../src/sessionStore.js");
      const { attachSession } = await import("../../src/cli/sessionDisplay.js");

      await sessionStore.ensureStorage();
      const sessionMeta = await sessionStore.createSession(
        {
          prompt: "Deep research prompt",
          model: "gpt-5.5-pro",
          mode: "browser",
          browserConfig: { researchMode: "deep" },
        },
        "/repo",
      );
      await sessionStore.updateSession(sessionMeta.id, {
        status: "completed",
        mode: "browser",
        usage: { inputTokens: 0, outputTokens: 3, reasoningTokens: 0, totalTokens: 3 },
        browser: {
          config: { researchMode: "deep" },
          runtime: {
            tabUrl: "https://chatgpt.com/g/g-p-demo/project",
          },
        },
        response: { status: "completed" },
      });
      const paths = await sessionStore.getPaths(sessionMeta.id);
      await fs.writeFile(paths.log, "Answer:\nCalled tool\n", "utf8");

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await attachSession(sessionMeta.id, { suppressMetadata: true, renderPrompt: false });

      logSpy.mockRestore();

      expect(resumeMock).toHaveBeenCalledTimes(1);
      const updated = await sessionStore.readSession(sessionMeta.id);
      expect(updated?.status).toBe("completed");
      expect(updated?.browser?.warnings).toEqual([
        expect.objectContaining({
          code: "browser-deep-research-provenance-incomplete",
          details: expect.objectContaining({ missingFields: ["modelSelection"] }),
        }),
      ]);
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      setOracleHomeDirOverrideForTest(null);
    }
  }, 20_000);

  test("reattaches when controller pid is gone even without incompleteReason", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-reattach-"));
    const { setOracleHomeDirOverrideForTest } = await import("../../src/oracleHome.js");
    setOracleHomeDirOverrideForTest(tmpHome);

    try {
      const { resumeBrowserSession } = await import("../../src/browser/reattach.js");
      const resumeMock = vi.mocked(resumeBrowserSession);
      resumeMock.mockResolvedValue({
        answerText: "ok text",
        answerMarkdown: "ok markdown",
        assistantTurn: {
          messageId: "message-final",
          turnIndex: 3,
          modelSlug: "gpt-5-6-pro",
          responseSha256: createHash("sha256").update("ok markdown").digest("hex"),
          capturedAt: "2026-07-21T20:00:00.000Z",
        },
      });

      const { sessionStore } = await import("../../src/sessionStore.js");
      const { attachSession } = await import("../../src/cli/sessionDisplay.js");

      await sessionStore.ensureStorage();
      const sessionMeta = await sessionStore.createSession(
        {
          prompt: "Test prompt",
          model: "gpt-5.2-pro",
          mode: "browser",
          browserConfig: {},
        },
        "/repo",
      );
      await sessionStore.updateModelRun(sessionMeta.id, "gpt-5.2-pro", {
        status: "running",
        startedAt: new Date().toISOString(),
      });
      await sessionStore.updateSession(sessionMeta.id, {
        status: "running",
        startedAt: new Date().toISOString(),
        mode: "browser",
        browser: {
          config: {},
          runtime: {
            chromePort: 51559,
            chromeHost: "127.0.0.1",
            chromeTargetId: "t-1",
            tabUrl: "https://chatgpt.com/c/demo",
            controllerPid: undefined,
          },
        },
      });

      const deadController = spawn(process.execPath, ["-e", "process.exit(0)"], {
        stdio: "ignore",
      });
      await once(deadController, "exit");
      await sessionStore.updateSession(sessionMeta.id, {
        browser: {
          config: {},
          runtime: {
            chromePort: 51559,
            chromeHost: "127.0.0.1",
            chromeTargetId: "t-1",
            tabUrl: "https://chatgpt.com/c/demo",
            controllerPid: deadController.pid ?? undefined,
          },
        },
      });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await attachSession(sessionMeta.id, { suppressMetadata: true, renderPrompt: false });

      logSpy.mockRestore();

      const updated = await sessionStore.readSession(sessionMeta.id);
      expect(updated?.status).toBe("completed");
      expect(updated?.response?.status).toBe("completed");
      expect(resumeMock).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      setOracleHomeDirOverrideForTest(null);
    }
  }, 20_000);

  test("reattaches after CLI termination when Chrome is left running", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-reattach-"));
    const { setOracleHomeDirOverrideForTest } = await import("../../src/oracleHome.js");
    setOracleHomeDirOverrideForTest(tmpHome);

    try {
      const { resumeBrowserSession } = await import("../../src/browser/reattach.js");
      const resumeMock = vi.mocked(resumeBrowserSession);
      resumeMock.mockResolvedValue({
        answerText: "ok text",
        answerMarkdown: "ok markdown",
        assistantTurn: {
          messageId: "message-final",
          turnIndex: 3,
          modelSlug: "gpt-5-6-pro",
          responseSha256: createHash("sha256").update("ok markdown").digest("hex"),
          capturedAt: "2026-07-21T20:00:00.000Z",
        },
      });

      const { registerTerminationHooks } = await import("../../src/browser/chromeLifecycle.js");
      const { sessionStore } = await import("../../src/sessionStore.js");
      const { attachSession } = await import("../../src/cli/sessionDisplay.js");

      await sessionStore.ensureStorage();
      const sessionMeta = await sessionStore.createSession(
        {
          prompt: "Test prompt",
          model: "gpt-5.2-pro",
          mode: "browser",
          browserConfig: {},
        },
        "/repo",
      );
      await sessionStore.updateModelRun(sessionMeta.id, "gpt-5.2-pro", {
        status: "running",
        startedAt: new Date().toISOString(),
      });
      await sessionStore.updateSession(sessionMeta.id, {
        status: "running",
        startedAt: new Date().toISOString(),
        mode: "browser",
        browser: { config: {} },
        response: { status: "running" },
      });

      const deadController = spawn(process.execPath, ["-e", "process.exit(0)"], {
        stdio: "ignore",
      });
      await once(deadController, "exit");
      const deadControllerPid = deadController.pid ?? undefined;

      const emitRuntimeHint = async () => {
        await sessionStore.updateSession(sessionMeta.id, {
          browser: {
            config: {},
            runtime: {
              chromePort: 51559,
              chromeHost: "127.0.0.1",
              chromeTargetId: "t-1",
              tabUrl: "https://chatgpt.com/c/demo",
              controllerPid: deadControllerPid,
            },
          },
        });
      };

      const chrome = {
        pid: 4242,
        port: 51559,
        kill: vi.fn().mockResolvedValue(undefined),
      };
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      const removeHooks = registerTerminationHooks(
        chrome as unknown as import("chrome-launcher").LaunchedChrome,
        path.join(tmpHome, "chrome-profile"),
        false,
        () => {},
        { isInFlight: () => true, emitRuntimeHint },
      );

      process.emit("SIGINT");
      for (let i = 0; i < 20; i += 1) {
        const refreshed = await sessionStore.readSession(sessionMeta.id);
        if (refreshed?.browser?.runtime?.chromePort) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      removeHooks();
      exitSpy.mockRestore();

      expect(chrome.kill).not.toHaveBeenCalled();

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      await attachSession(sessionMeta.id, { suppressMetadata: true, renderPrompt: false });
      logSpy.mockRestore();

      const updated = await sessionStore.readSession(sessionMeta.id);
      expect(updated?.status).toBe("completed");
      expect(updated?.response?.status).toBe("completed");
      expect(resumeMock).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      setOracleHomeDirOverrideForTest(null);
    }
  }, 20_000);

  test("hands dead-controller recovery to one owner while later callers only observe", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-reattach-owner-"));
    const { setOracleHomeDirOverrideForTest } = await import("../../src/oracleHome.js");
    setOracleHomeDirOverrideForTest(tmpHome);

    try {
      const { resumeBrowserSession } = await import("../../src/browser/reattach.js");
      const resumeMock = vi.mocked(resumeBrowserSession);
      let releaseRecovery!: () => void;
      let signalRecoveryStarted!: () => void;
      const recoveryStarted = new Promise<void>((resolve) => {
        signalRecoveryStarted = resolve;
      });
      const recoveryGate = new Promise<void>((resolve) => {
        releaseRecovery = resolve;
      });

      const { sessionStore } = await import("../../src/sessionStore.js");
      const { attachSession } = await import("../../src/cli/sessionDisplay.js");
      await sessionStore.ensureStorage();
      const sessionMeta = await sessionStore.createSession(
        {
          prompt: "Single owner recovery prompt",
          model: "gpt-5.2-pro",
          mode: "browser",
          browserConfig: {},
        },
        "/repo",
      );
      const deadController = spawn(process.execPath, ["-e", "process.exit(0)"], {
        stdio: "ignore",
      });
      await once(deadController, "exit");
      await sessionStore.updateModelRun(sessionMeta.id, "gpt-5.2-pro", {
        status: "running",
        startedAt: new Date().toISOString(),
      });
      await sessionStore.updateSession(sessionMeta.id, {
        status: "running",
        startedAt: new Date().toISOString(),
        mode: "browser",
        browser: {
          config: {},
          runtime: {
            chromePort: 51559,
            chromeHost: "127.0.0.1",
            chromeTargetId: "t-owner",
            tabUrl: "https://chatgpt.com/c/single-owner",
            controllerPid: deadController.pid ?? undefined,
          },
        },
      });
      resumeMock.mockImplementation(async () => {
        signalRecoveryStarted();
        await recoveryGate;
        return {
          answerText: "owned",
          answerMarkdown: "owned markdown",
          assistantTurn: {
            messageId: "message-final",
            turnIndex: 3,
            modelSlug: "gpt-5-6-pro",
            responseSha256: createHash("sha256").update("owned markdown").digest("hex"),
            capturedAt: "2026-07-21T20:00:00.000Z",
          },
        };
      });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const owner = attachSession(sessionMeta.id, {
        suppressMetadata: true,
        renderPrompt: false,
      });
      await recoveryStarted;
      const claimed = await sessionStore.readSession(sessionMeta.id);
      expect(claimed?.browser?.runtime?.controllerPid).toBe(process.pid);

      const observer = attachSession(sessionMeta.id, {
        suppressMetadata: true,
        renderPrompt: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(resumeMock).toHaveBeenCalledTimes(1);

      releaseRecovery();
      await Promise.all([owner, observer]);
      logSpy.mockRestore();

      const updated = await sessionStore.readSession(sessionMeta.id);
      expect(updated?.status).toBe("completed");
      expect(updated?.response?.status).toBe("completed");
      expect(resumeMock).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      setOracleHomeDirOverrideForTest(null);
    }
  }, 20_000);

  test("terminalizes copied-profile artifact persistence failure and does not retry it", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-reattach-failure-"));
    const { setOracleHomeDirOverrideForTest } = await import("../../src/oracleHome.js");
    setOracleHomeDirOverrideForTest(tmpHome);

    try {
      const { resumeBrowserSession } = await import("../../src/browser/reattach.js");
      const resumeMock = vi.mocked(resumeBrowserSession);
      resumeMock.mockRejectedValue(
        new Error(
          "Required local artifacts were not saved; exact Chrome and copied profile were preserved.",
        ),
      );

      const { sessionStore } = await import("../../src/sessionStore.js");
      const { attachSession } = await import("../../src/cli/sessionDisplay.js");
      await sessionStore.ensureStorage();
      const sessionMeta = await sessionStore.createSession(
        {
          prompt: "Attached evidence recovery prompt",
          file: ["synthetic-observation.txt"],
          model: "gpt-5.5-pro",
          mode: "browser",
          browserAttachments: "always",
          browserConfig: {
            copyProfileSource: "/source/chrome-profile",
            researchMode: "deep",
          },
        },
        "/repo",
      );
      const deadController = spawn(process.execPath, ["-e", "process.exit(0)"], {
        stdio: "ignore",
      });
      await once(deadController, "exit");
      const preservedRuntime = {
        chromePid: 424_242,
        chromePort: 51559,
        chromeHost: "127.0.0.1",
        userDataDir: "/tmp/oracle-browser-fixture",
        copiedProfileRoot: "/tmp",
        chromeTargetId: "t-copy",
        tabUrl: "https://chatgpt.com/c/copied-orphan",
        conversationId: "copied-orphan",
        promptSubmitted: true,
        submittedUserMessageId: "user-copy",
        submittedUserTurnIndex: 1,
        controllerPid: deadController.pid ?? undefined,
      };
      await sessionStore.updateModelRun(sessionMeta.id, "gpt-5.5-pro", {
        status: "running",
        startedAt: new Date().toISOString(),
      });
      await sessionStore.updateSession(sessionMeta.id, {
        status: "running",
        startedAt: new Date().toISOString(),
        mode: "browser",
        browser: {
          config: {
            copyProfileSource: "/source/chrome-profile",
            researchMode: "deep",
          },
          runtime: preservedRuntime,
        },
        response: { status: "running" },
      });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await attachSession(sessionMeta.id, { suppressMetadata: true, renderPrompt: false });
      const failed = await sessionStore.readSession(sessionMeta.id);
      expect(failed?.status).toBe("error");
      expect(failed?.completedAt).toBeTruthy();
      expect(failed?.response).toEqual({
        status: "incomplete",
        incompleteReason: "controller-disconnected",
      });
      expect(failed?.error).toMatchObject({
        category: "browser-automation",
        details: {
          stage: "reattach-failed",
          reattachable: false,
          recovery: "copied-profile-orphan",
        },
      });
      expect(failed?.browser?.runtime).toMatchObject({
        ...preservedRuntime,
        controllerPid: process.pid,
      });
      expect(failed?.options.file).toEqual(["synthetic-observation.txt"]);
      expect(failed?.options.browserAttachments).toBe("always");
      expect(failed?.models?.find((run) => run.model === "gpt-5.5-pro")).toMatchObject({
        status: "error",
        response: {
          status: "incomplete",
          incompleteReason: "controller-disconnected",
        },
      });

      await attachSession(sessionMeta.id, { suppressMetadata: true, renderPrompt: false });
      logSpy.mockRestore();
      expect(resumeMock).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      setOracleHomeDirOverrideForTest(null);
    }
  }, 20_000);
});
