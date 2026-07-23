import { describe, expect, it, vi, beforeEach } from "vitest";
import vm from "node:vm";
import { createHash } from "node:crypto";

// Mock delay to resolve instantly in tests
vi.mock("../../src/browser/utils.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    delay: vi.fn(() => Promise.resolve()),
  };
});

import {
  activateDeepResearch,
  applyDeepResearchCitationSourcesForTest,
  buildActivateDeepResearchExpressionForTest,
  buildDeepResearchActiveRecordMetadataExpressionForTest,
  buildDeepResearchCitationSourcesExpressionForTest,
  buildDeepResearchCompletionPollExpressionForTest,
  buildDeepResearchConversationRecordMetadataExpressionForTest,
  buildDeepResearchFrameStatusExpressionForTest,
  buildDeepResearchStatusExpressionForTest,
  buildDeepResearchSubmittedUserTurnExpressionForTest,
  captureDeepResearchTargetKeys,
  enrichDeepResearchTurnMetadataFromConversationRecordForTest,
  filterIncompleteDeepResearchReadForTest,
  findDeepResearchFrameIdForTest,
  hasFreshDeepResearchContentProofForTest,
  hasStableCompletedDeepResearchReadForTest,
  hasVerifiedDeepResearchCitationUiContractForTest,
  isConfirmedDeepResearchTargetForTest,
  isDeepResearchPlaceholderTextForTest,
  isSameDeepResearchOwnerForTest,
  normalizeDeepResearchCitationSourcesForTest,
  pickPreferredDeepResearchReadForTest,
  shouldSkipDeepResearchTargetForTest,
  waitForResearchPlanAutoConfirm,
  waitForDeepResearchSubmittedUserTurn,
  waitForDeepResearchCompletion,
  checkDeepResearchStatus,
} from "../../src/browser/actions/deepResearch.js";
import type { BrowserLogger } from "../../src/browser/types.js";

const TEST_CITATION_NONCE = "0123456789abcdef0123456789abcdef";

function createMockRuntime() {
  return {
    evaluate: vi.fn(),
  };
}

function createMockLogger(): BrowserLogger {
  const fn = vi.fn() as BrowserLogger;
  fn.verbose = false;
  fn.sessionLog = vi.fn();
  return fn;
}

function createFrameOwnerClient(
  ownerTurn:
    | number
    | null
    | { messageId?: string; turnId?: string; turnIndex?: number; modelSlug?: string }
    | ((
        frameId: string,
      ) =>
        | number
        | null
        | { messageId?: string; turnId?: string; turnIndex?: number; modelSlug?: string }),
) {
  let currentFrameId = "";
  return {
    on: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "DOM.getFrameOwner") {
        currentFrameId = String(params?.frameId ?? "");
        return { backendNodeId: 7 };
      }
      if (method === "DOM.resolveNode") return { object: { objectId: "frame-owner" } };
      if (method === "Runtime.callFunctionOn") {
        return {
          result: {
            value: typeof ownerTurn === "function" ? ownerTurn(currentFrameId) : ownerTurn,
          },
        };
      }
      return {};
    }),
  };
}

interface TestDomNode {
  nodeType: number;
  tagName?: string;
  textContent: string;
  innerText?: string;
  childNodes?: TestDomNode[];
  children?: TestDomNode[];
  getAttribute?: (name: string) => string | null;
  querySelectorAll?: (selector: string) => TestDomNode[];
}

function testText(text: string): TestDomNode {
  return { nodeType: 3, textContent: text };
}

function testElement(
  tagName: string,
  children: TestDomNode[] = [],
  attributes: Record<string, string> = {},
): TestDomNode {
  const elementChildren = children.filter((child) => child.nodeType === 1);
  const node: TestDomNode = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    childNodes: children,
    children: elementChildren,
    textContent: children.map((child) => child.textContent).join(""),
    getAttribute: (name) => attributes[name] ?? null,
  };
  node.innerText = node.textContent;
  node.querySelectorAll = (selector) => {
    const tags = selector
      .split(",")
      .map((part) => part.trim().toUpperCase())
      .filter((part) => /^[A-Z]+$/.test(part));
    const matches: TestDomNode[] = [];
    const visit = (candidate: TestDomNode) => {
      if (candidate.tagName && tags.includes(candidate.tagName)) matches.push(candidate);
      for (const child of candidate.children ?? []) visit(child);
    };
    for (const child of elementChildren) visit(child);
    return matches;
  };
  return node;
}

describe("activateDeepResearch", () => {
  let mockRuntime: ReturnType<typeof createMockRuntime>;
  let mockInput: Record<string, unknown>;
  let mockLogger: BrowserLogger;

  beforeEach(() => {
    mockRuntime = createMockRuntime();
    mockInput = {};
    mockLogger = createMockLogger();
  });

  it("activates Deep Research when all steps succeed", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: { value: { status: "activated" } },
    });
    await expect(
      activateDeepResearch(mockRuntime as never, mockInput as never, mockLogger),
    ).resolves.toBeUndefined();
    expect(mockLogger).toHaveBeenCalledWith("Deep Research mode activated");
  });

  it("returns early when already active", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: { value: { status: "already-active" } },
    });
    await expect(
      activateDeepResearch(mockRuntime as never, mockInput as never, mockLogger),
    ).resolves.toBeUndefined();
    expect(mockLogger).toHaveBeenCalledWith("Deep Research mode already active");
  });

  it("throws when plus button is missing", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: { value: { status: "plus-button-missing" } },
    });
    await expect(
      activateDeepResearch(mockRuntime as never, mockInput as never, mockLogger),
    ).rejects.toThrow(/composer plus button/);
  });

  it("throws with available options when Deep Research item missing", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: {
          status: "dropdown-item-missing",
          available: ["Create image", "Web search"],
        },
      },
    });
    await expect(
      activateDeepResearch(mockRuntime as never, mockInput as never, mockLogger),
    ).rejects.toThrow(/not found.*Create image/);
  });

  it("throws when pill does not confirm", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: { value: { status: "pill-not-confirmed" } },
    });
    await expect(
      activateDeepResearch(mockRuntime as never, mockInput as never, mockLogger),
    ).rejects.toThrow(/pill did not appear/);
  });

  it("falls back to a trusted point click when the menu row ignores synthetic clicks", async () => {
    const dispatchMouseEvent = vi.fn(async () => undefined);
    mockInput = { dispatchMouseEvent };
    mockRuntime.evaluate
      .mockResolvedValueOnce({
        result: { value: { status: "pill-not-confirmed", clickPoint: { x: 12, y: 34 } } },
      })
      .mockResolvedValueOnce({ result: { value: true } });

    await expect(
      activateDeepResearch(mockRuntime as never, mockInput as never, mockLogger),
    ).resolves.toBeUndefined();
    expect(dispatchMouseEvent).toHaveBeenCalledTimes(3);
    expect(dispatchMouseEvent).toHaveBeenCalledWith({
      type: "mousePressed",
      x: 12,
      y: 34,
      button: "left",
      clickCount: 1,
    });
    expect(mockLogger).toHaveBeenCalledWith("Deep Research mode activated");
  });

  it("throws on unexpected result", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: { value: { status: "unknown-status" } },
    });
    await expect(
      activateDeepResearch(mockRuntime as never, mockInput as never, mockLogger),
    ).rejects.toThrow(/Unexpected result/);
  });
});

describe("Deep Research activation expression", () => {
  it("uses the composer tools menu without mutating the queued prompt", () => {
    const expression = buildActivateDeepResearchExpressionForTest();

    expect(expression).not.toContain("/Deepresearch");
    expect(expression).toContain("findDeepResearchItem");
    expect(expression).toContain("findPopoverSearchInput");
    expect(expression).toContain("composer-plus-btn");
    expect(expression).toContain('role="menuitemradio"');
    expect(expression).toContain(".__menu-item");
    expect(expression).toContain("popover");
    expect(expression).toContain("detailed report");
    expect(expression).toContain("text === 'get a detailed report'");
    expect(expression).toContain("text.startsWith('get a detailed report ')");
    expect(expression).toContain('[class*="composer-pill"]');
    expect(expression).toContain("deep research");
    expect(expression).toContain("already-active");
  });
});

describe("isDeepResearchPlaceholderTextForTest", () => {
  it("rejects tool-call stubs as final reports", () => {
    expect(isDeepResearchPlaceholderTextForTest("Called tool")).toBe(true);
    expect(isDeepResearchPlaceholderTextForTest("Użyto narzędzia")).toBe(true);
    expect(isDeepResearchPlaceholderTextForTest("CHECK_DEEP_OK https://example.com")).toBe(false);
  });

  it("rejects Deep Research planning and status captures", () => {
    expect(
      isDeepResearchPlaceholderTextForTest(
        "project root-cause analysis\nUpdate\nInspect the adapter.\nDetermining steps for creating a report...\nStop research",
      ),
    ).toBe(true);
    expect(
      isDeepResearchPlaceholderTextForTest(
        "<system-reminder>\n# Plan Mode - System Reminder\nDo not make edits.\n</system-reminder>",
      ),
    ).toBe(true);
    expect(
      isDeepResearchPlaceholderTextForTest(
        "The final report explains why the Stop research control can remain visible.",
      ),
    ).toBe(false);
    expect(
      isDeepResearchPlaceholderTextForTest(
        "# UI findings\n\nThe control can remain visible after completion:\n\nStop research\n\nThis is the defect.",
      ),
    ).toBe(false);
    expect(
      isDeepResearchPlaceholderTextForTest(
        "# Evidence\n\nThe captured panel ended with:\n\nDetermining steps for creating a report...\nStop research\n\nThat was not a final report.",
      ),
    ).toBe(false);
    expect(
      isDeepResearchPlaceholderTextForTest(
        "# Evidence\n\nThis completed report quotes the two final UI lines.\n\nDetermining steps for creating a report...\nStop research",
      ),
    ).toBe(false);
  });
});

