import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { resumeBrowserSession, __test__ } from "../../src/browser/reattach.js";
import type { BrowserLogger, ChromeClient } from "../../src/browser/types.js";

type FakeTarget = { id?: string; targetId?: string; type?: string; url?: string };
type FakeClient = {
  // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
  Runtime: {
    enable: () => void;
    evaluate: (params: {
      expression: string;
      returnByValue?: boolean;
    }) => Promise<{ result: { value: unknown } }>;
  };
  // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
  DOM: { enable: () => void };
  // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
  Page?: { enable: () => void };
  close: () => Promise<void> | void;
};

describe("resumeBrowserSession", () => {
  test("selects target and captures markdown via stubs", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
    };
    const listTargets = vi.fn(
      async () =>
        [
          { targetId: "target-1", type: "page", url: runtime.tabUrl },
          { targetId: "target-2", type: "page", url: "about:blank" },
        ] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const close = vi.fn(async () => {});
    const connect = vi.fn(
      async () =>
        ({
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Runtime: { enable: vi.fn(), evaluate },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          DOM: { enable: vi.fn() },
          close,
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "Hello PATH plan",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-1" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "markdown response");
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await resumeBrowserSession(runtime, { timeoutMs: 2000 }, logger, {
      listTargets,
      connect,
      waitForAssistantResponse,
      captureAssistantMarkdown,
    });

    expect(result.answerMarkdown).toBe("markdown response");
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ host: "127.0.0.1", port: 51559, target: "target-1" }),
    );
    expect(waitForAssistantResponse).toHaveBeenCalled();
    expect(captureAssistantMarkdown).toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  test("persists required artifacts before applying archive=always on the pinned conversation", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
      conversationId: "abc",
    };
    const order: string[] = [];
    const listTargets = vi.fn(async () => [
      { targetId: "target-1", type: "page", url: runtime.tabUrl },
    ]) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      if (expression.includes("findArchiveMenuItem")) {
        order.push("archive");
        return {
          result: {
            value: { status: "archived", conversationUrl: runtime.tabUrl },
          },
        };
      }
      return { result: { value: null } };
    });
    const close = vi.fn(async () => {
      order.push("close");
    });
    const connect = vi.fn(
      async () =>
        ({
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Runtime: { enable: vi.fn(), evaluate },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          DOM: { enable: vi.fn() },
          close,
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(
      runtime,
      { timeoutMs: 2_000, archiveConversations: "always" },
      logger,
      {
        listTargets,
        connect,
        waitForAssistantResponse: vi.fn(async () => ({
          text: "reattached answer",
          html: "",
          meta: { messageId: "m1", turnId: "conversation-turn-1" },
        })),
        captureAssistantMarkdown: vi.fn(async () => "reattached markdown"),
        persistResultBeforeClose: vi.fn(async () => {
          order.push("persist");
          return true;
        }),
      },
    );

    expect(result.archive).toEqual({
      mode: "always",
      attempted: true,
      archived: true,
      conversationUrl: runtime.tabUrl,
    });
    expect(order).toEqual(["persist", "archive", "close"]);
  });

  test("uses prompt preview turn index when reattaching to an already-open answer", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
    };
    const listTargets = vi.fn(
      async () =>
        [{ targetId: "target-1", type: "page", url: runtime.tabUrl }] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      if (expression.includes("const needle =")) {
        return { result: { value: 3 } };
      }
      return { result: { value: null } };
    });
    const connect = vi.fn(
      async () =>
        ({
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Runtime: { enable: vi.fn(), evaluate },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          DOM: { enable: vi.fn() },
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "live reattach pro 123",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-4" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "live reattach pro 123");
    const logger = vi.fn() as BrowserLogger;

    await resumeBrowserSession(runtime, { timeoutMs: 2000 }, logger, {
      listTargets,
      connect,
      waitForAssistantResponse,
      captureAssistantMarkdown,
      promptPreview: "live reattach pro 123",
    });

    expect(waitForAssistantResponse).toHaveBeenCalledWith(expect.anything(), 2000, logger, 3);
  });

  test("uses Deep Research completion path when reattaching research sessions", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/deep",
      submittedUserMessageId: "user-message-deep",
      submittedUserTurnIndex: 3,
    };
    const listTargets = vi.fn(
      async () =>
        [
          { targetId: "target-1", type: "page", url: runtime.tabUrl },
          { targetId: "target-2", type: "page", url: "about:blank" },
        ] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      if (expression.includes("querySelectorAll")) {
        return { result: { value: 3 } };
      }
      return { result: { value: null } };
    });
    const connect = vi.fn(
      async () =>
        ({
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Runtime: { enable: vi.fn(), evaluate },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          DOM: { enable: vi.fn() },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Page: { enable: vi.fn() },
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn();
    const captureAssistantMarkdown = vi.fn();
    const waitForDeepResearchCompletion = vi.fn(async () => ({
      text: "Deep report body [1](<https://example.com/one>) [2]",
      html: "<p>Deep report body</p>",
      meta: {
        turnId: "conversation-turn-4",
        messageId: "message-deep",
        finalMessageId: "message-deep-final",
        turnIndex: 3,
        modelSlug: "gpt-5-5-instant",
        resolvedModelSlug: "gpt-5-5-instant",
        defaultModelSlug: "gpt-5-6-pro",
        deepResearchVersion: "standard",
        metadataSource: "chatgpt-conversation-record" as const,
      },
      assistantTurn: {
        turnId: "conversation-turn-4",
        messageId: "message-deep",
        finalMessageId: "message-deep-final",
        turnIndex: 3,
        modelSlug: "gpt-5-5-instant",
        resolvedModelSlug: "gpt-5-5-instant",
        defaultModelSlug: "gpt-5-6-pro",
        deepResearchVersion: "standard",
        metadataSource: "chatgpt-conversation-record" as const,
        responseSha256: createHash("sha256")
          .update("Deep report body [1](<https://example.com/one>) [2]")
          .digest("hex"),
        capturedAt: "2026-07-15T00:00:00.000Z",
      },
      citationStatus: { total: 2, linked: 1, missingIndexes: [2] },
    }));
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await resumeBrowserSession(
      runtime,
      { timeoutMs: 2000, researchMode: "deep" },
      logger,
      {
        listTargets,
        connect,
        waitForAssistantResponse,
        captureAssistantMarkdown,
        waitForDeepResearchCompletion,
      },
    );

    expect(result.answerMarkdown).toBe("Deep report body [1](<https://example.com/one>) [2]");
    expect(result.assistantTurn).toMatchObject({
      messageId: "message-deep",
      turnIndex: 3,
      modelSlug: "gpt-5-5-instant",
      defaultModelSlug: "gpt-5-6-pro",
      responseSha256: createHash("sha256")
        .update("Deep report body [1](<https://example.com/one>) [2]")
        .digest("hex"),
    });
    expect(result.citationStatus).toEqual({ total: 2, linked: 1, missingIndexes: [2] });
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "browser-deep-research-citations-incomplete",
        details: { total: 2, linked: 1, missingIndexes: [2] },
      }),
    ]);
    expect(waitForDeepResearchCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ evaluate }),
      logger,
      2000,
      3,
      expect.any(Object),
      expect.any(Object),
      {
        requireScopedTargetOwner: true,
        expectedConversationId: "deep",
        expectedUserMessageId: "user-message-deep",
      },
    );
    expect(waitForAssistantResponse).not.toHaveBeenCalled();
    expect(captureAssistantMarkdown).not.toHaveBeenCalled();
  });

  test("fails closed when a Deep Research reattach leaves the saved conversation", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/deep",
    };
    const listTargets = vi.fn(async () => [
      { targetId: "target-1", type: "page", url: runtime.tabUrl },
    ]) as unknown as () => Promise<FakeTarget[]>;
    let hrefReads = 0;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        hrefReads += 1;
        return {
          result: {
            value: hrefReads === 1 ? "https://chatgpt.com/c/deep" : "https://chatgpt.com/c/other",
          },
        };
      }
      if (expression === "1+1") return { result: { value: 2 } };
      if (expression.includes("querySelectorAll")) return { result: { value: 3 } };
      return { result: { value: null } };
    });
    const close = vi.fn(async () => {});
    const connectMock = vi.fn(async () => ({
      Runtime: { enable: vi.fn(), evaluate },
      DOM: { enable: vi.fn() },
      Page: { enable: vi.fn() },
      close,
    })) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const connect = connectMock;
    const waitForDeepResearchCompletion = vi.fn();
    const recoverSession = vi.fn(async () => ({
      answerText: "safe recovery",
      answerMarkdown: "safe recovery",
    }));
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(
      runtime,
      { timeoutMs: 2_000, researchMode: "deep" },
      logger,
      {
        listTargets,
        connect,
        waitForDeepResearchCompletion,
        recoverSession,
      },
    );

    expect(result.answerMarkdown).toBe("safe recovery");
    expect(waitForDeepResearchCompletion).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(recoverSession).toHaveBeenCalledOnce();
  });

  test("does not scan Deep Research when no reattach turn boundary can be established", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/deep",
    };
    const listTargets = vi.fn(
      async () =>
        [{ targetId: "target-1", type: "page", url: runtime.tabUrl }] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") return { result: { value: runtime.tabUrl } };
      if (expression === "1+1") return { result: { value: 2 } };
      if (expression.includes("const needle =")) return { result: { value: null } };
      return { result: { value: undefined } };
    });
    const close = vi.fn(async () => {});
    const connect = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          Page: { enable: vi.fn() },
          close,
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForDeepResearchCompletion = vi.fn(async () => ({
      text: "wrong report",
      meta: {},
    }));
    const recoverSession = vi.fn(async () => ({
      answerText: "safe fallback",
      answerMarkdown: "safe fallback",
    }));
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(
      runtime,
      { timeoutMs: 2_000, researchMode: "deep" },
      logger,
      {
        listTargets,
        connect,
        promptPreview: "unmatched prompt preview",
        waitForDeepResearchCompletion,
        recoverSession,
      },
    );

    expect(result.answerMarkdown).toBe("safe fallback");
    expect(waitForDeepResearchCompletion).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(recoverSession).toHaveBeenCalledOnce();
  });

  test("falls back to recovery when chrome port is missing", async () => {
    const runtime = {
      tabUrl: "https://chatgpt.com/c/abc",
    };
    const recoverSession = vi.fn(async () => ({
      answerText: "fallback",
      answerMarkdown: "fallback-md",
    }));
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(runtime, {}, logger, { recoverSession });

    expect(result.answerMarkdown).toBe("fallback-md");
    expect(recoverSession).toHaveBeenCalled();
  });

  test("never launches a fresh browser when a copied-profile endpoint is missing", async () => {
    const runtime = {
      chromePid: 4242,
      userDataDir: "/tmp/oracle-browser-copy",
      copiedProfileRoot: "/tmp",
      tabUrl: "https://chatgpt.com/c/abc",
    };
    const recoverSession = vi.fn(async () => ({
      answerText: "unsafe fallback",
      answerMarkdown: "unsafe fallback",
    }));
    const logger = vi.fn() as BrowserLogger;

    await expect(
      resumeBrowserSession(runtime, { copyProfileSource: "/source/chrome-profile" }, logger, {
        recoverSession,
      }),
    ).rejects.toThrow(/exact existing Chrome endpoint.*fallback is disabled/i);

    expect(recoverSession).not.toHaveBeenCalled();
  });

  test("persists, closes, then cleans the exact copied-profile Chrome", async () => {
    const runtime = {
      chromePid: 4242,
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      userDataDir: "/tmp/oracle-browser-copy",
      copiedProfileRoot: "/tmp",
      tabUrl: "https://chatgpt.com/c/abc",
    };
    const identity = {
      userDataDir: runtime.userDataDir,
      sourceUserDataDir: "/source/chrome-profile",
      copiedProfileRoot: runtime.copiedProfileRoot,
      pid: runtime.chromePid,
      port: runtime.chromePort,
      host: runtime.chromeHost,
    };
    const order: string[] = [];
    const listTargets = vi.fn(async () => [
      { targetId: "target-1", type: "page", url: runtime.tabUrl },
    ]) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") return { result: { value: runtime.tabUrl } };
      if (expression === "1+1") return { result: { value: 2 } };
      return { result: { value: null } };
    });
    const connect = vi.fn(async () => ({
      Runtime: { enable: vi.fn(), evaluate },
      DOM: { enable: vi.fn() },
      close: vi.fn(async () => {
        order.push("close");
      }),
    })) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const validateCopiedProfileChrome = vi.fn(async () => identity);
    const cleanupCopiedProfileChrome = vi.fn(async () => {
      order.push("cleanup");
    });
    const recoverSession = vi.fn(async () => ({
      answerText: "unsafe fallback",
      answerMarkdown: "unsafe fallback",
    }));
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(
      runtime,
      { copyProfileSource: identity.sourceUserDataDir, timeoutMs: 2_000 },
      logger,
      {
        listTargets,
        connect,
        validateCopiedProfileChrome,
        cleanupCopiedProfileChrome,
        recoverSession,
        waitForAssistantResponse: vi.fn(async () => ({
          text: "reattached answer",
          html: "",
          meta: { messageId: "m1", turnId: "conversation-turn-1" },
        })),
        captureAssistantMarkdown: vi.fn(async () => "reattached markdown"),
        persistResultBeforeClose: vi.fn(async () => {
          order.push("persist");
          return true;
        }),
      },
    );

    expect(result.answerMarkdown).toBe("reattached markdown");
    expect(order).toEqual(["persist", "close", "cleanup"]);
    expect(validateCopiedProfileChrome).toHaveBeenCalledWith({
      userDataDir: runtime.userDataDir,
      sourceUserDataDir: identity.sourceUserDataDir,
      copiedProfileRoot: runtime.copiedProfileRoot,
      pid: runtime.chromePid,
      port: runtime.chromePort,
      host: runtime.chromeHost,
    });
    expect(cleanupCopiedProfileChrome).toHaveBeenCalledWith(identity, logger);
    expect(recoverSession).not.toHaveBeenCalled();
  });

  test("preserves exact copied-profile Chrome when required artifact persistence returns false", async () => {
    const runtime = {
      chromePid: 4242,
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      userDataDir: "/tmp/oracle-browser-copy",
      copiedProfileRoot: "/tmp",
      tabUrl: "https://chatgpt.com/c/abc",
    };
    const identity = {
      userDataDir: runtime.userDataDir,
      sourceUserDataDir: "/source/chrome-profile",
      copiedProfileRoot: runtime.copiedProfileRoot,
      pid: runtime.chromePid,
      port: runtime.chromePort,
      host: runtime.chromeHost,
    };
    const order: string[] = [];
    const listTargets = vi.fn(async () => [
      { targetId: "target-1", type: "page", url: runtime.tabUrl },
    ]) as unknown as () => Promise<FakeTarget[]>;
    const connectMock = vi.fn(async () => ({
      Runtime: {
        enable: vi.fn(),
        evaluate: vi.fn(async ({ expression }: { expression: string }) => {
          if (expression === "location.href") return { result: { value: runtime.tabUrl } };
          if (expression === "1+1") return { result: { value: 2 } };
          return { result: { value: null } };
        }),
      },
      DOM: { enable: vi.fn() },
      close: vi.fn(async () => {
        order.push("close");
      }),
    })) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const connect = connectMock;
    const cleanupCopiedProfileChrome = vi.fn(async () => {
      order.push("cleanup");
    });
    const recoverSession = vi.fn(async () => ({
      answerText: "unsafe fallback",
      answerMarkdown: "unsafe fallback",
    }));
    const logger = vi.fn() as BrowserLogger;

    await expect(
      resumeBrowserSession(
        runtime,
        { copyProfileSource: identity.sourceUserDataDir, timeoutMs: 2_000 },
        logger,
        {
          listTargets,
          connect,
          validateCopiedProfileChrome: vi.fn(async () => identity),
          cleanupCopiedProfileChrome,
          recoverSession,
          waitForAssistantResponse: vi.fn(async () => ({
            text: "reattached answer",
            html: "",
            meta: { messageId: "m1", turnId: "conversation-turn-1" },
          })),
          captureAssistantMarkdown: vi.fn(async () => "reattached markdown"),
          persistResultBeforeClose: vi.fn(async () => {
            order.push("persist");
            return false;
          }),
        },
      ),
    ).rejects.toThrow(/required local artifacts.*preserved/i);

    expect(order).toEqual(["persist", "close"]);
    expect(cleanupCopiedProfileChrome).not.toHaveBeenCalled();
    expect(recoverSession).not.toHaveBeenCalled();
  });

  test("ignores a hostile persisted websocket and uses only validated host and port", async () => {
    const runtime = {
      chromePid: 4242,
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeBrowserWSEndpoint: "ws://attacker.invalid:51559/devtools/browser/hostile",
      chromeTargetId: "target-1",
      userDataDir: "/tmp/oracle-browser-copy",
      copiedProfileRoot: "/tmp",
      tabUrl: "https://chatgpt.com/c/abc",
    };
    const identity = {
      userDataDir: runtime.userDataDir,
      sourceUserDataDir: "/source/chrome-profile",
      copiedProfileRoot: runtime.copiedProfileRoot,
      pid: runtime.chromePid,
      port: runtime.chromePort,
      host: runtime.chromeHost,
    };
    const listTargets = vi.fn(async () => [
      { targetId: "target-1", type: "page", url: runtime.tabUrl },
    ]);
    const connectMock = vi.fn(async () => ({
      Runtime: {
        enable: vi.fn(),
        evaluate: vi.fn(async ({ expression }: { expression: string }) => {
          if (expression === "location.href") return { result: { value: runtime.tabUrl } };
          if (expression === "1+1") return { result: { value: 2 } };
          return { result: { value: null } };
        }),
      },
      DOM: { enable: vi.fn() },
      close: vi.fn(async () => {}),
    }));
    const connect = connectMock as unknown as (options?: unknown) => Promise<ChromeClient>;
    const logger = vi.fn() as BrowserLogger;

    await resumeBrowserSession(
      runtime,
      { copyProfileSource: identity.sourceUserDataDir, timeoutMs: 2_000 },
      logger,
      {
        listTargets,
        connect,
        validateCopiedProfileChrome: vi.fn(async () => identity),
        cleanupCopiedProfileChrome: vi.fn(async () => {}),
        waitForAssistantResponse: vi.fn(async () => ({
          text: "reattached answer",
          html: "",
          meta: { messageId: "m1", turnId: "conversation-turn-1" },
        })),
        captureAssistantMarkdown: vi.fn(async () => "reattached markdown"),
      },
    );

    expect(listTargets).toHaveBeenCalledWith({
      host: identity.host,
      port: identity.port,
      browserWSEndpoint: undefined,
    });
    expect(connect).toHaveBeenCalledWith({
      host: identity.host,
      port: identity.port,
      target: runtime.chromeTargetId,
    });
    expect(JSON.stringify([listTargets.mock.calls, connectMock.mock.calls])).not.toContain(
      "attacker.invalid",
    );
  });

  test("cleans an exact copied profile after attach failure without fresh-browser fallback", async () => {
    const runtime = {
      chromePid: 4242,
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      userDataDir: "/tmp/oracle-browser-copy",
      copiedProfileRoot: "/tmp",
      tabUrl: "https://chatgpt.com/c/abc",
    };
    const identity = {
      userDataDir: runtime.userDataDir,
      sourceUserDataDir: "/source/chrome-profile",
      copiedProfileRoot: runtime.copiedProfileRoot,
      pid: runtime.chromePid,
      port: runtime.chromePort,
      host: runtime.chromeHost,
    };
    const order: string[] = [];
    const listTargets = vi.fn(async () => [
      { targetId: "target-1", type: "page", url: runtime.tabUrl },
    ]) as unknown as () => Promise<FakeTarget[]>;
    const connect = vi.fn(async () => ({
      Runtime: {
        enable: vi.fn(),
        evaluate: vi.fn(async ({ expression }: { expression: string }) => {
          if (expression === "location.href") return { result: { value: runtime.tabUrl } };
          if (expression === "1+1") return { result: { value: 2 } };
          return { result: { value: null } };
        }),
      },
      DOM: { enable: vi.fn() },
      close: vi.fn(async () => {
        order.push("close");
      }),
    })) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const cleanupCopiedProfileChrome = vi.fn(async () => {
      order.push("cleanup");
    });
    const recoverSession = vi.fn(async () => ({
      answerText: "unsafe fallback",
      answerMarkdown: "unsafe fallback",
    }));
    const logger = vi.fn() as BrowserLogger;

    await expect(
      resumeBrowserSession(
        runtime,
        { copyProfileSource: identity.sourceUserDataDir, timeoutMs: 2_000 },
        logger,
        {
          listTargets,
          connect,
          validateCopiedProfileChrome: vi.fn(async () => identity),
          cleanupCopiedProfileChrome,
          recoverSession,
          waitForAssistantResponse: vi.fn(async () => {
            throw new Error("response timeout");
          }),
        },
      ),
    ).rejects.toThrow(/Exact copied-profile Chrome recovery failed.*fallback is disabled/i);

    expect(order).toEqual(["close", "cleanup"]);
    expect(cleanupCopiedProfileChrome).toHaveBeenCalledOnce();
    expect(recoverSession).not.toHaveBeenCalled();
    expect(logger).not.toHaveBeenCalledWith(expect.stringContaining("reopening browser"));
  });

  test("tries live reattach from browser websocket metadata before falling back", async () => {
    const runtime = {
      chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      chromeProfileRoot: "/tmp/oracle-attach-running-profile",
      tabUrl: "https://chatgpt.com/c/abc",
      chromeTargetId: "target-2",
    };
    const listTargets = vi.fn(
      async () =>
        [
          { targetId: "target-2", type: "page", url: "https://chatgpt.com/c/abc" },
        ] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const connect = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "attached",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-1" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "attached-md");
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(
      runtime,
      { attachRunning: true, timeoutMs: 2_000 },
      logger,
      {
        listTargets,
        connect,
        waitForAssistantResponse,
        captureAssistantMarkdown,
      },
    );

    expect(result.answerMarkdown).toBe("attached-md");
    expect(listTargets).toHaveBeenCalled();
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "ws://127.0.0.1:9222/devtools/browser/abc",
        local: true,
      }),
    );
  });

  test("closes the attached client before falling back to recovery", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
    };
    const listTargets = vi.fn(async () => {
      return [{ targetId: "target-1", type: "page", url: runtime.tabUrl }] satisfies FakeTarget[];
    }) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const close = vi.fn(async () => {});
    const connect = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate },
          DOM: { enable: vi.fn() },
          close,
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => {
      throw new Error("response timeout");
    });
    const recoverSession = vi.fn(async () => ({
      answerText: "fallback",
      answerMarkdown: "fallback-md",
    }));
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(runtime, {}, logger, {
      listTargets,
      connect,
      waitForAssistantResponse,
      recoverSession,
    });

    expect(result.answerText).toBe("fallback");
    expect(close).toHaveBeenCalledOnce();
    expect(recoverSession).toHaveBeenCalled();
  });
});