describe("Deep Research iframe helpers", () => {
  it("downgrades incomplete iframe content from completed to in-progress", () => {
    expect(
      filterIncompleteDeepResearchReadForTest({
        completed: true,
        inProgress: false,
        textLength: 120,
        text: "project root-cause analysis\nUpdate\nInspect the adapter.\nDetermining steps for creating a report...\nStop research",
      }),
    ).toMatchObject({ completed: false, inProgress: true });
  });

  it("finds nested Deep Research frames", () => {
    expect(
      findDeepResearchFrameIdForTest({
        frame: { id: "root", url: "https://chatgpt.com/" },
        childFrames: [
          { frame: { id: "other", url: "https://example.com/" } },
          {
            frame: {
              id: "deep",
              url: "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/",
            },
          },
        ],
      }),
    ).toBe("deep");
  });

  it("does not treat an unrelated root iframe as Deep Research", () => {
    expect(
      findDeepResearchFrameIdForTest({
        frame: { id: "other", name: "root", url: "https://example.com/" },
      }),
    ).toBeNull();
  });

  it("confirms target sessions from target metadata or frame-tree evidence", () => {
    expect(
      isConfirmedDeepResearchTargetForTest(
        "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/",
        { frame: { id: "root", name: "root", url: "about:blank" } },
      ),
    ).toBe(true);
    expect(
      isConfirmedDeepResearchTargetForTest("", {
        frame: {
          id: "deep",
          url: "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/",
        },
      }),
    ).toBe(true);
    expect(
      isConfirmedDeepResearchTargetForTest("", {
        frame: { id: "other", name: "root", url: "https://example.com/" },
      }),
    ).toBe(false);
  });

  it("normalizes completed iframe report text", () => {
    const expression = buildDeepResearchFrameStatusExpressionForTest();
    expect(expression).toContain("deep research report");
    expect(expression).toContain("research completed");
    expect(expression).toContain("reportText");
  });

  it("captures the exact submitted Deep Research user record message ID", async () => {
    const conversationId = "WEB:4006dc3c-d3c2-43d1-9391-1b5f51e324ef";
    const messageNode = {
      getAttribute: (name: string) => (name === "data-message-id" ? "user-message-exact" : null),
    };
    const userTurn = {
      getAttribute: (name: string) => (name === "data-message-author-role" ? "user" : null),
      innerText: "Deep research\nTest scientific prompt\nmedical-record.pdf",
      textContent: "Deep research\nTest scientific prompt\nmedical-record.pdf",
      querySelector: () => null,
      querySelectorAll: (selector: string) =>
        selector === "[data-message-id]" ? [messageNode] : [],
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ accessToken: "token" }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          current_node: "user-message-exact",
          mapping: {
            "user-message-exact": {
              parent: null,
              message: {
                id: "user-message-exact",
                author: { role: "user" },
                content: { parts: ["Test scientific prompt"] },
                metadata: {},
              },
            },
          },
        }),
      });
    const result = await new vm.Script(
      buildDeepResearchSubmittedUserTurnExpressionForTest(
        conversationId,
        0,
        "Test scientific prompt",
      ),
    ).runInNewContext({
      AbortController,
      clearTimeout,
      document: { querySelectorAll: () => [userTurn] },
      encodeURIComponent,
      fetch: fetchMock,
      location: {
        protocol: "https:",
        hostname: "chatgpt.com",
        port: "",
        pathname: `/c/${conversationId}`,
      },
      setTimeout,
    });

    expect(result).toEqual({
      conversationId,
      messageId: "user-message-exact",
      turnIndex: 0,
    });
  });

  it("does not misreport an empty Runtime evaluation as a conversation change", async () => {
    const conversationId = "WEB:45519d39-e8cd-4d24-9308-edee27f590f4";
    const runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({
          result: {},
          exceptionDetails: {
            text: "Uncaught",
            exception: { description: "Error: transient evaluation failure" },
          },
        })
        .mockResolvedValueOnce({
          result: {
            value: {
              conversationId,
              messageId: "submitted-user-message",
              turnIndex: 0,
            },
          },
        }),
    } as unknown as Parameters<typeof waitForDeepResearchSubmittedUserTurn>[0];

    await expect(
      waitForDeepResearchSubmittedUserTurn(
        runtime,
        conversationId,
        0,
        "Synthetic research prompt",
        1_000,
      ),
    ).resolves.toEqual({ messageId: "submitted-user-message", turnIndex: 0 });
  });

  it("reports the exact expected and observed IDs for a real conversation change", async () => {
    const expectedConversationId = "WEB:45519d39-e8cd-4d24-9308-edee27f590f4";
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            conversationId: "WEB:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            changed: true,
          },
        },
      }),
    } as unknown as Parameters<typeof waitForDeepResearchSubmittedUserTurn>[0];

    await expect(
      waitForDeepResearchSubmittedUserTurn(
        runtime,
        expectedConversationId,
        0,
        "Synthetic research prompt",
        1_000,
      ),
    ).rejects.toMatchObject({
      details: {
        code: "deep-research-conversation-changed",
        expectedConversationId,
        observedConversationId: "WEB:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      },
    });
  });

  it("binds the submitted prompt when an internal user-like record follows it", async () => {
    const messageNode = {
      getAttribute: (name: string) => (name === "data-message-id" ? "submitted-prompt" : null),
    };
    const userTurn = {
      getAttribute: (name: string) => (name === "data-message-author-role" ? "user" : null),
      innerText: "Deep research\nTest scientific prompt",
      textContent: "Deep research\nTest scientific prompt",
      querySelector: () => null,
      querySelectorAll: (selector: string) =>
        selector === "[data-message-id]" ? [messageNode] : [],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ accessToken: "token" }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          current_node: "deep-research-internal-user",
          mapping: {
            "submitted-prompt": {
              parent: null,
              message: {
                id: "submitted-prompt",
                author: { role: "user" },
                content: { parts: ["Test scientific prompt"] },
                metadata: {},
              },
            },
            "deep-research-internal-user": {
              parent: "submitted-prompt",
              message: {
                id: "deep-research-internal-user",
                author: { role: "user" },
                content: { parts: ["Internal research orchestration state"] },
                metadata: { is_visually_hidden_from_conversation: true },
              },
            },
          },
        }),
      });

    const result = await new vm.Script(
      buildDeepResearchSubmittedUserTurnExpressionForTest(
        "conversation-id",
        0,
        "Test scientific prompt",
      ),
    ).runInNewContext({
      AbortController,
      clearTimeout,
      document: { querySelectorAll: () => [userTurn] },
      encodeURIComponent,
      fetch: fetchMock,
      location: {
        protocol: "https:",
        hostname: "chatgpt.com",
        port: "",
        pathname: "/c/conversation-id",
      },
      setTimeout,
    });

    expect(result).toEqual({
      conversationId: "conversation-id",
      messageId: "submitted-prompt",
      turnIndex: 0,
    });
  });

  it("fails closed when more than one active-branch user record matches the prompt", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ accessToken: "token" }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          current_node: "duplicate-prompt",
          mapping: {
            "submitted-prompt": {
              parent: null,
              message: {
                id: "submitted-prompt",
                author: { role: "user" },
                content: { parts: ["Test scientific prompt"] },
              },
            },
            "duplicate-prompt": {
              parent: "submitted-prompt",
              message: {
                id: "duplicate-prompt",
                author: { role: "user" },
                content: { parts: ["Test scientific prompt"] },
              },
            },
          },
        }),
      });

    const result = await new vm.Script(
      buildDeepResearchSubmittedUserTurnExpressionForTest(
        "conversation-id",
        0,
        "Test scientific prompt",
      ),
    ).runInNewContext({
      AbortController,
      clearTimeout,
      document: { querySelectorAll: () => [] },
      encodeURIComponent,
      fetch: fetchMock,
      location: {
        protocol: "https:",
        hostname: "chatgpt.com",
        port: "",
        pathname: "/c/conversation-id",
      },
      setTimeout,
    });

    expect(result).toMatchObject({
      conversationId: "conversation-id",
      unavailable: true,
      reason: "conversation-user-ambiguous",
      branchUserCount: 2,
      branchPromptMatchCount: 2,
    });
    expect(result).not.toHaveProperty("messageId");
  });

  it("uses one exact post-boundary DOM ID to disambiguate repeated prompt records", async () => {
    const exactIdNode = {
      getAttribute: (name: string) => (name === "data-message-id" ? "second-prompt" : null),
    };
    const exactTurn = {
      getAttribute: (name: string) => (name === "data-message-author-role" ? "user" : null),
      innerText: "Test scientific prompt",
      textContent: "Test scientific prompt",
      querySelector: () => null,
      querySelectorAll: (selector: string) =>
        selector === "[data-message-id]" ? [exactIdNode] : [],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ accessToken: "token" }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          current_node: "second-prompt",
          mapping: {
            "first-prompt": {
              parent: null,
              message: {
                id: "first-prompt",
                author: { role: "user" },
                content: { parts: ["Test scientific prompt"] },
              },
            },
            "second-prompt": {
              parent: "first-prompt",
              message: {
                id: "second-prompt",
                author: { role: "user" },
                content: { parts: ["Test scientific prompt"] },
              },
            },
          },
        }),
      });

    const result = await new vm.Script(
      buildDeepResearchSubmittedUserTurnExpressionForTest(
        "conversation-id",
        0,
        "Test scientific prompt",
      ),
    ).runInNewContext({
      AbortController,
      clearTimeout,
      document: { querySelectorAll: () => [exactTurn] },
      encodeURIComponent,
      fetch: fetchMock,
      location: {
        protocol: "https:",
        hostname: "chatgpt.com",
        port: "",
        pathname: "/c/conversation-id",
      },
      setTimeout,
    });

    expect(result).toEqual({
      conversationId: "conversation-id",
      messageId: "second-prompt",
      turnIndex: 0,
    });
  });

  it("rejects a sole unrelated post-boundary DOM user instead of accepting it by position", async () => {
    const unrelatedTurn = {
      getAttribute: (name: string) => (name === "data-message-author-role" ? "user" : null),
      innerText: "Internal research orchestration state",
      textContent: "Internal research orchestration state",
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ accessToken: "token" }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          current_node: "submitted-prompt",
          mapping: {
            "submitted-prompt": {
              parent: null,
              message: {
                id: "submitted-prompt",
                author: { role: "user" },
                content: { parts: ["Test scientific prompt"] },
              },
            },
          },
        }),
      });

    const result = await new vm.Script(
      buildDeepResearchSubmittedUserTurnExpressionForTest(
        "conversation-id",
        0,
        "Test scientific prompt",
      ),
    ).runInNewContext({
      AbortController,
      clearTimeout,
      document: { querySelectorAll: () => [unrelatedTurn] },
      encodeURIComponent,
      fetch: fetchMock,
      location: {
        protocol: "https:",
        hostname: "chatgpt.com",
        port: "",
        pathname: "/c/conversation-id",
      },
      setTimeout,
    });

    expect(result).toMatchObject({
      unavailable: true,
      reason: "dom-user-turn-unmatched",
      domUserCount: 1,
      exactDomMatchCount: 0,
      promptDomMatchCount: 0,
    });
    expect(result).not.toHaveProperty("messageId");
  });

  it("rejects duplicate DOM exposure of the authenticated prompt ID", async () => {
    const exactIdNode = {
      getAttribute: (name: string) => (name === "data-message-id" ? "submitted-prompt" : null),
    };
    const exactTurn = {
      getAttribute: (name: string) => (name === "data-message-author-role" ? "user" : null),
      innerText: "Test scientific prompt",
      textContent: "Test scientific prompt",
      querySelector: () => null,
      querySelectorAll: (selector: string) =>
        selector === "[data-message-id]" ? [exactIdNode] : [],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ accessToken: "token" }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          current_node: "submitted-prompt",
          mapping: {
            "submitted-prompt": {
              parent: null,
              message: {
                id: "submitted-prompt",
                author: { role: "user" },
                content: { parts: ["Test scientific prompt"] },
              },
            },
          },
        }),
      });

    const result = await new vm.Script(
      buildDeepResearchSubmittedUserTurnExpressionForTest(
        "conversation-id",
        0,
        "Test scientific prompt",
      ),
    ).runInNewContext({
      AbortController,
      clearTimeout,
      document: { querySelectorAll: () => [exactTurn, exactTurn] },
      encodeURIComponent,
      fetch: fetchMock,
      location: {
        protocol: "https:",
        hostname: "chatgpt.com",
        port: "",
        pathname: "/c/conversation-id",
      },
      setTimeout,
    });

    expect(result).toMatchObject({
      unavailable: true,
      reason: "dom-user-turn-ambiguous",
      exactDomMatchCount: 2,
    });
    expect(result).not.toHaveProperty("messageId");
  });

  it("uses the pre-submit turn boundary while the exact user DOM is still unhydrated", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ accessToken: "token" }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          current_node: "user-message-exact",
          mapping: {
            "user-message-exact": {
              parent: null,
              message: {
                id: "user-message-exact",
                author: { role: "user" },
                content: { parts: ["Test scientific prompt"] },
                metadata: {},
              },
            },
          },
        }),
      });

    const result = await new vm.Script(
      buildDeepResearchSubmittedUserTurnExpressionForTest(
        "conversation-id",
        4,
        "Test scientific prompt",
      ),
    ).runInNewContext({
      AbortController,
      clearTimeout,
      document: { querySelectorAll: () => [] },
      encodeURIComponent,
      fetch: fetchMock,
      location: {
        protocol: "https:",
        hostname: "chatgpt.com",
        port: "",
        pathname: "/c/conversation-id",
      },
      setTimeout,
    });

    expect(result).toEqual({
      conversationId: "conversation-id",
      messageId: "user-message-exact",
      turnIndex: 4,
    });
  });

  it("does not use record-only prompt evidence for a resumed conversation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ accessToken: "token" }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          current_node: "historical-user-message",
          mapping: {
            "historical-user-message": {
              parent: null,
              message: {
                id: "historical-user-message",
                author: { role: "user" },
                content: { parts: ["Test scientific prompt"] },
              },
            },
          },
        }),
      });

    const result = await new vm.Script(
      buildDeepResearchSubmittedUserTurnExpressionForTest(
        "conversation-id",
        4,
        "Test scientific prompt",
        false,
        true,
      ),
    ).runInNewContext({
      AbortController,
      clearTimeout,
      document: { querySelectorAll: () => [] },
      encodeURIComponent,
      fetch: fetchMock,
      location: {
        protocol: "https:",
        hostname: "chatgpt.com",
        port: "",
        pathname: "/c/conversation-id",
      },
      setTimeout,
    });

    expect(result).toMatchObject({
      conversationId: "conversation-id",
      unavailable: true,
      reason: "dom-user-turn-unhydrated",
      domUserCount: 0,
    });
    expect(result).not.toHaveProperty("messageId");
  });

  it("does not bind a historical record ID from text-only DOM evidence on resume", async () => {
    const textOnlyTurn = {
      getAttribute: (name: string) => (name === "data-message-author-role" ? "user" : null),
      innerText: "Test scientific prompt",
      textContent: "Test scientific prompt",
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ accessToken: "token" }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          current_node: "historical-user-message",
          mapping: {
            "historical-user-message": {
              parent: null,
              message: {
                id: "historical-user-message",
                author: { role: "user" },
                content: { parts: ["Test scientific prompt"] },
              },
            },
          },
        }),
      });

    const result = await new vm.Script(
      buildDeepResearchSubmittedUserTurnExpressionForTest(
        "conversation-id",
        0,
        "Test scientific prompt",
        false,
        true,
      ),
    ).runInNewContext({
      AbortController,
      clearTimeout,
      document: { querySelectorAll: () => [textOnlyTurn] },
      encodeURIComponent,
      fetch: fetchMock,
      location: {
        protocol: "https:",
        hostname: "chatgpt.com",
        port: "",
        pathname: "/c/conversation-id",
      },
      setTimeout,
    });

    expect(result).toMatchObject({
      conversationId: "conversation-id",
      unavailable: true,
      reason: "dom-user-turn-unmatched",
      domUserCount: 1,
      promptDomMatchCount: 1,
    });
    expect(result).not.toHaveProperty("messageId");
  });

  it("captures completed localized reports without the English report heading", () => {
    const expression = buildDeepResearchFrameStatusExpressionForTest();
    const result = new vm.Script(expression).runInNewContext({
      document: {
        body: {
          innerText:
            "Research completed in 44m ·\n" +
            "19\n" +
            "citations ·\n" +
            "328\n" +
            "searches\n" +
            "Audyt możliwości eksportu danych z profilu Steam\n" +
            "Audyt możliwości eksportu danych z profilu Steam\n" +
            "Data audytu: 2026-05-02\n" +
            "Ten raport opisuje dostępne ścieżki eksportu danych profilu Steam.",
          innerHTML: "<article>Audyt możliwości eksportu danych z profilu Steam</article>",
        },
      },
    }) as {
      completed?: boolean;
      text?: string;
      textLength?: number;
      declaredCitationCount?: number;
    };

    expect(result.completed).toBe(true);
    expect(result.text).toContain("Audyt możliwości eksportu danych z profilu Steam");
    expect(result.text?.match(/Audyt możliwości eksportu danych/g)).toHaveLength(1);
    expect(result.text).not.toContain("Research completed");
    expect(result.text).not.toContain("citations");
    expect(result.text).not.toContain("searches");
    expect(result.textLength).toBeGreaterThan(40);
    expect(result.declaredCitationCount).toBe(19);
  });

  it("records an explicit zero-citation UI counter as affirmative evidence", () => {
    const result = new vm.Script(buildDeepResearchFrameStatusExpressionForTest()).runInNewContext({
      document: {
        body: {
          innerText:
            "Research completed in 1m\n" +
            "0 citations\n" +
            "Deep Research report\n" +
            "This attachment-only report contains enough substantive text to be complete.",
        },
      },
    }) as { completed?: boolean; declaredCitationCount?: number };

    expect(result.completed).toBe(true);
    expect(result.declaredCitationCount).toBe(0);
  });

  it("serializes citation-bearing iframe DOM to safe Markdown", () => {
    const primaryLink = testElement("a", [testText("Primary study")], {
      href: "https://example.com/source?trial=1",
    });
    const relativeLink = testElement("a", [testText("Supporting dataset")], {
      href: "/dataset",
    });
    const unsafeLink = testElement("a", [testText("Unsafe label")], {
      href: "javascript:alert(1)",
    });
    const article = testElement("article", [
      testElement("h2", [testText("Evidence summary")]),
      testElement("p", [
        testText("The primary finding is supported by "),
        primaryLink,
        testElement("sup", [testText("1")], {
          "data-citation-interactive": "true",
          "data-citation-index": "1",
        }),
        testText(" and "),
        relativeLink,
        testText(". "),
        unsafeLink,
        testText(" remains readable without an executable destination."),
      ]),
      testElement("ul", [
        testElement("li", [testText("First reproducible result")]),
        testElement("li", [testText("Second reproducible result")]),
      ]),
      testElement("script", [testText("stealCredentials()")]),
      testElement("button", [testText("Hidden interface control")]),
    ]);
    article.innerText =
      "Evidence summary The primary finding is supported by Primary study and Supporting dataset. " +
      "Unsafe label remains readable without an executable destination. First reproducible result " +
      "Second reproducible result";
    const body = testElement("body", [article]);
    body.innerText =
      "Research completed in 2m\n2 citations\nDeep Research report\n" + article.innerText;

    const result = new vm.Script(buildDeepResearchFrameStatusExpressionForTest()).runInNewContext({
      URL,
      document: {
        baseURI: "https://research.example.org/reports/current",
        body,
        querySelectorAll: () => [article],
      },
    }) as {
      completed?: boolean;
      text?: string;
      citationMarkerNonce?: string;
      citationRootComparable?: string;
      citationReportNeedle?: string;
      declaredCitationCount?: number;
    };

    expect(result.completed).toBe(true);
    expect(result.text).toContain("## Evidence summary");
    expect(result.text).toContain("[Primary study](<https://example.com/source?trial=1>)");
    expect(result.citationMarkerNonce).toMatch(/^[a-f0-9]{32}$/);
    expect(result.citationRootComparable?.length).toBeGreaterThan(40);
    expect(result.citationReportNeedle).toBeTruthy();
    expect(result.declaredCitationCount).toBe(2);
    expect(result.text).toContain(
      `[[ORACLE_DEEP_RESEARCH_CITATION_${result.citationMarkerNonce}_1]]`,
    );
    expect(result.text).toContain("[Supporting dataset](<https://research.example.org/dataset>)");
    expect(result.text).toContain("Unsafe label");
    expect(result.text).not.toContain("javascript:");
    expect(result.text).not.toContain("stealCredentials");
    expect(result.text).not.toContain("Hidden interface control");
    expect(result.text).toContain("- First reproducible result");
    expect(result.text).not.toContain("Research completed");
  });

  it("filters rendered Mermaid style and SVG descendants from preformatted blocks", () => {
    const article = testElement("article", [
      testElement("h2", [testText("Reproducible method")]),
      testElement("p", [testText("The ordinary code remains available for review.")]),
      testElement("pre", [
        testElement("code", [
          testText("print('ok')\n"),
          testElement("style", [testText("#mermaid-live{fill:red}@keyframes dash{to{}}")]),
          testElement("svg", [testText("Rendered diagram accessibility payload")]),
        ]),
      ]),
    ]);
    article.innerText =
      "Reproducible method The ordinary code remains available for review. print('ok')";
    const body = testElement("body", [article]);
    body.innerText = `Research completed\nDeep Research report\n${article.innerText}`;

    const result = new vm.Script(buildDeepResearchFrameStatusExpressionForTest()).runInNewContext({
      URL,
      document: {
        baseURI: "https://research.example.org/report",
        body,
        querySelectorAll: () => [article],
      },
    }) as { completed?: boolean; text?: string };

    expect(result.completed).toBe(true);
    expect(result.text).toContain("print('ok')");
    expect(result.text).not.toContain("#mermaid-live");
    expect(result.text).not.toContain("@keyframes");
    expect(result.text).not.toContain("Rendered diagram accessibility payload");
  });

  it("does not fall back to raw text when structured content is only a rendered diagram", () => {
    const mermaidPayload = `#mermaid-live{${"fill:red;".repeat(20)}}@keyframes dash{to{}}`;
    const article = testElement("article", [
      testElement("pre", [
        testElement("code", [
          testElement("style", [testText(mermaidPayload)]),
          testElement("svg", [testText("Rendered diagram payload")]),
        ]),
      ]),
    ]);
    article.innerText = mermaidPayload;
    const body = testElement("body", [article]);
    body.innerText = `Research completed\nDeep Research report\n${mermaidPayload}`;

    const result = new vm.Script(buildDeepResearchFrameStatusExpressionForTest()).runInNewContext({
      URL,
      document: {
        baseURI: "https://research.example.org/report",
        body,
        querySelectorAll: () => [article],
      },
    }) as { completed?: boolean; text?: string };

    expect(result.completed).toBe(false);
    expect(result.text).toBeUndefined();
  });

  it("does not rewrite literal marker-like code when linking a real citation", () => {
    const literalMarker = "[[ORACLE_DEEP_RESEARCH_CITATION_1]]";
    const article = testElement("article", [
      testElement("h2", [testText("Collision safety")]),
      testElement("p", [
        testText("Literal example: "),
        testElement("code", [testText(literalMarker)]),
        testText(". Actual evidence"),
        testElement("sup", [testText("1")], {
          "data-citation-interactive": "true",
          "data-citation-index": "1",
        }),
        testText(" supports the finding."),
      ]),
    ]);
    article.innerText = `Collision safety Literal example: ${literalMarker}. Actual evidence supports the finding.`;
    const body = testElement("body", [article]);
    body.innerText = `Research completed\nDeep Research report\n${article.innerText}`;

    const serialized = new vm.Script(
      buildDeepResearchFrameStatusExpressionForTest(),
    ).runInNewContext({
      URL,
      document: {
        baseURI: "https://research.example.org/report",
        body,
        querySelectorAll: () => [article],
      },
    }) as { text: string; citationMarkerNonce: string };
    const applied = applyDeepResearchCitationSourcesForTest(
      serialized.text,
      [{ index: 1, url: "https://example.com/actual" }],
      {
        citationMarkerNonce: serialized.citationMarkerNonce,
        observedIndexes: [1],
      },
    );

    expect(applied.markdown).toContain(literalMarker);
    expect(applied.markdown).toContain("Actual evidence[1](<https://example.com/actual>)");
    expect(applied.markdown).not.toContain(
      `ORACLE_DEEP_RESEARCH_CITATION_${serialized.citationMarkerNonce}`,
    );
    expect(applied.status).toEqual({ total: 1, linked: 1, missingIndexes: [] });
  });

  it("extracts an exact citation URL only from the matching main-world React item", () => {
    const exactChip = {
      getAttribute: (name: string) => (name === "data-citation-index" ? "3" : null),
      __reactFiber$oracle: {
        return: {
          return: {
            memoizedProps: {
              item: {
                index: 3,
                url: "https://ntrs.nasa.gov/citations/20220016184",
                reference: {
                  items: [
                    {
                      title: "NASA technical report",
                      url: "https://ntrs.nasa.gov/citations/20220016184",
                    },
                  ],
                  safe_urls: ["https://unselected.example/supporting"],
                },
              },
            },
          },
        },
      },
    };
    const mismatchedChip = {
      getAttribute: (name: string) => (name === "data-citation-index" ? "4" : null),
      __reactFiber$oracle: {
        memoizedProps: {
          item: { index: 99, url: "https://example.com/wrong-index" },
        },
      },
    };

    const result = new vm.Script(
      buildDeepResearchCitationSourcesExpressionForTest(),
    ).runInNewContext({
      URL,
      document: { querySelectorAll: () => [exactChip, mismatchedChip] },
      location: { href: "https://connector.example/report" },
    });

    expect(result).toEqual({
      observedIndexes: [3, 4],
      sources: [
        {
          index: 3,
          url: "https://ntrs.nasa.gov/citations/20220016184",
          label: "NASA technical report",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("unselected.example");
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("scopes citation URL extraction to the exact serialized report root", () => {
    const chip = (url: string) => ({
      getAttribute: (name: string) => (name === "data-citation-index" ? "1" : null),
      __reactFiber$oracle: { memoizedProps: { item: { index: 1, url } } },
    });
    const staleChip = chip("https://example.com/stale") as ReturnType<typeof chip> & {
      parentElement?: unknown;
    };
    const currentChip = chip("https://example.com/current") as ReturnType<typeof chip> & {
      parentElement?: unknown;
    };
    const staleRoot = {
      innerText: "stale hidden report content",
      textContent: "stale hidden report content",
      querySelectorAll: () => [staleChip],
    };
    const currentText = "current verified report content";
    const currentRoot = {
      innerText: currentText,
      textContent: currentText,
      querySelectorAll: () => [currentChip],
    };
    staleChip.parentElement = staleRoot;
    currentChip.parentElement = currentRoot;
    const normalizedCurrentText = currentText.toLowerCase();

    const result = new vm.Script(
      buildDeepResearchCitationSourcesExpressionForTest({
        rootComparable: normalizedCurrentText,
        reportNeedle: normalizedCurrentText.slice(0, 120),
      }),
    ).runInNewContext({
      URL,
      document: {
        body: staleRoot,
        querySelectorAll: (selector: string) =>
          selector === 'article, main, [role="main"]' ? [staleRoot, currentRoot] : [],
      },
      location: { href: "https://connector.example/report" },
    });

    expect(result).toEqual({
      observedIndexes: [1],
      sources: [{ index: 1, url: "https://example.com/current" }],
    });
  });

  it("ignores an exact stale report root hidden only by an ancestor", () => {
    const shared = `Verified report opening ${"x".repeat(140)}`;
    const staleText = `${shared} STALE-HIDDEN-SENTINEL`;
    const currentText = `${shared} CURRENT-ONLY-SENTINEL with additional verified detail`;
    type ParentNode = TestDomNode & { parentElement: TestDomNode | null };
    type CitationNode = ParentNode & { __reactFiber$oracle: unknown };

    const staleChip = testElement("sup", [testText("1")], {
      "data-citation-interactive": "true",
      "data-citation-index": "1",
    }) as CitationNode;
    staleChip.__reactFiber$oracle = {
      memoizedProps: { item: { index: 1, url: "https://stale.example/wrong" } },
    };
    const currentChip = testElement("sup", [testText("1")], {
      "data-citation-interactive": "true",
      "data-citation-index": "1",
    }) as CitationNode;
    currentChip.__reactFiber$oracle = {
      memoizedProps: { item: { index: 1, url: "https://current.example/right" } },
    };

    const staleRoot = testElement("article", [testElement("p", [testText(staleText), staleChip])]);
    staleRoot.innerText = staleText;
    staleRoot.querySelectorAll = () => [staleChip];
    const currentRoot = testElement("article", [
      testElement("p", [testText(currentText), currentChip]),
    ]);
    currentRoot.innerText = currentText;
    currentRoot.querySelectorAll = () => [currentChip];
    const hiddenAncestor = testElement("section", [staleRoot], {
      style: "display: none",
    });
    const body = testElement("body", [hiddenAncestor, currentRoot]);
    body.innerText = `Research completed\nDeep Research report\n${currentText}`;

    (body as ParentNode).parentElement = null;
    (hiddenAncestor as ParentNode).parentElement = body;
    (staleRoot as ParentNode).parentElement = hiddenAncestor;
    staleChip.parentElement = staleRoot;
    (currentRoot as ParentNode).parentElement = body;
    currentChip.parentElement = currentRoot;

    const document = {
      baseURI: "https://research.example/report",
      body,
      querySelectorAll: () => [staleRoot, currentRoot],
    };
    const serialized = new vm.Script(
      buildDeepResearchFrameStatusExpressionForTest(),
    ).runInNewContext({ URL, document }) as {
      text?: string;
      citationRootComparable?: string;
      citationReportNeedle?: string;
    };

    expect(serialized.text).toContain("CURRENT-ONLY-SENTINEL");
    expect(serialized.text).not.toContain("STALE-HIDDEN-SENTINEL");

    const citationScan = new vm.Script(
      buildDeepResearchCitationSourcesExpressionForTest({
        rootComparable: serialized.citationRootComparable,
        reportNeedle: serialized.citationReportNeedle,
      }),
    ).runInNewContext({
      URL,
      document,
      location: { href: "https://research.example/report" },
    });

    expect(citationScan).toEqual({
      observedIndexes: [1],
      sources: [{ index: 1, url: "https://current.example/right" }],
    });
  });

  it("does not use a hidden stale chip to supply a visible citation URL", () => {
    const currentText = "current verified report content";
    const visibleChip = {
      parentElement: null as unknown,
      getAttribute: (name: string) => (name === "data-citation-index" ? "1" : null),
    };
    const hiddenChip = {
      parentElement: null as unknown,
      getAttribute: (name: string) => {
        if (name === "data-citation-index") return "1";
        if (name === "hidden") return "";
        return null;
      },
      __reactFiber$oracle: {
        memoizedProps: { item: { index: 1, url: "https://stale.example/wrong" } },
      },
    };
    const currentRoot = {
      innerText: currentText,
      textContent: currentText,
      querySelectorAll: () => [visibleChip, hiddenChip],
    };
    visibleChip.parentElement = currentRoot;
    hiddenChip.parentElement = currentRoot;

    const result = new vm.Script(
      buildDeepResearchCitationSourcesExpressionForTest({
        rootComparable: currentText,
        reportNeedle: currentText,
      }),
    ).runInNewContext({
      URL,
      document: {
        body: currentRoot,
        querySelectorAll: () => [currentRoot],
      },
      location: { href: "https://connector.example/report" },
    });

    expect(result).toEqual({ observedIndexes: [1], sources: [] });
  });

  it("rejects citation metadata when the report tail changed at the same length", () => {
    const prefix = "p".repeat(180);
    const serializedText = `${prefix}x`;
    const mutatedText = `${prefix}y`;
    const mutatedRoot = {
      innerText: mutatedText,
      textContent: mutatedText,
      querySelectorAll: () => [],
    };

    const result = new vm.Script(
      buildDeepResearchCitationSourcesExpressionForTest({
        rootComparable: serializedText,
        reportNeedle: prefix.slice(0, 120),
      }),
    ).runInNewContext({
      URL,
      document: {
        body: mutatedRoot,
        querySelectorAll: () => [mutatedRoot],
      },
      location: { href: "https://connector.example/report" },
    });

    expect(result).toBeNull();
  });

  it("rejects a completed reread when an exact citation URL changes", () => {
    const shared = {
      completed: true,
      inProgress: false,
      textLength: 120,
      contentSha256: "a".repeat(64),
      citationStatus: { total: 1, linked: 1, missingIndexes: [] },
    };
    const first = { ...shared, text: "Claim[1](<https://example.com/first>)" };
    const same = { ...shared, text: first.text };
    const changed = { ...shared, text: "Claim[1](<https://example.com/second>)" };

    expect(hasStableCompletedDeepResearchReadForTest(first, same)).toBe(true);
    expect(hasStableCompletedDeepResearchReadForTest(first, changed)).toBe(false);
  });

  it("preserves a citation URL beyond the label limit and reports chips whose URL is unavailable", () => {
    const longUrl = `https://example.com/source?payload=${"x".repeat(900)}`;
    const exactChip = {
      getAttribute: (name: string) => (name === "data-citation-index" ? "7" : null),
      __reactFiber$oracle: {
        memoizedProps: {
          item: { index: 7, url: longUrl, attribution: "L".repeat(700) },
        },
      },
    };
    const unavailableChip = {
      getAttribute: (name: string) => (name === "data-citation-index" ? "8" : null),
    };

    const result = new vm.Script(
      buildDeepResearchCitationSourcesExpressionForTest(),
    ).runInNewContext({
      URL,
      document: { querySelectorAll: () => [exactChip, unavailableChip] },
      location: { href: "https://connector.example/report" },
    });

    expect(result).toEqual({
      observedIndexes: [7, 8],
      sources: [{ index: 7, url: longUrl, label: "L".repeat(500) }],
    });
    expect(result.sources[0].url).toHaveLength(longUrl.length);
  });

  it("leaves a citation unlinked when same-index React items disagree on the URL", () => {
    const ambiguousChip = {
      getAttribute: (name: string) => (name === "data-citation-index" ? "5" : null),
      __reactFiber$oracle: {
        memoizedProps: {
          item: { index: 5, url: "https://example.com/first" },
        },
        return: {
          memoizedProps: {
            item: { index: 5, url: "https://example.com/second" },
          },
        },
      },
    };

    const scan = new vm.Script(buildDeepResearchCitationSourcesExpressionForTest()).runInNewContext(
      {
        URL,
        document: { querySelectorAll: () => [ambiguousChip] },
        location: { href: "https://connector.example/report" },
      },
    );
    expect(scan).toEqual({ observedIndexes: [5], sources: [] });

    const applied = applyDeepResearchCitationSourcesForTest(
      `Claim[[ORACLE_DEEP_RESEARCH_CITATION_${TEST_CITATION_NONCE}_5]]`,
      scan.sources,
      {
        citationMarkerNonce: TEST_CITATION_NONCE,
        observedIndexes: scan.observedIndexes,
      },
    );
    expect(applied).toEqual({
      markdown: "Claim[5]",
      status: { total: 1, linked: 0, missingIndexes: [5] },
    });
  });

  it("trims before enforcing the 4096-character citation URL limit", () => {
    const withinLimit = `https://example.com/${"a".repeat(4075)}`;
    const normalized = normalizeDeepResearchCitationSourcesForTest({
      observedIndexes: [1, 2],
      sources: [
        { index: 1, url: `  ${withinLimit}  ` },
        { index: 2, url: `https://example.com/${"b".repeat(4090)}` },
      ],
    });

    expect(withinLimit.length).toBeLessThanOrEqual(4096);
    expect(normalized).toEqual({
      observedIndexes: [1, 2],
      sources: [{ index: 1, url: withinLimit }],
    });
  });

  it("links exact citation markers and leaves missing or contradictory indexes unguessed", () => {
    const result = applyDeepResearchCitationSourcesForTest(
      `Finding[[ORACLE_DEEP_RESEARCH_CITATION_${TEST_CITATION_NONCE}_1]] and ` +
        `repeat[[ORACLE_DEEP_RESEARCH_CITATION_${TEST_CITATION_NONCE}_1]]. ` +
        `Missing[[ORACLE_DEEP_RESEARCH_CITATION_${TEST_CITATION_NONCE}_2]] ` +
        `conflict[[ORACLE_DEEP_RESEARCH_CITATION_${TEST_CITATION_NONCE}_3]].`,
      [
        { index: 1, url: "https://example.com/one" },
        { index: 3, url: "https://example.com/three-a" },
        { index: 3, url: "https://example.com/three-b" },
      ],
      {
        citationMarkerNonce: TEST_CITATION_NONCE,
        observedIndexes: [1, 2, 3],
      },
    );

    expect(result.markdown).toContain("Finding[1](<https://example.com/one>)");
    expect(result.markdown).toContain("repeat[1](<https://example.com/one>)");
    expect(result.markdown).toContain("Missing[2]");
    expect(result.markdown).toContain("conflict[3]");
    expect(result.markdown).not.toContain("ORACLE_DEEP_RESEARCH_CITATION");
    expect(result.status).toEqual({ total: 3, linked: 1, missingIndexes: [2, 3] });
  });

  it("reports a successful zero-citation scan explicitly", () => {
    expect(applyDeepResearchCitationSourcesForTest("No citations in this report.", [])).toEqual({
      markdown: "No citations in this report.",
      status: { total: 0, linked: 0, missingIndexes: [] },
    });
  });

  it("requires affirmative citation UI evidence before certifying an empty scan", () => {
    const emptyScan = { observedIndexes: [], sources: [] };

    expect(hasVerifiedDeepResearchCitationUiContractForTest(emptyScan, undefined)).toBe(false);
    expect(hasVerifiedDeepResearchCitationUiContractForTest(emptyScan, 0)).toBe(true);
    expect(
      hasVerifiedDeepResearchCitationUiContractForTest(
        { observedIndexes: [1], sources: [] },
        undefined,
      ),
    ).toBe(true);
  });

  it("does not report a clean zero scan when the UI declared citations", () => {
    expect(
      applyDeepResearchCitationSourcesForTest("Report body with citation selector drift.", [], {
        declaredCitationCount: 2,
      }),
    ).toEqual({
      markdown: "Report body with citation selector drift.",
      status: { total: 2, linked: 0, missingIndexes: [1, 2] },
    });
  });

  it("distinguishes an unavailable citation scan from a successful zero-citation scan", () => {
    expect(
      applyDeepResearchCitationSourcesForTest("Report text.", [], { scanAvailable: false }),
    ).toEqual({ markdown: "Report text." });
  });

  it("reads only allowlisted Deep Research metadata from the bound conversation branch", async () => {
    const ownerMessageId = "owner-message";
    const token = "sensitive-browser-token";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ accessToken: token }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          current_node: "final-message",
          mapping: {
            "user-message": {
              parent: null,
              message: {
                id: "user-message",
                author: { role: "user" },
                metadata: { deep_research_version: "standard", private_prompt: "do not return" },
              },
            },
            [ownerMessageId]: {
              parent: "user-message",
              message: {
                id: ownerMessageId,
                author: { role: "assistant" },
                content: { content_type: "code", parts: ["private report body"] },
                metadata: {
                  model_slug: "gpt-5-5-instant",
                  resolved_model_slug: "gpt-5-5-instant",
                  default_model_slug: "gpt-5-6-pro",
                  private_field: "do not return",
                },
              },
            },
            "final-message": {
              parent: ownerMessageId,
              message: {
                id: "final-message",
                author: { role: "assistant" },
                end_turn: true,
                content: { content_type: "text", parts: ["Research completed"] },
                metadata: { model_slug: "unrelated-final-model" },
              },
            },
          },
        }),
      });

    const result = (await new vm.Script(
      buildDeepResearchConversationRecordMetadataExpressionForTest(ownerMessageId, 1_000),
    ).runInNewContext({
      AbortController,
      clearTimeout,
      encodeURIComponent,
      fetch: fetchMock,
      location: {
        protocol: "https:",
        hostname: "chatgpt.com",
        port: "",
        pathname: "/c/conversation-id",
      },
      setTimeout,
    })) as Record<string, unknown>;

    expect(result).toEqual({
      messageId: ownerMessageId,
      finalMessageId: "final-message",
      modelSlug: "gpt-5-5-instant",
      resolvedModelSlug: "gpt-5-5-instant",
      defaultModelSlug: "gpt-5-6-pro",
      deepResearchVersion: "standard",
      metadataSource: "chatgpt-conversation-record",
    });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain("private report body");
    expect(JSON.stringify(result)).not.toContain("do not return");
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/backend-api/conversation/conversation-id",
      expect.objectContaining({
        credentials: "same-origin",
        headers: { authorization: `Bearer ${token}` },
      }),
    );
  });

  it("backs off and retries a rate-limited conversation-record lookup", async () => {
    const scheduledDelays: number[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ accessToken: "token" }) })
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: (name: string) => (name.toLowerCase() === "retry-after" ? "0" : null) },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          current_node: "final-message",
          mapping: {
            "user-message": {
              parent: null,
              message: {
                id: "user-message",
                author: { role: "user" },
                metadata: { deep_research_version: "standard", request_id: "request-1" },
              },
            },
            "owner-message": {
              parent: "user-message",
              message: {
                id: "owner-message",
                author: { role: "assistant" },
                recipient: "api_tool.call_tool",
                end_turn: false,
                metadata: { model_slug: "gpt-5-5-instant", request_id: "request-1" },
              },
            },
            "final-message": {
              parent: "owner-message",
              message: {
                id: "final-message",
                author: { role: "assistant" },
                end_turn: true,
                metadata: { request_id: "request-1" },
              },
            },
          },
        }),
      });

    const result = await new vm.Script(
      buildDeepResearchConversationRecordMetadataExpressionForTest("owner-message", 10_000),
    ).runInNewContext({
      AbortController,
      clearTimeout: () => undefined,
      encodeURIComponent,
      fetch: fetchMock,
      location: {
        protocol: "https:",
        hostname: "chatgpt.com",
        port: "",
        pathname: "/c/conversation-id",
      },
      setTimeout: (callback: () => void, delayMs: number) => {
        scheduledDelays.push(delayMs);
        queueMicrotask(callback);
        return 1;
      },
    });

    expect(result).toMatchObject({
      messageId: "owner-message",
      finalMessageId: "final-message",
      metadataSource: "chatgpt-conversation-record",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(scheduledDelays).toContain(250);
  });

  it("does not hammer a rate-limited record endpoint when Retry-After is absent", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ accessToken: "token" }) })
      .mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => null } });

    const result = await new vm.Script(
      buildDeepResearchConversationRecordMetadataExpressionForTest("owner-message", 10_000),
    ).runInNewContext({
      AbortController,
      clearTimeout,
      encodeURIComponent,
      fetch: fetchMock,
      location: {
        protocol: "https:",
        hostname: "chatgpt.com",
        port: "",
        pathname: "/c/conversation-id",
      },
      setTimeout,
    });

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("resolves an attachment-bearing request-WEB turn by exact submitted user message ID", async () => {
    const token = "sensitive-browser-token";
    const userTurn = {
      innerText: "observation.txt\nDocument\nDeep research\nTest scientific prompt",
      textContent: "observation.txt\nDocument\nDeep research\nTest scientific prompt",
      getAttribute: (name: string) => {
        if (name === "data-turn") return "user";
        if (name === "data-message-id") return "user-message";
        return null;
      },
      querySelector: () => null,
    };
    const reportTurn = {
      innerText: "Completed Deep Research report",
      textContent: "Completed Deep Research report",
      getAttribute: (name: string) => {
        if (name === "data-turn") return "assistant";
        if (name === "data-turn-id" || name === "data-turn-id-container") {
          return "request-WEB:410834d6-live-shape-0";
        }
        return null;
      },
      querySelector: () => null,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ accessToken: token }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          current_node: "final-message",
          mapping: {
            "user-message": {
              parent: null,
              message: {
                id: "user-message",
                author: { role: "user" },
                content: { content_type: "text", parts: ["@deep research Test scientific prompt"] },
                metadata: {
                  deep_research_version: "standard",
                  request_id: "request-1",
                  private_prompt_metadata: "do not return",
                },
              },
            },
            "owner-message": {
              parent: "user-message",
              message: {
                id: "owner-message",
                author: { role: "assistant" },
                recipient: "api_tool.call_tool",
                end_turn: false,
                content: { content_type: "code", parts: ["private report body"] },
                metadata: {
                  model_slug: "gpt-5-5-instant",
                  resolved_model_slug: "gpt-5-5-instant",
                  default_model_slug: "gpt-5-6-pro",
                  request_id: "request-1",
                  private_field: "do not return",
                },
              },
            },
            "tool-message": {
              parent: "owner-message",
              message: {
                id: "tool-message",
                author: { role: "tool" },
                metadata: { request_id: "request-1" },
              },
            },
            "final-message": {
              parent: "tool-message",
              message: {
                id: "final-message",
                author: { role: "assistant" },
                end_turn: true,
                content: { content_type: "text", parts: ["Research completed"] },
                metadata: { model_slug: "unrelated-final-model" },
              },
            },
          },
        }),
      });

    const result = (await new vm.Script(
      buildDeepResearchActiveRecordMetadataExpressionForTest(
        1,
        1_000,
        "conversation-id",
        "user-message",
      ),
    ).runInNewContext({
      AbortController,
      clearTimeout,
      document: { querySelectorAll: () => [userTurn, reportTurn] },
      encodeURIComponent,
      fetch: fetchMock,
      location: {
        protocol: "https:",
        hostname: "chatgpt.com",
        port: "",
        pathname: "/c/conversation-id",
      },
      setTimeout,
    })) as Record<string, unknown>;

    expect(result).toEqual({
      messageId: "owner-message",
      finalMessageId: "final-message",
      modelSlug: "gpt-5-5-instant",
      resolvedModelSlug: "gpt-5-5-instant",
      defaultModelSlug: "gpt-5-6-pro",
      deepResearchVersion: "standard",
      metadataSource: "chatgpt-conversation-record",
    });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain("private report body");
    expect(JSON.stringify(result)).not.toContain("do not return");
  });

  it("does not resolve a request-WEB report turn to a different Deep Research prompt", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ accessToken: "token" }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          current_node: "owner-message",
          mapping: {
            "user-message": {
              parent: null,
              message: {
                id: "user-message",
                author: { role: "user" },
                content: { parts: ["@deep research Different prompt"] },
                metadata: { deep_research_version: "standard", request_id: "request-1" },
              },
            },
            "owner-message": {
              parent: "user-message",
              message: {
                id: "owner-message",
                author: { role: "assistant" },
                recipient: "api_tool.call_tool",
                end_turn: false,
                metadata: { request_id: "request-1" },
              },
            },
          },
        }),
      });

    const result = await new vm.Script(
      buildDeepResearchActiveRecordMetadataExpressionForTest(1, 1_000),
    ).runInNewContext({
      AbortController,
      clearTimeout,
      document: {
        querySelectorAll: () => [
          {
            innerText: "Deep research\nTest scientific prompt",
            textContent: "Deep research\nTest scientific prompt",
            getAttribute: (name: string) => {
              if (name === "data-turn") return "user";
              if (name === "data-message-id") return "user-message";
              return null;
            },
            querySelector: () => null,
          },
          {
            getAttribute: (name: string) => (name === "data-turn" ? "assistant" : null),
            querySelector: () => null,
          },
        ],
      },
      encodeURIComponent,
      fetch: fetchMock,
      location: {
        protocol: "https:",
        hostname: "chatgpt.com",
        port: "",
        pathname: "/c/conversation-id",
      },
      setTimeout,
    });

    expect(result).toBeNull();
  });

  it("does not bind a virtualized current turn to an older same-prompt record branch", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ accessToken: "token" }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          current_node: "old-owner",
          mapping: {
            "old-user": {
              parent: null,
              message: {
                id: "old-user",
                author: { role: "user" },
                content: { parts: ["@deep research Same prompt"] },
                metadata: { deep_research_version: "standard", request_id: "old-request" },
              },
            },
            "old-owner": {
              parent: "old-user",
              message: {
                id: "old-owner",
                author: { role: "assistant" },
                recipient: "api_tool.call_tool",
                end_turn: false,
                metadata: { request_id: "old-request" },
              },
            },
          },
        }),
      });

    const result = await new vm.Script(
      buildDeepResearchActiveRecordMetadataExpressionForTest(1, 1_000),
    ).runInNewContext({
      AbortController,
      clearTimeout,
      document: {
        querySelectorAll: () => [
          {
            innerText: "Deep research\nSame prompt",
            textContent: "Deep research\nSame prompt",
            getAttribute: (name: string) => {
              if (name === "data-turn") return "user";
              if (name === "data-message-id") return "current-user";
              return null;
            },
            querySelector: () => null,
          },
          {
            getAttribute: (name: string) => (name === "data-turn" ? "assistant" : null),
            querySelector: () => null,
          },
        ],
      },
      encodeURIComponent,
      fetch: fetchMock,
      location: {
        protocol: "https:",
        hostname: "chatgpt.com",
        port: "",
        pathname: "/c/conversation-id",
      },
      setTimeout,
    });

    expect(result).toBeNull();
  });

  it("rejects regenerated sibling report owners under the same exact user message", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ accessToken: "token" }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          current_node: "final-a",
          mapping: {
            "user-message": {
              parent: null,
              message: {
                id: "user-message",
                author: { role: "user" },
                content: { parts: ["@deep research Same prompt"] },
                metadata: { deep_research_version: "standard", request_id: "request-1" },
              },
            },
            "owner-a": {
              parent: "user-message",
              message: {
                id: "owner-a",
                author: { role: "assistant" },
                recipient: "api_tool.call_tool",
                end_turn: false,
                metadata: { request_id: "request-1" },
              },
            },
            "final-a": {
              parent: "owner-a",
              message: {
                id: "final-a",
                author: { role: "assistant" },
                end_turn: true,
                metadata: { request_id: "request-1" },
              },
            },
            "owner-b": {
              parent: "user-message",
              message: {
                id: "owner-b",
                author: { role: "assistant" },
                recipient: "api_tool.call_tool",
                end_turn: false,
                metadata: { request_id: "request-1" },
              },
            },
          },
        }),
      });

    const result = await new vm.Script(
      buildDeepResearchActiveRecordMetadataExpressionForTest(1, 1_000),
    ).runInNewContext({
      AbortController,
      clearTimeout,
      document: {
        querySelectorAll: () => [
          {
            innerText: "Deep research\nSame prompt",
            textContent: "Deep research\nSame prompt",
            getAttribute: (name: string) => {
              if (name === "data-turn") return "user";
              if (name === "data-message-id") return "user-message";
              return null;
            },
            querySelector: () => null,
          },
          {
            getAttribute: (name: string) => {
              if (name === "data-turn") return "assistant";
              if (name === "data-turn-id") return "request-WEB:stable";
              return null;
            },
            querySelector: () => null,
          },
        ],
      },
      encodeURIComponent,
      fetch: fetchMock,
      location: {
        protocol: "https:",
        hostname: "chatgpt.com",
        port: "",
        pathname: "/c/conversation-id",
      },
      setTimeout,
    });

    expect(result).toBeNull();
  });

  it("fails closed when the bound DOM report turn changes during record fetch", async () => {
    let reportKey = "request-WEB:before";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ accessToken: "token" }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => {
          reportKey = "request-WEB:after";
          return {
            current_node: "owner-message",
            mapping: {
              "user-message": {
                parent: null,
                message: {
                  id: "user-message",
                  author: { role: "user" },
                  content: { parts: ["@deep research Test prompt"] },
                  metadata: { deep_research_version: "standard", request_id: "request-1" },
                },
              },
              "owner-message": {
                parent: "user-message",
                message: {
                  id: "owner-message",
                  author: { role: "assistant" },
                  recipient: "api_tool.call_tool",
                  end_turn: false,
                  metadata: { request_id: "request-1" },
                },
              },
            },
          };
        },
      });
    const userTurn = {
      innerText: "Deep research\nTest prompt",
      textContent: "Deep research\nTest prompt",
      getAttribute: (name: string) => {
        if (name === "data-turn") return "user";
        if (name === "data-message-id") return "user-message";
        return null;
      },
      querySelector: () => null,
    };
    const reportTurn = {
      getAttribute: (name: string) => {
        if (name === "data-turn") return "assistant";
        if (name === "data-testid") return "conversation-turn-2";
        if (name === "data-turn-id") return reportKey;
        return null;
      },
      querySelector: () => null,
    };

    const result = await new vm.Script(
      buildDeepResearchActiveRecordMetadataExpressionForTest(1, 1_000),
    ).runInNewContext({
      AbortController,
      clearTimeout,
      document: { querySelectorAll: () => [userTurn, reportTurn] },
      encodeURIComponent,
      fetch: fetchMock,
      location: {
        protocol: "https:",
        hostname: "chatgpt.com",
        port: "",
        pathname: "/c/conversation-id",
      },
      setTimeout,
    });

    expect(result).toBeNull();
  });

  it("uses the owner message as the exact final identity when the owner is terminal", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ accessToken: "token" }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          current_node: "owner-message",
          mapping: {
            "user-message": {
              parent: null,
              message: {
                id: "user-message",
                author: { role: "user" },
                metadata: { deep_research_version: "standard" },
              },
            },
            "owner-message": {
              parent: "user-message",
              message: {
                id: "owner-message",
                author: { role: "assistant" },
                end_turn: true,
                metadata: {
                  model_slug: "gpt-5-5-instant",
                  resolved_model_slug: "gpt-5-5-instant",
                  default_model_slug: "gpt-5-6-pro",
                },
              },
            },
          },
        }),
      });

    const result = await new vm.Script(
      buildDeepResearchConversationRecordMetadataExpressionForTest("owner-message", 1_000),
    ).runInNewContext({
      AbortController,
      clearTimeout,
      encodeURIComponent,
      fetch: fetchMock,
      location: {
        protocol: "https:",
        hostname: "chatgpt.com",
        port: "",
        pathname: "/c/conversation-id",
      },
      setTimeout,
    });

    expect(result).toMatchObject({
      messageId: "owner-message",
      finalMessageId: "owner-message",
      modelSlug: "gpt-5-5-instant",
      resolvedModelSlug: "gpt-5-5-instant",
      defaultModelSlug: "gpt-5-6-pro",
    });
  });

  it("does not fetch authenticated metadata from an arbitrary configured origin", async () => {
    const fetchMock = vi.fn();
    const result = await new vm.Script(
      buildDeepResearchConversationRecordMetadataExpressionForTest("owner-message", 1_000),
    ).runInNewContext({
      AbortController,
      clearTimeout,
      encodeURIComponent,
      fetch: fetchMock,
      location: {
        protocol: "https:",
        hostname: "oracle-emulator.example",
        port: "",
        pathname: "/c/conversation-id",
      },
      setTimeout,
    });

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fetch authenticated metadata over an insecure ChatGPT origin", async () => {
    const fetchMock = vi.fn();
    const result = await new vm.Script(
      buildDeepResearchConversationRecordMetadataExpressionForTest("owner-message", 1_000),
    ).runInNewContext({
      AbortController,
      clearTimeout,
      encodeURIComponent,
      fetch: fetchMock,
      location: {
        protocol: "http:",
        hostname: "chatgpt.com",
        port: "",
        pathname: "/c/conversation-id",
      },
      setTimeout,
    });

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an authoritative owner whose prior user is not the submitted user message", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ accessToken: "token" }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          current_node: "owner-message",
          mapping: {
            "other-user": {
              parent: null,
              message: {
                id: "other-user",
                author: { role: "user" },
                metadata: { deep_research_version: "standard", request_id: "request-2" },
              },
            },
            "owner-message": {
              parent: "other-user",
              message: {
                id: "owner-message",
                author: { role: "assistant" },
                end_turn: true,
                metadata: { request_id: "request-2" },
              },
            },
          },
        }),
      });

    const result = await new vm.Script(
      buildDeepResearchConversationRecordMetadataExpressionForTest(
        "owner-message",
        1_000,
        "conversation-id",
        "submitted-user",
      ),
    ).runInNewContext({
      AbortController,
      clearTimeout,
      encodeURIComponent,
      fetch: fetchMock,
      location: {
        protocol: "https:",
        hostname: "chatgpt.com",
        port: "",
        pathname: "/c/conversation-id",
      },
      setTimeout,
    });

    expect(result).toBeNull();
  });

  it("does not fetch authenticated metadata after leaving the pinned conversation", async () => {
    const fetchMock = vi.fn();
    const result = await new vm.Script(
      buildDeepResearchConversationRecordMetadataExpressionForTest(
        "owner-message",
        1_000,
        "submitted-conversation",
      ),
    ).runInNewContext({
      AbortController,
      clearTimeout,
      encodeURIComponent,
      fetch: fetchMock,
      location: {
        protocol: "https:",
        hostname: "chatgpt.com",
        port: "",
        pathname: "/c/other-conversation",
      },
      setTimeout,
    });

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates the pinned conversation into authoritative metadata enrichment", async () => {
    const rawClient = {
      send: vi.fn(async (_method: string, params?: { expression?: string }) => {
        expect(params?.expression).toContain(
          'const expectedConversationId = "submitted-conversation";',
        );
        return { result: { value: null } };
      }),
    };

    await enrichDeepResearchTurnMetadataFromConversationRecordForTest(
      rawClient,
      { messageId: "owner-message", turnIndex: 2 },
      "page-session",
      "submitted-conversation",
    );

    expect(rawClient.send).toHaveBeenCalledOnce();
  });

  it("does not backfill fields missing from an authoritative conversation record", async () => {
    const rawClient = {
      send: vi.fn(async () => ({
        result: {
          value: {
            messageId: "owner-message",
            metadataSource: "chatgpt-conversation-record",
          },
        },
      })),
    };

    const result = await enrichDeepResearchTurnMetadataFromConversationRecordForTest(
      rawClient,
      {
        messageId: "owner-message",
        finalMessageId: "dom-final",
        turnId: "conversation-turn-3",
        turnIndex: 2,
        modelSlug: "dom-model",
        resolvedModelSlug: "dom-resolved",
        defaultModelSlug: "dom-default",
        deepResearchVersion: "dom-version",
      },
      "page-session",
    );

    expect(result).toEqual({
      messageId: "owner-message",
      turnId: "conversation-turn-3",
      turnIndex: 2,
      modelSlug: null,
      metadataSource: "chatgpt-conversation-record",
    });
    expect(rawClient.send).toHaveBeenCalledWith(
      "Runtime.evaluate",
      expect.objectContaining({ awaitPromise: true, returnByValue: true }),
      "page-session",
    );
  });

  it("fails closed when the bound owner is not on the active conversation branch", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ accessToken: "token" }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          current_node: "other-message",
          mapping: {
            "owner-message": {
              parent: null,
              message: { id: "owner-message", author: { role: "assistant" }, metadata: {} },
            },
            "other-message": {
              parent: null,
              message: { id: "other-message", author: { role: "assistant" }, metadata: {} },
            },
          },
        }),
      });

    const result = await new vm.Script(
      buildDeepResearchConversationRecordMetadataExpressionForTest("owner-message", 1_000),
    ).runInNewContext({
      AbortController,
      clearTimeout,
      encodeURIComponent,
      fetch: fetchMock,
      location: {
        protocol: "https:",
        hostname: "chatgpt.com",
        port: "",
        pathname: "/c/conversation-id",
      },
      setTimeout,
    });

    expect(result).toBeNull();
  });

  it("fails closed on a cyclic conversation-record branch", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ accessToken: "token" }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          current_node: "owner-message",
          mapping: {
            "owner-message": {
              parent: "cycle-message",
              message: { id: "owner-message", author: { role: "assistant" }, metadata: {} },
            },
            "cycle-message": {
              parent: "owner-message",
              message: { id: "cycle-message", author: { role: "tool" }, metadata: {} },
            },
          },
        }),
      });

    const result = await new vm.Script(
      buildDeepResearchConversationRecordMetadataExpressionForTest("owner-message", 1_000),
    ).runInNewContext({
      AbortController,
      clearTimeout,
      encodeURIComponent,
      fetch: fetchMock,
      location: {
        protocol: "https:",
        hostname: "chatgpt.com",
        port: "",
        pathname: "/c/conversation-id",
      },
      setTimeout,
    });

    expect(result).toBeNull();
  });
});

describe("pickPreferredDeepResearchReadForTest", () => {
  const completed = (text: string, len = 80) => ({
    completed: true,
    inProgress: false,
    textLength: len,
    text,
  });
  const inProgress = (len: number) => ({ completed: false, inProgress: true, textLength: len });

  it("returns null when neither read exists", () => {
    expect(pickPreferredDeepResearchReadForTest(null, null)).toBeNull();
  });

  it("prefers a completed target read over an in-progress in-page read", () => {
    expect(pickPreferredDeepResearchReadForTest(completed("TARGET"), inProgress(10))?.text).toBe(
      "TARGET",
    );
  });

  it("prefers the target read when both are completed", () => {
    expect(
      pickPreferredDeepResearchReadForTest(completed("TARGET"), completed("FRAME"))?.text,
    ).toBe("TARGET");
  });

  it("uses a completed in-page read when the target read is missing (legacy inline)", () => {
    expect(pickPreferredDeepResearchReadForTest(null, completed("FRAME"))?.text).toBe("FRAME");
  });

  it("uses a completed in-page read when the target read is only in-progress", () => {
    expect(pickPreferredDeepResearchReadForTest(inProgress(12), completed("FRAME"))?.text).toBe(
      "FRAME",
    );
  });

  it("keeps the best in-progress read for progress when none completed", () => {
    expect(pickPreferredDeepResearchReadForTest(inProgress(12), inProgress(5))?.textLength).toBe(
      12,
    );
    expect(pickPreferredDeepResearchReadForTest(null, inProgress(7))?.textLength).toBe(7);
  });
});