describe("reattach helpers", () => {
  const {
    pickTarget,
    extractConversationIdFromUrl,
    buildConversationUrl,
    openConversationFromSidebar,
    readReattachMinTurnIndex,
  } = __test__;
  type EvaluateParams = { expression: string };
  type EvaluateResult<T> = { result: { value: T } };

  test("extracts conversation id from a chat URL", () => {
    expect(extractConversationIdFromUrl("https://chatgpt.com/c/abc-123")).toBe("abc-123");
    expect(extractConversationIdFromUrl("")).toBeUndefined();
  });

  test("builds conversation URL from tabUrl or conversationId", () => {
    expect(
      buildConversationUrl(
        { tabUrl: "https://chatgpt.com/c/live", conversationId: "ignored" },
        "https://chatgpt.com/",
      ),
    ).toBe("https://chatgpt.com/c/live");
    expect(buildConversationUrl({ conversationId: "abc" }, "https://chatgpt.com/")).toBe(
      "https://chatgpt.com/c/abc",
    );
  });

  test("pickTarget prefers a saved conversation over a stale target id", () => {
    const targets = [
      { targetId: "t-1", type: "page", url: "https://chatgpt.com/c/first" },
      { targetId: "t-2", type: "page", url: "https://chatgpt.com/c/second" },
      { targetId: "t-3", type: "page", url: "about:blank" },
    ];
    expect(pickTarget(targets, { chromeTargetId: "t-2" })).toEqual(targets[1]);
    expect(
      pickTarget(targets, {
        chromeTargetId: "t-2",
        tabUrl: "https://chatgpt.com/c/first",
        conversationId: "first",
      }),
    ).toEqual(targets[0]);
    expect(pickTarget(targets, { tabUrl: "https://chatgpt.com/c/first" })).toEqual(targets[0]);
    expect(pickTarget(targets, {})).toEqual(targets[0]);
  });

  test("pickTarget keeps the saved target among duplicate conversation tabs", () => {
    const targets = [
      { targetId: "duplicate", type: "page", url: "https://chatgpt.com/c/same" },
      { targetId: "submitted", type: "page", url: "https://chatgpt.com/c/same" },
    ];

    expect(
      pickTarget(targets, {
        chromeTargetId: "submitted",
        conversationId: "same",
      }),
    ).toEqual(targets[1]);
  });

  test("pickTarget understands CDP list ids", () => {
    const targets = [
      { id: "page-1", type: "page", url: "https://chatgpt.com/c/first" },
      { id: "page-2", type: "page", url: "about:blank" },
    ];

    expect(pickTarget(targets, { chromeTargetId: "page-1" })).toEqual(targets[0]);
  });

  test("openConversationFromSidebar passes conversationId and projects preference", async () => {
    const evaluate = vi.fn<
      (
        params: EvaluateParams,
      ) => Promise<EvaluateResult<{ ok: boolean; href?: string; count: number }>>
    >(async () => ({
      result: { value: { ok: true, href: "https://chatgpt.com/c/abc", count: 3 } },
    }));
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];

    const ok = await openConversationFromSidebar(runtime, {
      conversationId: "abc",
      preferProjects: true,
    });

    expect(ok).toBe(true);
    const call = evaluate.mock.calls[0]?.[0] as EvaluateParams | undefined;
    expect(call?.expression).toContain('const conversationId = "abc"');
    expect(call?.expression).toContain("const preferProjects = true");
  });

  test("openConversationFromSidebar handles missing conversationId", async () => {
    const evaluate = vi.fn<
      (params: EvaluateParams) => Promise<EvaluateResult<{ ok: boolean; count: number }>>
    >(async () => ({
      result: { value: { ok: false, count: 0 } },
    }));
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];

    const ok = await openConversationFromSidebar(runtime, { preferProjects: false });

    expect(ok).toBe(false);
    const call = evaluate.mock.calls[0]?.[0] as EvaluateParams | undefined;
    expect(call?.expression).toContain("const conversationId = null");
    expect(call?.expression).toContain("const preferProjects = false");
  });

  test("falls back to the current turn index when prompt preview matching misses", async () => {
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression.includes("const needle =")) {
        return { result: { value: null } };
      }
      return { result: { value: 5 } };
    });
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];
    const logger = vi.fn() as BrowserLogger;

    await expect(
      readReattachMinTurnIndex(runtime, "preview that no longer matches", logger),
    ).resolves.toBe(4);
    expect(evaluate).toHaveBeenCalledTimes(2);
  });
});