describe("shouldSkipDeepResearchTargetForTest", () => {
  it("keeps baseline targets excluded when strict owner-turn proof is unavailable", () => {
    expect(shouldSkipDeepResearchTargetForTest("baseline", ["baseline"], true, -1, false)).toBe(
      true,
    );
    expect(shouldSkipDeepResearchTargetForTest("baseline", ["baseline"], true, -1, true)).toBe(
      true,
    );
  });

  it("reconsiders a reused target only under strict owner-turn scoping", () => {
    expect(shouldSkipDeepResearchTargetForTest("baseline", ["baseline"], true, 1, true)).toBe(
      false,
    );
    expect(shouldSkipDeepResearchTargetForTest("baseline", ["baseline"], false, 1, true)).toBe(
      true,
    );
    expect(shouldSkipDeepResearchTargetForTest("baseline", ["baseline"], true, 1, false)).toBe(
      true,
    );
    expect(shouldSkipDeepResearchTargetForTest("fresh", ["baseline"], false, 1, true)).toBe(false);
  });
});

describe("reused Deep Research target freshness", () => {
  it("rejects unchanged completed baseline content even after a reset transition", () => {
    const baseline = {
      targetId: "baseline",
      completed: true,
      contentSha256: "a".repeat(64),
    };
    expect(hasFreshDeepResearchContentProofForTest(baseline, "a".repeat(64))).toBe(false);
    expect(hasFreshDeepResearchContentProofForTest(baseline, "b".repeat(64))).toBe(true);
  });

  it("accepts a completed transition from a captured non-completed baseline", () => {
    expect(
      hasFreshDeepResearchContentProofForTest(
        { targetId: "baseline", completed: false },
        "a".repeat(64),
      ),
    ).toBe(true);
  });

  it("fails closed when a baseline target was confirmed but unreadable", () => {
    expect(
      hasFreshDeepResearchContentProofForTest(
        { targetId: "baseline", completed: null },
        "a".repeat(64),
      ),
    ).toBe(false);
  });

  it("requires the same owner identity on both sides of the report read", () => {
    const owner = {
      messageId: "message-current",
      turnId: "conversation-turn-2",
      turnIndex: 1,
    };
    expect(isSameDeepResearchOwnerForTest(owner, owner)).toBe(true);
    expect(
      isSameDeepResearchOwnerForTest(owner, { ...owner, messageId: "message-remounted" }),
    ).toBe(false);
    expect(isSameDeepResearchOwnerForTest(owner, { ...owner, turnIndex: 2 })).toBe(false);
  });
});

describe("waitForResearchPlanAutoConfirm", () => {
  let mockRuntime: ReturnType<typeof createMockRuntime>;
  let mockLogger: BrowserLogger;

  beforeEach(() => {
    mockRuntime = createMockRuntime();
    mockLogger = createMockLogger();
  });

  it("detects research plan via iframe and waits for auto-confirm", async () => {
    // Phase A: plan detected via iframe
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: { value: { hasResearchIframe: true, hasResearchText: false } },
    });
    // Phase B: research started
    mockRuntime.evaluate.mockResolvedValue({
      result: { value: { hasLargeIframe: false, isResearching: true } },
    });

    await expect(
      waitForResearchPlanAutoConfirm(mockRuntime as never, mockLogger, 1_000),
    ).resolves.toBeUndefined();
    expect(mockLogger).toHaveBeenCalledWith(expect.stringContaining("Research plan detected"));
  });

  it("detects research plan via text content", async () => {
    // Phase A: plan detected via text
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: { value: { hasResearchIframe: false, hasResearchText: true } },
    });
    // Phase B: research started
    mockRuntime.evaluate.mockResolvedValue({
      result: { value: { hasLargeIframe: false, isResearching: true } },
    });

    await expect(
      waitForResearchPlanAutoConfirm(mockRuntime as never, mockLogger, 1_000),
    ).resolves.toBeUndefined();
  });

  it("handles plan not detected gracefully", async () => {
    // All polls: nothing detected — use short timeout to avoid slow test
    mockRuntime.evaluate.mockResolvedValue({
      result: { value: { hasResearchIframe: false, hasResearchText: false } },
    });

    // Override planDeadline by passing very short auto-confirm wait
    // The function internally waits up to 60s for plan detection;
    // we can't easily shorten that, so we rely on the implementation
    // returning gracefully when plan isn't found.
    // Since the plan detection polls every 2s for up to 60s, this test
    // would be slow. Instead, test that the function handles the timeout path.
    // We'll use a trick: mock Date.now to advance time quickly.
    const realDateNow = Date.now;
    let fakeNow = realDateNow();
    vi.spyOn(Date, "now").mockImplementation(() => {
      fakeNow += 30_000; // Jump 30s each call
      return fakeNow;
    });

    await expect(
      waitForResearchPlanAutoConfirm(mockRuntime as never, mockLogger, 100),
    ).resolves.toBeUndefined();
    expect(mockLogger).toHaveBeenCalledWith(expect.stringContaining("not detected"));

    vi.spyOn(Date, "now").mockRestore();
  });
});

describe("waitForDeepResearchCompletion", () => {
  let mockRuntime: ReturnType<typeof createMockRuntime>;
  let mockLogger: BrowserLogger;

  beforeEach(() => {
    mockRuntime = createMockRuntime();
    mockLogger = createMockLogger();
  });

  it("fails closed when scoped owner verification is required without a turn index", async () => {
    await expect(
      waitForDeepResearchCompletion(
        mockRuntime as never,
        mockLogger,
        60_000,
        undefined,
        undefined,
        undefined,
        { requireScopedTargetOwner: true },
      ),
    ).rejects.toMatchObject({
      details: {
        code: "deep-research-scope-unavailable",
        stage: "deep-research-scope",
      },
    });
    expect(mockRuntime.evaluate).not.toHaveBeenCalled();
  });

  it("captures only existing targets attached to the current page session", async () => {
    const listeners = new Map<string, (params: unknown, sessionId?: string) => void>();
    const deepResearchUrl =
      "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/";
    const mockClient = {
      oraclePageSessionId: "page-session",
      on: vi.fn((event: string, listener: (params: unknown, sessionId?: string) => void) => {
        listeners.set(event, listener);
      }),
      removeListener: vi.fn(),
      send: vi.fn(async (method: string, params?: unknown, sessionId?: string) => {
        if (method === "Target.setAutoAttach" && (params as { autoAttach?: boolean })?.autoAttach) {
          listeners.get("Target.attachedToTarget")?.(
            {
              sessionId: "foreign-session",
              targetInfo: { targetId: "foreign-target", type: "iframe", url: deepResearchUrl },
            },
            "foreign-page-session",
          );
          listeners.get("Target.attachedToTarget")?.(
            {
              sessionId: "existing-session",
              targetInfo: { targetId: "existing-target", type: "iframe", url: deepResearchUrl },
            },
            "page-session",
          );
          listeners.get("Target.attachedToTarget")?.(
            {
              sessionId: "unrelated-session",
              targetInfo: { targetId: "unrelated-target", type: "iframe", url: "about:blank" },
            },
            "page-session",
          );
          return {};
        }
        if (method === "Page.getFrameTree") {
          return {
            frameTree: {
              frame: {
                id: `${sessionId}-frame`,
                name: "root",
                url: sessionId === "unrelated-session" ? "about:blank" : deepResearchUrl,
              },
            },
          };
        }
        return {};
      }),
    };

    await expect(captureDeepResearchTargetKeys(mockClient as never)).resolves.toEqual([
      "existing-target",
    ]);
  });

  it("rejects an unavailable target baseline instead of trusting an empty scan", async () => {
    const mockClient = {
      on: vi.fn(),
      removeListener: vi.fn(),
      send: vi.fn(async (method: string) => {
        if (method === "Target.setAutoAttach") {
          throw new Error("auto-attach unavailable");
        }
        return {};
      }),
    };

    await expect(captureDeepResearchTargetKeys(mockClient as never)).rejects.toThrow(
      "baseline capture unavailable",
    );
  });

  it("detects completion via finished actions", async () => {
    // First poll: still in progress
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: {
          finished: false,
          stopVisible: true,
          textLength: 100,
          hasIframe: true,
          incompleteResult: true,
          researchActivity: true,
        },
      },
    });
    // Second poll: completed
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: { finished: true, stopVisible: false, textLength: 5000, hasIframe: false },
      },
    });
    // extractDeepResearchResult → readAssistantSnapshot
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: {
          text: "Research report content",
          html: "<p>Research report content</p>",
          turnId: "t1",
          messageId: "m1",
          turnIndex: 1,
          modelSlug: "gpt-5-6-pro",
        },
      },
    });
    // extractDeepResearchResult → captureAssistantMarkdown (copy button click)
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: { value: null },
    });

    const result = await waitForDeepResearchCompletion(mockRuntime as never, mockLogger, 60_000);
    expect(result.text).toBe("Research report content");
    expect(result.assistantTurn).toMatchObject({
      messageId: "m1",
      turnId: "t1",
      turnIndex: 1,
      modelSlug: "gpt-5-6-pro",
    });
  });

  it("fails clearly when ChatGPT silently returns a normal response", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: { finished: true, stopVisible: false, textLength: 100, hasIframe: false },
      },
    });

    await expect(
      waitForDeepResearchCompletion(mockRuntime as never, mockLogger, 60_000),
    ).rejects.toThrow(/without starting Deep Research/);
  });

  it("does not treat an unscoped page iframe as evidence for a normal response", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: { finished: false, stopVisible: true, textLength: 10, hasIframe: true },
      },
    });
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: { finished: true, stopVisible: false, textLength: 100, hasIframe: true },
      },
    });

    await expect(
      waitForDeepResearchCompletion(mockRuntime as never, mockLogger, 60_000),
    ).rejects.toThrow(/without starting Deep Research/);
  });

  it("does not treat a system reminder as evidence for a normal response", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: {
          finished: false,
          stopVisible: true,
          textLength: 100,
          hasIframe: false,
          incompleteResult: true,
          researchActivity: false,
        },
      },
    });
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: { finished: true, stopVisible: false, textLength: 100, hasIframe: false },
      },
    });

    await expect(
      waitForDeepResearchCompletion(mockRuntime as never, mockLogger, 60_000),
    ).rejects.toThrow(/without starting Deep Research/);
  });

  it("accepts a finished DOM report after observing a planning panel", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: {
          finished: false,
          stopVisible: true,
          textLength: 100,
          hasIframe: false,
          incompleteResult: true,
          researchActivity: true,
        },
      },
    });
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: { finished: true, stopVisible: false, textLength: 5000, hasIframe: false },
      },
    });
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: {
          text: "Research report content",
          html: "<p>Research report content</p>",
          turnId: "t1",
          messageId: "m1",
        },
      },
    });
    mockRuntime.evaluate.mockResolvedValueOnce({ result: { value: null } });

    const result = await waitForDeepResearchCompletion(mockRuntime as never, mockLogger, 60_000);
    expect(result.text).toBe("Research report content");
  });

  it("accepts a finished DOM report after scoped tool activity", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: {
          finished: false,
          stopVisible: true,
          textLength: 11,
          hasIframe: true,
          incompleteResult: true,
          researchActivity: true,
          hasActiveScopedResearch: true,
          hasVerifiedScopedResearchActivity: true,
        },
      },
    });
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: { finished: true, stopVisible: false, textLength: 5000, hasIframe: false },
      },
    });
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: {
          text: "Research report content",
          html: "<p>Research report content</p>",
          turnId: "t1",
          messageId: "m1",
        },
      },
    });
    mockRuntime.evaluate.mockResolvedValueOnce({ result: { value: null } });

    const result = await waitForDeepResearchCompletion(mockRuntime as never, mockLogger, 60_000);
    expect(result.text).toBe("Research report content");
  });

  it("detects completion via the Deep Research iframe", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: { finished: false, stopVisible: false, textLength: 0, hasIframe: true },
      },
    });
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: {
          completed: true,
          inProgress: false,
          textLength: 80,
          text: "CHECK_DEEP_OK https://example.com/report",
          html: "<p>CHECK_DEEP_OK https://example.com/report</p>",
        },
      },
    });
    const mockPage = {
      getFrameTree: vi.fn().mockResolvedValue({
        frameTree: {
          frame: { id: "root", url: "https://chatgpt.com/" },
          childFrames: [
            {
              frame: {
                id: "deep-frame",
                url: "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/",
              },
            },
          ],
        },
      }),
      createIsolatedWorld: vi.fn().mockResolvedValue({ executionContextId: 42 }),
    };

    const result = await waitForDeepResearchCompletion(
      mockRuntime as never,
      mockLogger,
      60_000,
      undefined,
      mockPage as never,
    );

    expect(result.text).toBe("CHECK_DEEP_OK https://example.com/report");
    expect(mockPage.createIsolatedWorld).toHaveBeenCalledWith(
      expect.objectContaining({ frameId: "deep-frame" }),
    );
    expect(mockRuntime.evaluate).toHaveBeenLastCalledWith(
      expect.objectContaining({ contextId: 42 }),
    );
  });

  it("detects completion via a Deep Research target session", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: { finished: false, stopVisible: false, textLength: 0, hasIframe: true },
      },
    });
    const listeners = new Map<string, (params: unknown, sessionId?: string) => void>();
    const mockClient = {
      on: vi.fn((event: string, listener: (params: unknown, sessionId?: string) => void) => {
        listeners.set(event, listener);
      }),
      removeListener: vi.fn(),
      send: vi.fn(async (method: string, params?: unknown, sessionId?: string) => {
        if (method === "Target.setAutoAttach") {
          listeners.get("Target.attachedToTarget")?.({
            sessionId: "deep-session",
            targetInfo: {
              type: "iframe",
              url: "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/",
            },
          });
          return {};
        }
        if (method === "Target.getTargets") {
          return { targetInfos: [] };
        }
        if (method === "Page.getFrameTree" && sessionId === "deep-session") {
          return {
            frameTree: {
              frame: { id: "sandbox", name: "root", url: "about:blank" },
            },
          };
        }
        if (
          method === "Runtime.evaluate" &&
          sessionId === "deep-session" &&
          typeof (params as { contextId?: number }).contextId !== "number"
        ) {
          return {
            result: {
              value: {
                completed: true,
                inProgress: false,
                textLength: 80,
                text: "CHECK_DEEP_OK https://example.com/report",
              },
            },
          };
        }
        return {};
      }),
    };

    const result = await waitForDeepResearchCompletion(
      mockRuntime as never,
      mockLogger,
      60_000,
      undefined,
      undefined,
      mockClient as never,
    );

    expect(result.text).toBe("CHECK_DEEP_OK https://example.com/report");
    expect(mockClient.send).toHaveBeenCalledWith(
      "Runtime.evaluate",
      expect.objectContaining({ returnByValue: true }),
      "deep-session",
    );
  });

  it("does not return a foreign completed Deep Research report from another tab", async () => {
    // Cross-tab isolation: a shared/persistent Chrome profile can hold another
    // tab's COMPLETED Deep Research report. Target discovery must be scoped to the
    // current Oracle-controlled page (via page-session auto-attach), so the
    // foreign report is never read into this session — even though a browser-wide
    // Target.getTargets scan would surface it.
    mockRuntime.evaluate.mockResolvedValue({
      result: {
        value: {
          finished: false,
          stopVisible: false,
          textLength: 0,
          hasIframe: true,
          hasActiveScopedResearch: false,
          conversationId: "conversation-id",
        },
      },
    });

    let getTargetsCalled = false;
    let foreignAttachCalled = false;
    const listeners = new Map<string, (params: unknown, sessionId?: string) => void>();
    const deepResearchUrl =
      "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/";

    const mockClient = {
      on: vi.fn((event: string, listener: (params: unknown, sessionId?: string) => void) => {
        listeners.set(event, listener);
      }),
      removeListener: vi.fn(),
      send: vi.fn(async (method: string, params?: unknown, sessionId?: string) => {
        if (method === "Target.setAutoAttach" && (params as { autoAttach?: boolean })?.autoAttach) {
          // Page-scoped auto-attach surfaces only THIS page's OOPIF — still in progress.
          listeners.get("Target.attachedToTarget")?.({
            sessionId: "current-session",
            targetInfo: { type: "iframe", url: deepResearchUrl },
          });
          return {};
        }
        if (method === "Target.getTargets") {
          // A foreign tab's COMPLETED report is visible browser-wide; it must be ignored.
          getTargetsCalled = true;
          return {
            targetInfos: [{ targetId: "foreign-target", type: "iframe", url: deepResearchUrl }],
          };
        }
        if (method === "Target.attachToTarget") {
          foreignAttachCalled = true;
          return { sessionId: "foreign-session" };
        }
        if (method === "Page.getFrameTree") {
          return {
            frameTree: { frame: { id: `${sessionId}-frame`, name: "root", url: deepResearchUrl } },
          };
        }
        if (method === "Page.createIsolatedWorld") {
          return { executionContextId: sessionId === "foreign-session" ? 99 : 50 };
        }
        if (method === "Runtime.evaluate" && sessionId === "foreign-session") {
          return {
            result: {
              value: {
                completed: true,
                inProgress: false,
                textLength: 80,
                text: "FOREIGN_REPORT https://example.com/foreign",
              },
            },
          };
        }
        if (method === "Runtime.evaluate" && sessionId === "current-session") {
          return {
            result: {
              value: { completed: false, inProgress: true, textLength: 10, text: undefined },
            },
          };
        }
        return {};
      }),
    };

    let nowCalls = 0;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      nowCalls += 1;
      return nowCalls < 8 ? 1_000 : 2_000;
    });

    try {
      await expect(
        waitForDeepResearchCompletion(
          mockRuntime as never,
          mockLogger,
          100,
          1,
          undefined,
          mockClient as never,
          {
            expectedConversationId: "conversation-id",
            expectedUserMessageId: "user-message",
          },
        ),
      ).rejects.toThrow(/did not complete/);
      // The foreign target must never be reached, regardless of the browser-wide scan.
      expect(foreignAttachCalled).toBe(false);
      expect(getTargetsCalled).toBe(false);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("binds Target.setAutoAttach to the page session on a session-bound wrapper client", async () => {
    // On the browser-WSEndpoint path, `client` is a session-bound wrapper whose
    // raw `send` is browser-level (only domain methods are session-bound). If
    // auto-attach is issued without the page session id, it attaches browser-wide
    // and a foreign completed Deep Research tab leaks into this session. The fix
    // passes `oraclePageSessionId`; this test asserts every setAutoAttach call is
    // bound to that page session.
    mockRuntime.evaluate.mockResolvedValue({
      result: {
        value: {
          finished: false,
          stopVisible: false,
          textLength: 0,
          hasIframe: true,
          hasActiveScopedResearch: false,
          conversationId: "conversation-id",
        },
      },
    });

    const setAutoAttachSessions: Array<string | undefined> = [];
    const listeners = new Map<string, (params: unknown, sessionId?: string) => void>();
    const deepResearchUrl =
      "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/";

    const mockClient = {
      // Marks the session-bound wrapper (createSessionBoundChromeClient).
      oraclePageSessionId: "page-session",
      on: vi.fn((event: string, listener: (params: unknown, sessionId?: string) => void) => {
        listeners.set(event, listener);
      }),
      removeListener: vi.fn(),
      send: vi.fn(async (method: string, params?: unknown, sessionId?: string) => {
        if (method === "Target.setAutoAttach" && (params as { autoAttach?: boolean })?.autoAttach) {
          setAutoAttachSessions.push(sessionId);
          // Page-session-scoped: only this page's OOPIF (in progress). If the call
          // were browser-wide (sessionId !== page-session), a foreign completed
          // report would also attach — which the assertions below forbid.
          listeners.get("Target.attachedToTarget")?.({
            sessionId: "current-session",
            targetInfo: { type: "iframe", url: deepResearchUrl },
          });
          if (sessionId !== "page-session") {
            listeners.get("Target.attachedToTarget")?.({
              sessionId: "foreign-session",
              targetInfo: { type: "iframe", url: deepResearchUrl },
            });
          }
          return {};
        }
        if (method === "Page.getFrameTree") {
          return {
            frameTree: { frame: { id: `${sessionId}-frame`, name: "root", url: deepResearchUrl } },
          };
        }
        if (method === "Page.createIsolatedWorld") {
          return { executionContextId: sessionId === "foreign-session" ? 99 : 50 };
        }
        if (method === "Runtime.evaluate" && sessionId === "foreign-session") {
          return {
            result: {
              value: { completed: true, inProgress: false, textLength: 80, text: "FOREIGN_REPORT" },
            },
          };
        }
        if (method === "Runtime.evaluate" && sessionId === "current-session") {
          return {
            result: {
              value: { completed: false, inProgress: true, textLength: 10, text: undefined },
            },
          };
        }
        return {};
      }),
    };

    let nowCalls = 0;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      nowCalls += 1;
      return nowCalls < 8 ? 1_000 : 2_000;
    });

    try {
      await expect(
        waitForDeepResearchCompletion(
          mockRuntime as never,
          mockLogger,
          100,
          1,
          undefined,
          mockClient as never,
          {
            expectedConversationId: "conversation-id",
            expectedUserMessageId: "user-message",
          },
        ),
      ).rejects.toThrow(/did not complete/);
      // Every auto-attach was bound to the page session — never browser-wide.
      expect(setAutoAttachSessions.length).toBeGreaterThan(0);
      expect(setAutoAttachSessions.every((s) => s === "page-session")).toBe(true);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("ignores target events from another page session on the shared browser client", async () => {
    mockRuntime.evaluate.mockResolvedValue({
      result: {
        value: {
          finished: false,
          stopVisible: false,
          textLength: 0,
          hasIframe: true,
          hasActiveScopedResearch: false,
          conversationId: "conversation-id",
        },
      },
    });

    const evaluatedSessions: string[] = [];
    const listeners = new Map<string, (params: unknown, sessionId?: string) => void>();
    const deepResearchUrl =
      "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/";

    const mockClient = {
      oraclePageSessionId: "page-session",
      on: vi.fn((event: string, listener: (params: unknown, sessionId?: string) => void) => {
        listeners.set(event, listener);
      }),
      removeListener: vi.fn(),
      send: vi.fn(async (method: string, params?: unknown, sessionId?: string) => {
        if (method === "Target.setAutoAttach" && (params as { autoAttach?: boolean })?.autoAttach) {
          // chrome-remote-interface emits every flattened session event to the
          // base listener. Its second callback argument identifies the parent
          // page session that produced the child target event.
          listeners.get("Target.attachedToTarget")?.(
            {
              sessionId: "foreign-child-session",
              targetInfo: { type: "iframe", url: deepResearchUrl },
            },
            "foreign-page-session",
          );
          listeners.get("Target.attachedToTarget")?.(
            {
              sessionId: "current-child-session",
              targetInfo: { type: "iframe", url: deepResearchUrl },
            },
            "page-session",
          );
          return {};
        }
        if (method === "Page.getFrameTree") {
          return {
            frameTree: { frame: { id: `${sessionId}-frame`, name: "root", url: deepResearchUrl } },
          };
        }
        if (method === "Page.createIsolatedWorld") {
          return { executionContextId: sessionId === "foreign-child-session" ? 99 : 50 };
        }
        if (method === "Runtime.evaluate" && sessionId) {
          evaluatedSessions.push(sessionId);
          if (sessionId === "foreign-child-session") {
            return {
              result: {
                value: {
                  completed: true,
                  inProgress: false,
                  textLength: 80,
                  text: "FOREIGN_REPORT https://example.com/foreign",
                },
              },
            };
          }
          return {
            result: {
              value: { completed: false, inProgress: true, textLength: 10, text: undefined },
            },
          };
        }
        return {};
      }),
    };

    let nowCalls = 0;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      nowCalls += 1;
      return nowCalls < 8 ? 1_000 : 2_000;
    });

    try {
      await expect(
        waitForDeepResearchCompletion(
          mockRuntime as never,
          mockLogger,
          100,
          1,
          undefined,
          mockClient as never,
          {
            expectedConversationId: "conversation-id",
            expectedUserMessageId: "user-message",
          },
        ),
      ).rejects.toThrow(/did not complete/);
      expect(evaluatedSessions).not.toContain("foreign-child-session");
      expect(evaluatedSessions).toContain("current-child-session");
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("rejects a fresh baseline-filtered OOPIF report when its scoped owner is unavailable", async () => {
    mockRuntime.evaluate.mockResolvedValue({
      result: {
        value: {
          finished: false,
          stopVisible: true,
          textLength: 11,
          hasIframe: true,
          hasActiveScopedResearch: false,
          conversationId: "conversation-id",
        },
      },
    });

    const evaluatedSessions: string[] = [];
    const listeners = new Map<string, (params: unknown, sessionId?: string) => void>();
    const deepResearchUrl =
      "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/";
    const mockClient = {
      oraclePageSessionId: "page-session",
      on: vi.fn((event: string, listener: (params: unknown, sessionId?: string) => void) => {
        listeners.set(event, listener);
      }),
      removeListener: vi.fn(),
      send: vi.fn(async (method: string, params?: unknown, sessionId?: string) => {
        if (method === "Target.setAutoAttach" && (params as { autoAttach?: boolean })?.autoAttach) {
          listeners.get("Target.attachedToTarget")?.(
            {
              sessionId: "old-session",
              targetInfo: { targetId: "old-target", type: "iframe", url: deepResearchUrl },
            },
            "page-session",
          );
          listeners.get("Target.attachedToTarget")?.(
            {
              sessionId: "current-session",
              targetInfo: { targetId: "current-target", type: "iframe", url: deepResearchUrl },
            },
            "page-session",
          );
          return {};
        }
        if (method === "Page.getFrameTree") {
          return {
            frameTree: {
              frame: { id: `${sessionId}-frame`, name: "root", url: deepResearchUrl },
            },
          };
        }
        if (method === "Page.createIsolatedWorld") {
          return { executionContextId: sessionId === "old-session" ? 10 : 20 };
        }
        if (method === "DOM.getFrameOwner") {
          return {};
        }
        if (method === "Runtime.evaluate" && sessionId) {
          evaluatedSessions.push(sessionId);
          if (sessionId === "old-session") {
            return {
              result: {
                value: {
                  completed: true,
                  inProgress: false,
                  textLength: 80,
                  text: "OLD_REPORT https://example.com/old",
                },
              },
            };
          }
          return {
            result: {
              value: {
                completed: true,
                inProgress: false,
                textLength: 90,
                text: "CURRENT_REPORT https://example.com/current",
              },
            },
          };
        }
        return {};
      }),
    };

    let nowCalls = 0;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      nowCalls += 1;
      return nowCalls < 8 ? 1_000 : 2_000;
    });
    try {
      await expect(
        waitForDeepResearchCompletion(
          mockRuntime as never,
          mockLogger,
          100,
          1,
          undefined,
          mockClient as never,
          {
            targetBaseline: [{ targetId: "old-target", completed: false }],
            targetBaselineCaptured: true,
            expectedConversationId: "conversation-id",
            expectedUserMessageId: "user-message",
          },
        ),
      ).rejects.toThrow(/did not complete/);
      // A baseline target may be reused after submission, so it is read and
      // then rejected because current-turn owner evidence is unavailable.
      expect(evaluatedSessions).toContain("old-session");
      expect(evaluatedSessions).toContain("current-session");
      expect(mockClient.send).toHaveBeenCalledWith(
        "DOM.getFrameOwner",
        { frameId: "current-session-frame" },
        "page-session",
      );
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("scopes reattached OOPIF reports to their owning conversation turn", async () => {
    mockRuntime.evaluate.mockResolvedValue({
      result: {
        value: {
          finished: false,
          stopVisible: false,
          textLength: 0,
          hasIframe: true,
          hasActiveScopedResearch: false,
          conversationId: "conversation-id",
        },
      },
    });

    const listeners = new Map<string, (params: unknown, sessionId?: string) => void>();
    const conversationRecordExpressions: string[] = [];
    const runtimeEnabledSessions = new Set<string>();
    const deepResearchUrl =
      "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/";
    const mockClient = {
      oraclePageSessionId: "page-session",
      on: vi.fn((event: string, listener: (params: unknown, sessionId?: string) => void) => {
        listeners.set(event, listener);
      }),
      removeListener: vi.fn(),
      send: vi.fn(async (method: string, params?: unknown, sessionId?: string) => {
        if (method === "Target.setAutoAttach" && (params as { autoAttach?: boolean })?.autoAttach) {
          // Emit the current report first so target order alone would incorrectly
          // let the later stale completion win.
          listeners.get("Target.attachedToTarget")?.(
            {
              sessionId: "current-session",
              targetInfo: { targetId: "current-target", type: "iframe", url: deepResearchUrl },
            },
            "page-session",
          );
          listeners.get("Target.attachedToTarget")?.(
            {
              sessionId: "old-session",
              targetInfo: { targetId: "old-target", type: "iframe", url: deepResearchUrl },
            },
            "page-session",
          );
          return {};
        }
        if (method === "Runtime.enable" && sessionId === "current-session") {
          if (!runtimeEnabledSessions.has(sessionId)) {
            runtimeEnabledSessions.add(sessionId);
            listeners.get("Runtime.executionContextCreated")?.(
              {
                context: {
                  id: 31,
                  auxData: { frameId: "current-session-report-frame", isDefault: true },
                },
              },
              "current-session",
            );
          }
          return {};
        }
        if (method === "Runtime.disable" && sessionId) {
          runtimeEnabledSessions.delete(sessionId);
          return {};
        }
        if (method === "Page.getFrameTree") {
          return {
            frameTree:
              sessionId === "current-session"
                ? {
                    frame: {
                      id: "current-session-frame",
                      name: "sandbox",
                      url: deepResearchUrl,
                    },
                    childFrames: [
                      {
                        frame: {
                          id: "current-session-report-frame",
                          name: "root",
                          url: deepResearchUrl,
                        },
                      },
                    ],
                  }
                : { frame: { id: `${sessionId}-frame`, name: "root", url: deepResearchUrl } },
          };
        }
        if (method === "Page.createIsolatedWorld" && sessionId === "current-session") {
          const frameId = (params as { frameId?: string }).frameId;
          return { executionContextId: frameId === "current-session-report-frame" ? 42 : 41 };
        }
        if (method === "DOM.getFrameOwner") {
          const frameId = (params as { frameId?: string }).frameId;
          return { backendNodeId: frameId === "current-session-frame" ? 20 : 10 };
        }
        if (method === "DOM.resolveNode") {
          const backendNodeId = (params as { backendNodeId?: number }).backendNodeId;
          return { object: { objectId: backendNodeId === 20 ? "current-owner" : "old-owner" } };
        }
        if (method === "Runtime.callFunctionOn" && sessionId === "page-session") {
          const objectId = (params as { objectId?: string }).objectId;
          return {
            result: {
              value:
                objectId === "current-owner"
                  ? {
                      messageId: "message-current",
                      turnId: "conversation-turn-3",
                      turnIndex: 2,
                      modelSlug: "gpt-5-6-pro",
                    }
                  : {
                      messageId: "message-old",
                      turnId: "conversation-turn-1",
                      turnIndex: 0,
                      modelSlug: "gpt-4o",
                    },
            },
          };
        }
        if (
          method === "Runtime.evaluate" &&
          sessionId === "page-session" &&
          String((params as { expression?: string })?.expression).includes(
            "oracle-deep-research-conversation-record-metadata",
          )
        ) {
          conversationRecordExpressions.push(
            String((params as { expression?: string })?.expression),
          );
          return {
            result: {
              value: {
                messageId: "message-current",
                finalMessageId: "message-current-final",
                modelSlug: "gpt-5-5-instant",
                resolvedModelSlug: "gpt-5-5-instant",
                defaultModelSlug: "gpt-5-6-pro",
                deepResearchVersion: "standard",
                metadataSource: "chatgpt-conversation-record",
              },
            },
          };
        }
        if (method === "Runtime.evaluate" && sessionId) {
          if (
            String((params as { expression?: string })?.expression).includes(
              "oracle-deep-research-citation-sources",
            )
          ) {
            return {
              result: {
                value: {
                  observedIndexes: [1],
                  sources: [{ index: 1, url: "https://example.com/current-source" }],
                },
              },
            };
          }
          if (
            sessionId === "current-session" &&
            (params as { contextId?: number }).contextId === 41
          ) {
            return {
              result: {
                value: { completed: false, inProgress: false, textLength: 0 },
              },
            };
          }
          return {
            result: {
              value: {
                completed: true,
                inProgress: false,
                textLength: 80,
                text:
                  sessionId === "current-session"
                    ? `CURRENT_REPORT[[ORACLE_DEEP_RESEARCH_CITATION_${TEST_CITATION_NONCE}_1]] https://example.com/current`
                    : "OLD_REPORT https://example.com/old",
                citationMarkerNonce: TEST_CITATION_NONCE,
                citationRootComparable: "current report root",
                citationReportNeedle: "current report",
              },
            },
          };
        }
        return {};
      }),
    };

    const result = await waitForDeepResearchCompletion(
      mockRuntime as never,
      mockLogger,
      60_000,
      1,
      undefined,
      mockClient as never,
      {
        requireScopedTargetOwner: true,
        expectedConversationId: "conversation-id",
        expectedUserMessageId: "user-message-current",
      },
    );

    expect(result.text).toBe(
      "CURRENT_REPORT[1](<https://example.com/current-source>) https://example.com/current",
    );
    expect(result.citationStatus).toEqual({ total: 1, linked: 1, missingIndexes: [] });
    expect(result.meta).toEqual({
      messageId: "message-current",
      turnId: "conversation-turn-3",
      turnIndex: 2,
      modelSlug: "gpt-5-5-instant",
      finalMessageId: "message-current-final",
      resolvedModelSlug: "gpt-5-5-instant",
      defaultModelSlug: "gpt-5-6-pro",
      deepResearchVersion: "standard",
      metadataSource: "chatgpt-conversation-record",
    });
    expect(result.assistantTurn).toMatchObject({
      messageId: "message-current",
      turnId: "conversation-turn-3",
      turnIndex: 2,
      modelSlug: "gpt-5-5-instant",
      finalMessageId: "message-current-final",
      resolvedModelSlug: "gpt-5-5-instant",
      defaultModelSlug: "gpt-5-6-pro",
      deepResearchVersion: "standard",
      metadataSource: "chatgpt-conversation-record",
      responseSha256: createHash("sha256")
        .update(
          "CURRENT_REPORT[1](<https://example.com/current-source>) https://example.com/current",
        )
        .digest("hex"),
    });
    expect(mockClient.send).toHaveBeenCalledWith(
      "DOM.getFrameOwner",
      { frameId: "current-session-frame" },
      "page-session",
    );
    const ownerMetadataCall = mockClient.send.mock.calls.find(
      ([method, , sessionId]) =>
        method === "Runtime.callFunctionOn" && sessionId === "page-session",
    );
    const ownerFunction = String(
      (ownerMetadataCall?.[1] as { functionDeclaration?: string } | undefined)?.functionDeclaration,
    );
    expect(ownerFunction.indexOf("turn.getAttribute?.('data-turn-id')")).toBeGreaterThanOrEqual(0);
    expect(ownerFunction.indexOf("turn.getAttribute?.('data-turn-id')")).toBeLessThan(
      ownerFunction.indexOf("messageRoot.getAttribute?.('data-turn-id')"),
    );
    expect(ownerFunction.indexOf("turn.getAttribute?.('data-turn-id')")).toBeLessThan(
      ownerFunction.indexOf("messageRoot.getAttribute?.('data-message-id')"),
    );
    expect(ownerFunction.indexOf("turn.getAttribute?.('data-turn-id-container')")).toBeLessThan(
      ownerFunction.indexOf("messageRoot.getAttribute?.('data-message-id')"),
    );
    expect(ownerFunction).toContain("!/^request-web:/i.test(candidate)");
    expect(ownerFunction).toContain("!/^conversation-turn-\\d+$/i.test(candidate)");
    expect(ownerFunction).toContain("if (!messageRoot) return null");
    expect(conversationRecordExpressions).toHaveLength(2);
    expect(conversationRecordExpressions[0]).toContain(
      'const expectedMessageId = "message-current"',
    );
    expect(conversationRecordExpressions[0]).toContain(
      'const expectedUserMessageId = "user-message-current"',
    );
    expect(conversationRecordExpressions).toEqual(
      conversationRecordExpressions.filter((expression) =>
        expression.includes('const expectedMessageId = "message-current"'),
      ),
    );
    const citationCalls = mockClient.send.mock.calls.filter(
      ([method, params, sessionId]) =>
        method === "Runtime.evaluate" &&
        sessionId === "current-session" &&
        String((params as { expression?: string })?.expression).includes(
          "oracle-deep-research-citation-sources",
        ),
    );
    expect(citationCalls).toHaveLength(2);
    expect(
      citationCalls.every(([, params]) => (params as { contextId?: number }).contextId === 31),
    ).toBe(true);
    expect(mockClient.send).toHaveBeenCalledWith("Runtime.disable", {}, "current-session");
  });

  it("prefers a completed page target over an earlier in-progress one", async () => {
    // A page can expose more than one Deep Research iframe target (e.g. a stale
    // in-progress one attached before the completed report). Scanning must not
    // return the first in-progress target and miss the later completed OOPIF.
    mockRuntime.evaluate.mockResolvedValue({
      result: {
        value: {
          finished: false,
          stopVisible: false,
          textLength: 0,
          hasIframe: true,
          hasActiveScopedResearch: false,
          conversationId: "conversation-id",
        },
      },
    });

    const listeners = new Map<string, (params: unknown, sessionId?: string) => void>();
    const deepResearchUrl =
      "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/";

    const mockClient = {
      on: vi.fn((event: string, listener: (params: unknown, sessionId?: string) => void) => {
        listeners.set(event, listener);
      }),
      removeListener: vi.fn(),
      send: vi.fn(async (method: string, params?: unknown, sessionId?: string) => {
        if (method === "Target.setAutoAttach" && (params as { autoAttach?: boolean })?.autoAttach) {
          // In-progress target attaches FIRST, completed target SECOND.
          listeners.get("Target.attachedToTarget")?.({
            sessionId: "incomplete-session",
            targetInfo: { type: "iframe", url: deepResearchUrl },
          });
          listeners.get("Target.attachedToTarget")?.({
            sessionId: "complete-session",
            targetInfo: { type: "iframe", url: deepResearchUrl },
          });
          return {};
        }
        if (method === "Page.getFrameTree") {
          return {
            frameTree: { frame: { id: `${sessionId}-frame`, name: "root", url: deepResearchUrl } },
          };
        }
        if (method === "Page.createIsolatedWorld") {
          return { executionContextId: sessionId === "complete-session" ? 22 : 11 };
        }
        if (method === "DOM.getFrameOwner") return { backendNodeId: 7 };
        if (method === "DOM.resolveNode") return { object: { objectId: "current-owner" } };
        if (method === "Runtime.callFunctionOn") {
          return {
            result: {
              value: { messageId: "message-current", turnIndex: 1 },
            },
          };
        }
        if (
          method === "Runtime.evaluate" &&
          String((params as { expression?: string })?.expression).includes(
            "oracle-deep-research-conversation-record-metadata",
          )
        ) {
          return {
            result: {
              value: {
                messageId: "message-current",
                finalMessageId: "message-current-final",
                modelSlug: "gpt-5-5-instant",
                resolvedModelSlug: "gpt-5-5-instant",
                defaultModelSlug: "gpt-5-6-pro",
                deepResearchVersion: "standard",
                metadataSource: "chatgpt-conversation-record",
              },
            },
          };
        }
        if (method === "Runtime.evaluate" && sessionId === "complete-session") {
          return {
            result: {
              value: {
                completed: true,
                inProgress: false,
                textLength: 80,
                text: "REPORT_OK https://example.com/report",
              },
            },
          };
        }
        if (method === "Runtime.evaluate" && sessionId === "incomplete-session") {
          return {
            result: {
              value: { completed: false, inProgress: true, textLength: 12, text: undefined },
            },
          };
        }
        return {};
      }),
    };

    // Bound the loop so a future regression (returning the in-progress target)
    // fails fast via timeout instead of spinning.
    let nowCalls = 0;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      nowCalls += 1;
      return nowCalls < 12 ? 1_000 : 2_000;
    });
    try {
      const result = await waitForDeepResearchCompletion(
        mockRuntime as never,
        mockLogger,
        100,
        1,
        undefined,
        mockClient as never,
        {
          expectedConversationId: "conversation-id",
          expectedUserMessageId: "user-message",
        },
      );
      expect(result.text).toBe("REPORT_OK https://example.com/report");
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it.each([
    ["empty", { completed: false, inProgress: false, textLength: 0 }],
    ["in-progress", { completed: false, inProgress: true, textLength: 12 }],
  ])("does not let a later %s target mask a completed report", async (_label, laterStatus) => {
    mockRuntime.evaluate.mockResolvedValue({
      result: {
        value: {
          finished: false,
          stopVisible: false,
          textLength: 0,
          hasIframe: true,
          hasActiveScopedResearch: false,
          conversationId: "conversation-id",
        },
      },
    });

    const listeners = new Map<string, (params: unknown, sessionId?: string) => void>();
    const deepResearchUrl =
      "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/";
    const mockClient = {
      on: vi.fn((event: string, listener: (params: unknown, sessionId?: string) => void) => {
        listeners.set(event, listener);
      }),
      removeListener: vi.fn(),
      send: vi.fn(async (method: string, params?: unknown, sessionId?: string) => {
        if (method === "Target.setAutoAttach" && (params as { autoAttach?: boolean })?.autoAttach) {
          listeners.get("Target.attachedToTarget")?.({
            sessionId: "complete-session",
            targetInfo: { targetId: "complete-target", type: "iframe", url: deepResearchUrl },
          });
          listeners.get("Target.attachedToTarget")?.({
            sessionId: "empty-session",
            targetInfo: { targetId: "empty-target", type: "iframe", url: deepResearchUrl },
          });
          return {};
        }
        if (method === "Page.getFrameTree") {
          return {
            frameTree: { frame: { id: `${sessionId}-frame`, name: "root", url: deepResearchUrl } },
          };
        }
        if (method === "DOM.getFrameOwner") return { backendNodeId: 7 };
        if (method === "DOM.resolveNode") return { object: { objectId: "current-owner" } };
        if (method === "Runtime.callFunctionOn") {
          return {
            result: {
              value: { messageId: "message-current", turnIndex: 1 },
            },
          };
        }
        if (
          method === "Runtime.evaluate" &&
          String((params as { expression?: string })?.expression).includes(
            "oracle-deep-research-conversation-record-metadata",
          )
        ) {
          return {
            result: {
              value: {
                messageId: "message-current",
                finalMessageId: "message-current-final",
                modelSlug: "gpt-5-5-instant",
                resolvedModelSlug: "gpt-5-5-instant",
                defaultModelSlug: "gpt-5-6-pro",
                deepResearchVersion: "standard",
                metadataSource: "chatgpt-conversation-record",
              },
            },
          };
        }
        if (method === "Runtime.evaluate" && sessionId === "complete-session") {
          return {
            result: {
              value: {
                completed: true,
                inProgress: false,
                textLength: 80,
                text: "REPORT_OK https://example.com/report",
              },
            },
          };
        }
        if (method === "Runtime.evaluate" && sessionId === "empty-session") {
          return { result: { value: laterStatus } };
        }
        return {};
      }),
    };

    const result = await waitForDeepResearchCompletion(
      mockRuntime as never,
      mockLogger,
      60_000,
      1,
      undefined,
      mockClient as never,
      {
        expectedConversationId: "conversation-id",
        expectedUserMessageId: "user-message",
      },
    );

    expect(result.text).toBe("REPORT_OK https://example.com/report");
  });

  it("falls back to a completed in-page frame when the target read is only in-progress", async () => {
    // Legacy/inline rendering: the target-attach read is in-progress, but the
    // in-page frame path has a completed report. An incomplete target read must
    // not suppress the frame fallback.
    mockRuntime.evaluate.mockImplementation(async (params?: { contextId?: number }) => {
      if (params?.contextId === 77) {
        return {
          result: {
            value: {
              completed: true,
              inProgress: false,
              textLength: 80,
              text: "FRAME_REPORT https://example.com/report",
            },
          },
        };
      }
      return {
        result: {
          value: { finished: false, stopVisible: false, textLength: 0, hasIframe: true },
        },
      };
    });

    const listeners = new Map<string, (params: unknown, sessionId?: string) => void>();
    const deepResearchUrl =
      "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/";

    // Target-attach path returns an in-progress read (no completed target).
    const mockClient = {
      on: vi.fn((event: string, listener: (params: unknown, sessionId?: string) => void) => {
        listeners.set(event, listener);
      }),
      removeListener: vi.fn(),
      send: vi.fn(async (method: string, params?: unknown, sessionId?: string) => {
        if (method === "Target.setAutoAttach" && (params as { autoAttach?: boolean })?.autoAttach) {
          listeners.get("Target.attachedToTarget")?.({
            sessionId: "t-session",
            targetInfo: { type: "iframe", url: deepResearchUrl },
          });
          return {};
        }
        if (method === "Page.getFrameTree") {
          return {
            frameTree: { frame: { id: "t-frame", name: "root", url: deepResearchUrl } },
          };
        }
        if (method === "Page.createIsolatedWorld") {
          return { executionContextId: 33 };
        }
        if (method === "Runtime.evaluate" && sessionId === "t-session") {
          return {
            result: {
              value: { completed: false, inProgress: true, textLength: 15, text: undefined },
            },
          };
        }
        return {};
      }),
    };

    // In-page frame path has the completed report (isolated world contextId 77).
    const mockPage = {
      getFrameTree: vi.fn().mockResolvedValue({
        frameTree: {
          frame: { id: "root", url: "https://chatgpt.com/" },
          childFrames: [{ frame: { id: "deep-frame", url: deepResearchUrl } }],
        },
      }),
      createIsolatedWorld: vi.fn().mockResolvedValue({ executionContextId: 77 }),
    };

    // Unscoped run so the frame-completed result is not gated by the main-DOM
    // hasActiveScopedResearch heuristic (this is the legacy inline path).
    // Date.now bound so a future regression (frame fallback suppressed) fails
    // fast via timeout instead of spinning.
    let nowCalls = 0;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      nowCalls += 1;
      return nowCalls < 12 ? 1_000 : 2_000;
    });
    try {
      const result = await waitForDeepResearchCompletion(
        mockRuntime as never,
        mockLogger,
        100,
        undefined,
        mockPage as never,
        mockClient as never,
      );
      expect(result.text).toBe("FRAME_REPORT https://example.com/report");
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("returns a scoped report when ChatGPT reuses the pre-submission OOPIF target", async () => {
    // Regression: ChatGPT renders the Deep Research report inside an
    // out-of-process iframe that is invisible to the main page's frame tree.
    // The main-DOM poll therefore shows no assistant turn and
    // hasActiveScopedResearch=false, while the target-attach path reads the
    // completed report directly. ChatGPT may create this OOPIF as soon as Deep
    // Research is selected, so its target id can already be in the pre-submit
    // baseline. The target must be reconsidered, but only the successful
    // current-turn owner lookup may authorize returning its report.
    mockRuntime.evaluate.mockResolvedValue({
      result: {
        value: {
          finished: false,
          stopVisible: false,
          textLength: 0,
          hasIframe: true,
          hasActiveScopedResearch: false,
          conversationId: "conversation-id",
        },
      },
    });

    const listeners = new Map<string, (params: unknown, sessionId?: string) => void>();
    const mockClient = {
      on: vi.fn((event: string, listener: (params: unknown, sessionId?: string) => void) => {
        listeners.set(event, listener);
      }),
      removeListener: vi.fn(),
      send: vi.fn(async (method: string, params?: unknown, sessionId?: string) => {
        if (method === "Target.setAutoAttach") {
          listeners.get("Target.attachedToTarget")?.({
            sessionId: "deep-session",
            targetInfo: {
              targetId: "reused-deep-target",
              type: "iframe",
              url: "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/",
            },
          });
          return {};
        }
        if (method === "Target.getTargets") {
          return { targetInfos: [] };
        }
        if (method === "Page.getFrameTree" && sessionId === "deep-session") {
          return {
            frameTree: {
              frame: {
                id: "sandbox",
                url: "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/",
              },
              // Production shape observed 2026-07-20: the confirmed connector
              // OOPIF is an empty shell and the report app is rendered in an
              // unnamed about:blank child frame.
              childFrames: [{ frame: { id: "root-frame", url: "about:blank" } }],
            },
          };
        }
        if (method === "Page.createIsolatedWorld" && sessionId === "deep-session") {
          return {
            executionContextId: (params as { frameId?: string }).frameId === "root-frame" ? 12 : 11,
          };
        }
        if (method === "DOM.getFrameOwner") return { backendNodeId: 7 };
        if (method === "DOM.resolveNode") return { object: { objectId: "current-owner" } };
        if (method === "Runtime.callFunctionOn") {
          return {
            result: {
              value: {
                messageId: "message-deep",
                turnId: "conversation-turn-2",
                turnIndex: 1,
                modelSlug: "gpt-5-6-pro",
              },
            },
          };
        }
        if (
          method === "Runtime.evaluate" &&
          (params as { expression?: string }).expression?.includes(
            "oracle-deep-research-conversation-record-metadata",
          )
        ) {
          return {
            result: {
              value: {
                messageId: "message-deep",
                finalMessageId: "final-message-deep",
                modelSlug: "gpt-5-5-instant",
                resolvedModelSlug: "gpt-5-5-instant",
                defaultModelSlug: "gpt-5-6-pro",
                deepResearchVersion: "standard",
                metadataSource: "chatgpt-conversation-record",
              },
            },
          };
        }
        if (
          method === "Runtime.evaluate" &&
          sessionId === "deep-session" &&
          (params as { contextId?: number }).contextId === 12
        ) {
          return {
            result: {
              value: {
                completed: true,
                inProgress: false,
                textLength: 80,
                text: "OOPIF_REPORT https://example.com/report",
              },
            },
          };
        }
        return {};
      }),
    };

    // Main page frame tree exposes no Deep Research frame (the OOPIF is hidden),
    // so the in-page frame path can never find the report on its own.
    const mockPage = {
      getFrameTree: vi.fn().mockResolvedValue({
        frameTree: {
          frame: { id: "root", url: "https://chatgpt.com/" },
          childFrames: [{ frame: { id: "blank", url: "about:blank" } }],
        },
      }),
      createIsolatedWorld: vi.fn(),
    };

    const result = await waitForDeepResearchCompletion(
      mockRuntime as never,
      mockLogger,
      60_000,
      1,
      mockPage as never,
      mockClient as never,
      {
        targetBaseline: [{ targetId: "reused-deep-target", completed: false }],
        targetBaselineCaptured: true,
        expectedConversationId: "conversation-id",
        expectedUserMessageId: "user-message",
      },
    );

    expect(result.text).toBe("OOPIF_REPORT https://example.com/report");
    expect(result.assistantTurn).toMatchObject({
      messageId: "message-deep",
      turnId: "conversation-turn-2",
      turnIndex: 1,
      modelSlug: "gpt-5-5-instant",
      responseSha256: createHash("sha256")
        .update("OOPIF_REPORT https://example.com/report")
        .digest("hex"),
    });
    expect(mockClient.send).toHaveBeenCalledWith(
      "DOM.getFrameOwner",
      { frameId: "sandbox" },
      undefined,
    );
    expect(mockClient.send).toHaveBeenCalledWith(
      "Page.createIsolatedWorld",
      expect.objectContaining({ frameId: "root-frame" }),
      "deep-session",
    );
  });

  it("does not complete from an unscoped frame result during a scoped run", async () => {
    mockRuntime.evaluate.mockImplementation(async (params?: { contextId?: number }) => {
      if (typeof params?.contextId === "number") {
        return {
          result: {
            value: {
              completed: true,
              inProgress: false,
              textLength: 80,
              text: "OLD_REPORT_SHOULD_NOT_BE_RETURNED https://example.com/report",
            },
          },
        };
      }
      return {
        result: {
          value: {
            finished: false,
            stopVisible: false,
            textLength: 0,
            hasIframe: true,
            conversationId: "conversation-id",
          },
        },
      };
    });
    const mockPage = {
      getFrameTree: vi.fn().mockResolvedValue({
        frameTree: {
          frame: { id: "root", url: "https://chatgpt.com/" },
          childFrames: [
            {
              frame: {
                id: "old-deep-frame",
                url: "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/",
              },
            },
          ],
        },
      }),
      createIsolatedWorld: vi.fn().mockResolvedValue({ executionContextId: 42 }),
    };
    const mockClient = createFrameOwnerClient(0);
    let nowCalls = 0;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      nowCalls += 1;
      return nowCalls < 6 ? 1_000 : 2_000;
    });

    try {
      await expect(
        waitForDeepResearchCompletion(
          mockRuntime as never,
          mockLogger,
          100,
          1,
          mockPage as never,
          mockClient as never,
          {
            expectedConversationId: "conversation-id",
            expectedUserMessageId: "user-message",
          },
        ),
      ).rejects.toThrow(/did not complete/);
      expect(mockPage.createIsolatedWorld).not.toHaveBeenCalled();
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("fails closed instead of using the legacy frame fallback during a scoped run", async () => {
    mockRuntime.evaluate.mockImplementation(async (params?: { contextId?: number }) => {
      if (typeof params?.contextId === "number") {
        return {
          result: {
            value: {
              completed: true,
              inProgress: false,
              textLength: 80,
              text: "FRESH_REPORT https://example.com/report",
            },
          },
        };
      }
      return {
        result: {
          value: {
            finished: false,
            stopVisible: false,
            textLength: 0,
            hasIframe: true,
            hasActiveScopedResearch: true,
            conversationId: "conversation-id",
          },
        },
      };
    });
    const mockPage = {
      getFrameTree: vi.fn().mockResolvedValue({
        frameTree: {
          frame: { id: "root", url: "https://chatgpt.com/" },
          childFrames: [
            {
              frame: {
                id: "old-deep-frame",
                url: "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/old",
              },
            },
            {
              frame: {
                id: "fresh-deep-frame",
                url: "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/",
              },
            },
          ],
        },
      }),
      createIsolatedWorld: vi.fn().mockResolvedValue({ executionContextId: 42 }),
    };
    const mockClient = createFrameOwnerClient((frameId) =>
      frameId === "fresh-deep-frame"
        ? { messageId: "message-fresh", turnIndex: 1 }
        : { messageId: "message-old", turnIndex: 0 },
    );

    let nowCalls = 0;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      nowCalls += 1;
      return nowCalls < 8 ? 1_000 : 2_000;
    });
    try {
      await expect(
        waitForDeepResearchCompletion(
          mockRuntime as never,
          mockLogger,
          100,
          1,
          mockPage as never,
          mockClient as never,
          {
            expectedConversationId: "conversation-id",
            expectedUserMessageId: "user-message",
          },
        ),
      ).rejects.toThrow(/did not complete/);
      expect(mockPage.createIsolatedWorld).not.toHaveBeenCalled();
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("does not fall back to an older completed turn when scoped to new turns", () => {
    const expression = buildDeepResearchCompletionPollExpressionForTest(2);
    const priorFinishedTurn = {
      textContent: "Earlier complete Deep Research report with enough text to look finished.",
      querySelector: () => ({}),
    };
    const result = new vm.Script(expression).runInNewContext({
      document: {
        querySelector: () => null,
        querySelectorAll: (selector: string) => {
          if (selector === "iframe") return [];
          if (selector === '[data-message-author-role="assistant"]') {
            return [priorFinishedTurn];
          }
          return [];
        },
      },
    }) as { finished?: boolean; textLength?: number; isToolStub?: boolean };

    expect(result.finished).toBe(false);
    expect(result.textLength).toBe(0);
    expect(result.isToolStub).toBe(false);
  });

  it("fails before polling when the pre-submission target baseline was unavailable", async () => {
    await expect(
      waitForDeepResearchCompletion(
        mockRuntime as never,
        mockLogger,
        100,
        1,
        undefined,
        undefined,
        { targetBaselineCaptured: false },
      ),
    ).rejects.toMatchObject({
      details: { code: "deep-research-target-baseline-unavailable" },
    });
    expect(mockRuntime.evaluate).not.toHaveBeenCalled();
  });

  it("fails before polling when a scoped run has no pinned conversation ID", async () => {
    await expect(
      waitForDeepResearchCompletion(
        mockRuntime as never,
        mockLogger,
        100,
        1,
        undefined,
        undefined,
        { targetBaselineCaptured: true },
      ),
    ).rejects.toMatchObject({
      details: { code: "deep-research-conversation-unavailable" },
    });
    expect(mockRuntime.evaluate).not.toHaveBeenCalled();
  });

  it("fails before polling when a scoped run lacks the exact submitted user message ID", async () => {
    await expect(
      waitForDeepResearchCompletion(
        mockRuntime as never,
        mockLogger,
        100,
        1,
        undefined,
        undefined,
        {
          targetBaselineCaptured: true,
          expectedConversationId: "conversation-id",
        },
      ),
    ).rejects.toMatchObject({
      details: { code: "deep-research-user-turn-unavailable" },
    });
    expect(mockRuntime.evaluate).not.toHaveBeenCalled();
  });

  it("fails closed when the page leaves the pinned Deep Research conversation", async () => {
    mockRuntime.evaluate.mockResolvedValue({
      result: {
        value: {
          finished: false,
          stopVisible: false,
          textLength: 0,
          conversationId: "conversation-b",
        },
      },
    });

    await expect(
      waitForDeepResearchCompletion(
        mockRuntime as never,
        mockLogger,
        100,
        1,
        undefined,
        undefined,
        {
          targetBaselineCaptured: true,
          expectedConversationId: "conversation-a",
          expectedUserMessageId: "user-message",
        },
      ),
    ).rejects.toMatchObject({
      details: {
        code: "deep-research-conversation-changed",
        expectedConversationId: "conversation-a",
        observedConversationId: "conversation-b",
      },
    });
  });

  it("retries an empty progress evaluation instead of reporting a conversation change", async () => {
    mockRuntime.evaluate
      .mockResolvedValueOnce({
        result: {},
        exceptionDetails: { text: "Execution context was destroyed" },
      })
      .mockResolvedValue({
        result: {
          value: {
            finished: false,
            stopVisible: true,
            textLength: 500,
            hasIframe: true,
            conversationId: "conversation-id",
          },
        },
      });

    await expect(
      waitForDeepResearchCompletion(
        mockRuntime as never,
        mockLogger,
        100,
        1,
        undefined,
        undefined,
        {
          targetBaselineCaptured: true,
          expectedConversationId: "conversation-id",
          expectedUserMessageId: "user-message",
        },
      ),
    ).rejects.toMatchObject({ details: { code: "deep-research-timeout" } });
    expect(mockLogger).toHaveBeenCalledWith(
      "Deep Research progress probe was temporarily unavailable; retrying.",
    );
  });

  it("throws on timeout with metadata", async () => {
    // All polls: never completed
    mockRuntime.evaluate.mockResolvedValue({
      result: {
        value: { finished: false, stopVisible: true, textLength: 500, hasIframe: true },
      },
    });

    // Use very short timeout
    await expect(
      waitForDeepResearchCompletion(mockRuntime as never, mockLogger, 100),
    ).rejects.toThrow(/did not complete/);
  });
});

describe("checkDeepResearchStatus", () => {
  let mockRuntime: ReturnType<typeof createMockRuntime>;
  let mockLogger: BrowserLogger;

  beforeEach(() => {
    mockRuntime = createMockRuntime();
    mockLogger = createMockLogger();
  });

  it("reports completed when finished actions visible", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: {
          completed: true,
          inProgress: false,
          hasIframe: false,
          textLength: 5000,
          placeholderOnly: false,
        },
      },
    });
    const status = await checkDeepResearchStatus(mockRuntime as never, mockLogger);
    expect(status.completed).toBe(true);
    expect(status.inProgress).toBe(false);
    expect(status.textLength).toBe(5000);
    expect(status.placeholderOnly).toBe(false);
  });

  it("reports in-progress when iframe present", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: { completed: false, inProgress: true, hasIframe: true, textLength: 0 },
      },
    });
    const status = await checkDeepResearchStatus(mockRuntime as never, mockLogger);
    expect(status.completed).toBe(false);
    expect(status.inProgress).toBe(true);
    expect(status.hasIframe).toBe(true);
  });

  it("handles undefined result gracefully", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: { value: undefined },
    });
    const status = await checkDeepResearchStatus(mockRuntime as never, mockLogger);
    expect(status.completed).toBe(false);
    expect(status.inProgress).toBe(false);
    expect(status.textLength).toBe(0);
    expect(status.placeholderOnly).toBe(false);
  });

  it("does not report completed for a tool-only Deep Research placeholder", () => {
    const expression = buildDeepResearchStatusExpressionForTest();
    const assistantTurn = {
      textContent: "Called tool",
      querySelector: () => ({}),
    };
    const result = new vm.Script(expression).runInNewContext({
      document: {
        querySelector: (selector: string) => (selector.includes("copy") ? {} : null),
        querySelectorAll: (selector: string) => {
          if (selector === "iframe") return [];
          if (selector === '[data-message-author-role="assistant"]') return [assistantTurn];
          return [];
        },
      },
    }) as { completed?: boolean; placeholderOnly?: boolean; textLength?: number };

    expect(result.completed).toBe(false);
    expect(result.placeholderOnly).toBe(true);
    expect(result.textLength).toBe("Called tool".length);
  });

  it("does not report completed for a Deep Research planning panel", () => {
    const expression = buildDeepResearchCompletionPollExpressionForTest();
    const assistantTurn = {
      textContent:
        "project root-cause analysis\nUpdate\nInspect the adapter.\nDetermining steps for creating a report...\nStop research",
      querySelector: () => ({}),
    };
    const result = new vm.Script(expression).runInNewContext({
      document: {
        body: { innerText: assistantTurn.textContent },
        querySelector: () => null,
        querySelectorAll: (selector: string) => {
          if (selector === "iframe") return [];
          if (selector.includes("data-message-author-role")) return [assistantTurn];
          return [];
        },
      },
    }) as { finished?: boolean; incompleteResult?: boolean };

    expect(result.finished).toBe(false);
    expect(result.incompleteResult).toBe(true);
  });

  it("keeps short scoped iframe turns active", () => {
    const expression = buildDeepResearchCompletionPollExpressionForTest(0);
    const iframe = {
      getBoundingClientRect: () => ({ width: 800, height: 600 }),
      getAttribute: (name: string) =>
        name === "src"
          ? "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/"
          : null,
    };
    const assistantTurn = {
      textContent: "ChatGPT said:",
      innerText: "ChatGPT said:",
      dataset: {},
      getAttribute: (name: string) => (name === "data-message-author-role" ? "assistant" : null),
      querySelector: () => null,
      querySelectorAll: (selector: string) => (selector === "iframe" ? [iframe] : []),
    };
    const result = new vm.Script(expression).runInNewContext({
      document: {
        body: { innerText: assistantTurn.textContent },
        querySelector: () => null,
        querySelectorAll: (selector: string) => {
          if (selector === "iframe") {
            return [iframe];
          }
          if (selector.includes("conversation-turn")) return [assistantTurn];
          if (selector.includes("data-message-author-role")) return [assistantTurn];
          return [];
        },
      },
    }) as { hasActiveScopedResearch?: boolean };

    expect(result.hasActiveScopedResearch).toBe(true);
  });

  it("does not treat a page-global stale iframe as scoped activity", () => {
    const expression = buildDeepResearchCompletionPollExpressionForTest(0);
    const iframe = {
      getBoundingClientRect: () => ({ width: 800, height: 600 }),
      getAttribute: (name: string) =>
        name === "src"
          ? "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/old"
          : null,
    };
    const assistantTurn = {
      textContent: "ChatGPT said:",
      innerText: "ChatGPT said:",
      dataset: {},
      getAttribute: (name: string) => (name === "data-message-author-role" ? "assistant" : null),
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    const result = new vm.Script(expression).runInNewContext({
      document: {
        body: { innerText: assistantTurn.textContent },
        querySelector: () => null,
        querySelectorAll: (selector: string) => {
          if (selector === "iframe") return [iframe];
          if (selector.includes("conversation-turn")) return [assistantTurn];
          if (selector.includes("data-message-author-role")) return [assistantTurn];
          return [];
        },
      },
    }) as { hasActiveScopedResearch?: boolean };

    expect(result.hasActiveScopedResearch).toBe(false);
  });

  it("does not treat a bare tool stub as Deep Research evidence", () => {
    const expression = buildDeepResearchCompletionPollExpressionForTest(0);
    const staleIframe = {
      getBoundingClientRect: () => ({ width: 800, height: 600 }),
      getAttribute: (name: string) =>
        name === "src"
          ? "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/old"
          : null,
    };
    const assistantTurn = {
      textContent: "Called tool",
      innerText: "Called tool",
      dataset: {},
      getAttribute: (name: string) => (name === "data-message-author-role" ? "assistant" : null),
      querySelector: () => null,
    };
    const result = new vm.Script(expression).runInNewContext({
      document: {
        body: { innerText: assistantTurn.textContent },
        querySelector: () => null,
        querySelectorAll: (selector: string) => {
          if (selector === "iframe") return [staleIframe];
          if (selector.includes("conversation-turn")) return [assistantTurn];
          if (selector.includes("data-message-author-role")) return [assistantTurn];
          return [];
        },
      },
    }) as { researchActivity?: boolean; hasActiveScopedResearch?: boolean };

    expect(result.researchActivity).toBe(false);
    expect(result.hasActiveScopedResearch).toBe(false);
  });

  it("detects ChatGPT account security blocks during completion polling", () => {
    const expression = buildDeepResearchCompletionPollExpressionForTest(1);
    const result = new vm.Script(expression).runInNewContext({
      document: {
        body: {
          innerText:
            "Suspicious activity detected. Please secure your account to regain access to all features.",
        },
        querySelector: () => null,
        querySelectorAll: (selector: string) => {
          if (selector === "iframe") return [];
          if (selector === '[data-message-author-role="assistant"], [data-turn="assistant"]') {
            return [];
          }
          return [];
        },
      },
    }) as { accountBlocked?: boolean };

    expect(result.accountBlocked).toBe(true);
  });

  it("scopes completion actions to the latest assistant turn", () => {
    const expression = buildDeepResearchStatusExpressionForTest();
    const priorFinishedTurn = {
      textContent: "Earlier complete answer with enough text to look finished.",
      querySelector: () => ({}),
    };
    const currentResearchTurn = {
      textContent:
        "Researching current browser support and collecting citations, but not complete yet.",
      querySelector: () => null,
    };
    const result = new vm.Script(expression).runInNewContext({
      document: {
        querySelector: (selector: string) => (selector.includes("copy") ? {} : null),
        querySelectorAll: (selector: string) => {
          if (selector === "iframe") return [];
          if (selector === '[data-message-author-role="assistant"]') {
            return [priorFinishedTurn, currentResearchTurn];
          }
          return [];
        },
      },
    }) as { completed?: boolean; placeholderOnly?: boolean; textLength?: number };

    expect(result.completed).toBe(false);
    expect(result.placeholderOnly).toBe(false);
    expect(result.textLength).toBe(currentResearchTurn.textContent.length);
  });
});
