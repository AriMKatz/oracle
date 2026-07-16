import { createHash, randomBytes } from "node:crypto";
import type { BrowserAssistantTurnEvidence } from "../../sessionStore.js";
import type { ChromeClient, BrowserLogger } from "../types.js";
import {
  ASSISTANT_ROLE_SELECTOR,
  DEEP_RESEARCH_PLUS_BUTTON,
  DEEP_RESEARCH_DROPDOWN_ITEM_TEXT,
  DEEP_RESEARCH_PILL_LABEL,
  DEEP_RESEARCH_POLL_INTERVAL_MS,
  DEEP_RESEARCH_AUTO_CONFIRM_WAIT_MS,
  DEEP_RESEARCH_DEFAULT_TIMEOUT_MS,
  FINISHED_ACTIONS_SELECTOR,
  STOP_BUTTON_SELECTOR,
} from "../constants.js";
import { buildConversationTurnListExpression } from "../conversationTurns.js";
import { delay } from "../utils.js";
import { isDeepResearchIncompleteText } from "../deepResearchResult.js";
import { buildClickDispatcher } from "./domEvents.js";
import { captureAssistantMarkdown, readAssistantSnapshot } from "./assistantResponse.js";
import { BrowserAutomationError } from "../../oracle/errors.js";

type ActivateOutcome =
  | { status: "activated" }
  | { status: "already-active" }
  | { status: "plus-button-missing" }
  | { status: "dropdown-item-missing"; available?: string[] }
  | { status: "pill-not-confirmed"; clickPoint?: { x?: number; y?: number } };

export interface DeepResearchTurnMetadata {
  messageId?: string | null;
  finalMessageId?: string | null;
  turnId?: string | null;
  turnIndex?: number | null;
  modelSlug?: string | null;
  resolvedModelSlug?: string | null;
  defaultModelSlug?: string | null;
  deepResearchVersion?: string | null;
  metadataSource?: "chatgpt-conversation-record";
}

export interface DeepResearchCitationStatus {
  total: number;
  linked: number;
  missingIndexes: number[];
}

export interface DeepResearchTargetBaseline {
  targetId: string;
  /** null means the target was confirmed but its report state was unreadable. */
  completed: boolean | null;
  contentSha256?: string;
}

export interface DeepResearchCompletionResult {
  text: string;
  html?: string;
  meta: DeepResearchTurnMetadata;
  assistantTurn?: BrowserAssistantTurnEvidence;
  citationStatus?: DeepResearchCitationStatus;
}

export interface DeepResearchSubmittedUserTurn {
  messageId: string;
  turnIndex: number;
}

function normalizeDeepResearchTurnMetadata(value: unknown): DeepResearchTurnMetadata | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return { turnIndex: Math.floor(value) };
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as DeepResearchTurnMetadata;
  const normalizeString = (input: unknown): string | null =>
    typeof input === "string" ? input.trim() || null : null;
  const messageId = normalizeString(raw.messageId);
  const finalMessageId = normalizeString(raw.finalMessageId);
  const turnId = normalizeString(raw.turnId);
  const turnIndex =
    typeof raw.turnIndex === "number" && Number.isFinite(raw.turnIndex) && raw.turnIndex >= 0
      ? Math.floor(raw.turnIndex)
      : null;
  const modelSlug = normalizeString(raw.modelSlug);
  const resolvedModelSlug = normalizeString(raw.resolvedModelSlug);
  const defaultModelSlug = normalizeString(raw.defaultModelSlug);
  const deepResearchVersion = normalizeString(raw.deepResearchVersion);
  const metadataSource =
    raw.metadataSource === "chatgpt-conversation-record" ? raw.metadataSource : undefined;
  if (
    !messageId &&
    !finalMessageId &&
    !turnId &&
    turnIndex === null &&
    !modelSlug &&
    !resolvedModelSlug &&
    !defaultModelSlug &&
    !deepResearchVersion &&
    !metadataSource
  ) {
    return null;
  }
  return {
    messageId,
    turnId,
    turnIndex,
    modelSlug,
    ...(finalMessageId ? { finalMessageId } : {}),
    ...(resolvedModelSlug ? { resolvedModelSlug } : {}),
    ...(defaultModelSlug ? { defaultModelSlug } : {}),
    ...(deepResearchVersion ? { deepResearchVersion } : {}),
    ...(metadataSource ? { metadataSource } : {}),
  };
}

function buildDeepResearchAssistantTurnEvidence(
  meta: DeepResearchTurnMetadata | null | undefined,
  reportMarkdown: string,
): BrowserAssistantTurnEvidence | undefined {
  const normalized = normalizeDeepResearchTurnMetadata(meta);
  const messageId = normalized?.messageId?.trim() || undefined;
  const turnId = normalized?.turnId?.trim() || undefined;
  const turnIndex = typeof normalized?.turnIndex === "number" ? normalized.turnIndex : undefined;
  const modelSlug = normalized?.modelSlug?.trim() || undefined;

  // A hash alone is not provenance. Require both a concrete conversation-turn
  // position and an identity attribute from the exact iframe owner before
  // emitting evidence. The model slug stays optional so callers can fail closed
  // without discarding an otherwise useful, correctly bound report.
  if (turnIndex === undefined || (!messageId && !turnId)) {
    return undefined;
  }
  return {
    messageId,
    finalMessageId: normalized?.finalMessageId?.trim() || undefined,
    turnId,
    turnIndex,
    modelSlug,
    resolvedModelSlug: normalized?.resolvedModelSlug?.trim() || undefined,
    defaultModelSlug: normalized?.defaultModelSlug?.trim() || undefined,
    deepResearchVersion: normalized?.deepResearchVersion?.trim() || undefined,
    metadataSource: normalized?.metadataSource,
    responseSha256: createHash("sha256").update(reportMarkdown.trim()).digest("hex"),
    capturedAt: new Date().toISOString(),
  };
}

function finalizeDeepResearchResult(
  text: string,
  html: string | undefined,
  meta: DeepResearchTurnMetadata | null | undefined,
  citationStatus?: DeepResearchCitationStatus,
): DeepResearchCompletionResult {
  const normalizedMeta = normalizeDeepResearchTurnMetadata(meta) ?? {};
  return {
    text,
    html,
    meta: normalizedMeta,
    assistantTurn: buildDeepResearchAssistantTurnEvidence(normalizedMeta, text),
    citationStatus,
  };
}

/**
 * Activates Deep Research mode through ChatGPT's composer tools menu and
 * verifies the selected tool pill before prompt submission.
 */
export async function activateDeepResearch(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
  logger: BrowserLogger,
): Promise<void> {
  const expression = buildActivateDeepResearchExpression();
  const outcome = await Runtime.evaluate({
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const result = outcome.result?.value as ActivateOutcome | undefined;

  switch (result?.status) {
    case "activated":
      logger("Deep Research mode activated");
      return;
    case "already-active":
      logger("Deep Research mode already active");
      return;
    case "plus-button-missing":
      throw new BrowserAutomationError(
        "Could not find the composer plus button to activate Deep Research.",
        { stage: "deep-research-activate", code: "plus-button-missing" },
      );
    case "dropdown-item-missing": {
      const hint = result.available?.length
        ? ` Available options: ${result.available.join(", ")}`
        : "";
      throw new BrowserAutomationError(
        `"Deep research" option not found in composer dropdown.${hint} ` +
          "This feature may require a ChatGPT Plus or Pro subscription.",
        { stage: "deep-research-activate", code: "dropdown-item-missing" },
      );
    }
    case "pill-not-confirmed": {
      const point = result.clickPoint;
      if (typeof point?.x === "number" && typeof point.y === "number") {
        await clickTrustedPoint(Runtime, Input, point.x, point.y);
        if (await waitForDeepResearchPill(Runtime)) {
          logger("Deep Research mode activated");
          return;
        }
      }
      throw new BrowserAutomationError(
        "Deep Research pill did not appear after selection. The UI may have changed.",
        { stage: "deep-research-activate", code: "pill-not-confirmed" },
      );
    }
    default:
      throw new BrowserAutomationError("Unexpected result from Deep Research activation.", {
        stage: "deep-research-activate",
      });
  }
}

async function clickTrustedPoint(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
  x: number,
  y: number,
): Promise<void> {
  if (Input && typeof Input.dispatchMouseEvent === "function") {
    await Input.dispatchMouseEvent({ type: "mouseMoved", x, y });
    await Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    return;
  }
  await Runtime.evaluate({
    expression: `(() => {
      const el = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
      if (!(el instanceof HTMLElement)) return false;
      el.click();
      return true;
    })()`,
    returnByValue: true,
  });
}

async function waitForDeepResearchPill(
  Runtime: ChromeClient["Runtime"],
  timeoutMs = 5000,
): Promise<boolean> {
  const { result } = await Runtime.evaluate({
    expression: buildWaitForDeepResearchPillExpression(timeoutMs),
    awaitPromise: true,
    returnByValue: true,
  });
  return Boolean(result?.value);
}

/**
 * After prompt submission, waits for the research plan to appear and
 * auto-confirm (~60s countdown + 10s safety margin).
 */
export async function waitForResearchPlanAutoConfirm(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  autoConfirmWaitMs: number = DEEP_RESEARCH_AUTO_CONFIRM_WAIT_MS,
): Promise<void> {
  // Phase A: Detect research plan appearance (up to 60s)
  const planDeadline = Date.now() + 60_000;
  let planDetected = false;

  while (Date.now() < planDeadline) {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const iframes = document.querySelectorAll('iframe');
        const hasResearchIframe = Array.from(iframes).some(f => {
          const rect = f.getBoundingClientRect();
          return rect.width > 200 && rect.height > 200;
        });
        const assistantText = (document.querySelector('[data-message-author-role="assistant"]')?.textContent || '').toLowerCase();
        const hasResearchText = assistantText.includes('researching') ||
          assistantText.includes('research plan') ||
          assistantText.includes('survey') ||
          assistantText.includes('analyze');
        return { hasResearchIframe, hasResearchText };
      })()`,
      returnByValue: true,
    });

    const val = result?.value as
      | { hasResearchIframe?: boolean; hasResearchText?: boolean }
      | undefined;
    if (val?.hasResearchIframe || val?.hasResearchText) {
      planDetected = true;
      logger("Research plan detected, waiting for auto-confirm countdown...");
      break;
    }
    await delay(2_000);
  }

  if (!planDetected) {
    logger(
      "Warning: Research plan not detected within 60s; continuing (may have auto-confirmed already)",
    );
    return;
  }

  // Phase B: Wait for auto-confirm countdown
  const confirmStart = Date.now();
  while (Date.now() - confirmStart < autoConfirmWaitMs) {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const iframes = document.querySelectorAll('iframe');
        const hasLargeIframe = Array.from(iframes).some(f => {
          const rect = f.getBoundingClientRect();
          return rect.width > 200 && rect.height > 200;
        });
        const text = (document.body?.innerText || '').toLowerCase();
        const isResearching = text.includes('researching...') ||
          text.includes('reading sources') ||
          text.includes('considering');
        return { hasLargeIframe, isResearching };
      })()`,
      returnByValue: true,
    });
    const val = result?.value as { hasLargeIframe?: boolean; isResearching?: boolean } | undefined;

    if (val?.isResearching) {
      logger("Research plan confirmed, execution started");
      return;
    }

    await delay(5_000);
  }

  logger("Auto-confirm wait complete, proceeding to monitor research progress");
}

function buildDeepResearchSubmittedUserTurnExpression(
  expectedConversationId: string,
  minTurnIndex: number,
  expectedPrompt: string,
  promptIsPreview: boolean,
): string {
  return `(async () => {
    const expectedConversationId = ${JSON.stringify(expectedConversationId)};
    const minTurnIndex = ${JSON.stringify(Math.floor(minTurnIndex))};
    const expectedPrompt = ${JSON.stringify(expectedPrompt)};
    const promptIsPreview = ${JSON.stringify(promptIsPreview)};
    const asString = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
    const normalizePromptComparable = (value) =>
      String(value || '')
        .replace(/\\r\\n?/g, '\\n')
        .trim()
        .replace(/^@?deep research\\b[ \\t\\n]*/i, '')
        .trim();
    const protocol = String(location.protocol || '').toLowerCase();
    const hostname = String(location.hostname || '').toLowerCase();
    const port = String(location.port || '');
    const allowedHostname = hostname === 'chatgpt.com' || hostname === 'chat.openai.com';
    if (protocol !== 'https:' || !allowedHostname || (port && port !== '443')) {
      return { conversationId: null, unavailable: true, reason: 'origin-unavailable' };
    }
    const conversationId = String(location.pathname || '').match(/\\/c\\/([^/?#]+)/)?.[1] || null;
    if (conversationId !== expectedConversationId) {
      return { conversationId, changed: true };
    }
    const expected = normalizePromptComparable(expectedPrompt);
    if (!expected) return { conversationId, unavailable: true, reason: 'prompt-unavailable' };
    const promptMatchesExpected = (value) => {
      const normalized = normalizePromptComparable(value);
      return promptIsPreview ? normalized.startsWith(expected) : normalized === expected;
    };
    const turns = ${buildConversationTurnListExpression()};
    const domUserTurns = [];
    for (let index = minTurnIndex; index < turns.length; index += 1) {
      const turn = turns[index];
      const role = turn?.getAttribute?.('data-message-author-role') ||
        turn?.getAttribute?.('data-turn') ||
        (turn?.querySelector?.('[data-message-author-role="user"], [data-turn="user"]')
          ? 'user'
          : null);
      if (role !== 'user') continue;
      const text = normalizePromptComparable(turn?.innerText || turn?.textContent || '');
      const ids = Array.from(new Set([
        turn?.getAttribute?.('data-message-id'),
        ...Array.from(turn?.querySelectorAll?.('[data-message-id]') || [])
          .map((node) => node?.getAttribute?.('data-message-id')),
      ].filter((value) =>
        typeof value === 'string' &&
        value.trim() &&
        !/^request-web:/i.test(value) &&
        !/^conversation-turn-\\d+$/i.test(value)
      ).map((value) => value.trim())));
      domUserTurns.push({ ids, text, turnIndex: index });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let record;
    try {
      const authResponse = await fetch('/api/auth/session', {
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
      });
      if (!authResponse.ok) {
        return {
          conversationId,
          unavailable: true,
          reason: 'auth-response-unavailable',
          status: authResponse.status,
        };
      }
      const auth = await authResponse.json();
      const accessToken = asString(auth?.accessToken);
      if (!accessToken) {
        return { conversationId, unavailable: true, reason: 'auth-token-unavailable' };
      }
      const recordResponse = await fetch(
        '/backend-api/conversation/' + encodeURIComponent(conversationId),
        {
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          signal: controller.signal,
          headers: { authorization: 'Bearer ' + accessToken },
        },
      );
      if (!recordResponse.ok) {
        return {
          conversationId,
          unavailable: true,
          reason: 'conversation-record-unavailable',
          status: recordResponse.status,
        };
      }
      record = await recordResponse.json();
    } catch {
      return { conversationId, unavailable: true, reason: 'conversation-record-fetch-failed' };
    } finally {
      clearTimeout(timeout);
    }
    if (
      (String(location.pathname || '').match(/\\/c\\/([^/?#]+)/)?.[1] || null) !==
      expectedConversationId
    ) return { conversationId: null, changed: true };

    const mapping = record?.mapping;
    if (!mapping || typeof mapping !== 'object') {
      return { conversationId, unavailable: true, reason: 'conversation-mapping-unavailable' };
    }
    const currentBranch = [];
    const seen = new Set();
    let cursor = record?.current_node;
    while (typeof cursor === 'string' && cursor && currentBranch.length < 10000) {
      if (seen.has(cursor)) {
        return { conversationId, unavailable: true, reason: 'conversation-branch-cycle' };
      }
      seen.add(cursor);
      const node = mapping[cursor];
      if (!node) {
        return { conversationId, unavailable: true, reason: 'conversation-node-unavailable' };
      }
      currentBranch.push(node);
      if (node.parent == null) {
        cursor = null;
        break;
      }
      if (typeof node.parent !== 'string' || !node.parent) {
        return { conversationId, unavailable: true, reason: 'conversation-parent-unavailable' };
      }
      cursor = node.parent;
    }
    if (cursor) {
      return { conversationId, unavailable: true, reason: 'conversation-branch-too-deep' };
    }
    currentBranch.reverse();
    const messageText = (message) => {
      const content = message?.content;
      if (typeof content?.text === 'string') return content.text;
      if (Array.isArray(content?.parts)) {
        return content.parts.filter((part) => typeof part === 'string').join('\\n');
      }
      return '';
    };
    const branchUsers = currentBranch.filter(
      (node) => node?.message?.author?.role === 'user',
    );
    const lastBranchUser = branchUsers[branchUsers.length - 1] || null;
    const branchPromptMatched = Boolean(
      lastBranchUser && promptMatchesExpected(messageText(lastBranchUser?.message)),
    );
    if (!lastBranchUser || !branchPromptMatched) {
      return {
        conversationId,
        unavailable: true,
        reason: 'conversation-user-unmatched',
        branchUserCount: branchUsers.length,
        branchPromptMatched,
      };
    }

    const messageId = asString(lastBranchUser?.message?.id);
    if (!messageId) {
      return { conversationId, unavailable: true, reason: 'conversation-user-id-unavailable' };
    }
    const exactDomMatches = domUserTurns.filter((candidate) =>
      candidate.ids.includes(messageId)
    );
    const promptDomMatches = domUserTurns.filter((candidate) =>
      candidate.text.includes(expected)
    );
    const matchedDomTurn =
      exactDomMatches.length === 1
        ? exactDomMatches[0]
        : promptDomMatches.length === 1
          ? promptDomMatches[0]
          : domUserTurns.length === 1
            ? domUserTurns[0]
            : domUserTurns.length === 0
              ? { turnIndex: minTurnIndex }
              : null;
    if (!matchedDomTurn) {
      return {
        conversationId,
        unavailable: true,
        reason: 'dom-user-turn-ambiguous',
        domUserCount: domUserTurns.length,
        exactDomMatchCount: exactDomMatches.length,
        promptDomMatchCount: promptDomMatches.length,
      };
    }
    return { conversationId, messageId, turnIndex: matchedDomTurn.turnIndex };
  })()`;
}

export async function waitForDeepResearchSubmittedUserTurn(
  Runtime: ChromeClient["Runtime"],
  expectedConversationId: string,
  minTurnIndex: number | null | undefined,
  expectedPrompt: string | null | undefined,
  timeoutMs = 60_000,
  options: { promptIsPreview?: boolean } = {},
): Promise<DeepResearchSubmittedUserTurn> {
  const prompt = expectedPrompt?.trim();
  if (
    !expectedConversationId.trim() ||
    typeof minTurnIndex !== "number" ||
    !Number.isFinite(minTurnIndex) ||
    minTurnIndex < 0 ||
    !prompt
  ) {
    throw new BrowserAutomationError(
      "Deep Research submitted user turn could not be identified exactly.",
      { stage: "deep-research-scope", code: "deep-research-user-turn-unavailable" },
    );
  }
  const deadline = Date.now() + timeoutMs;
  let lastDiagnostic: Record<string, unknown> | undefined;
  do {
    const { result } = await Runtime.evaluate({
      expression: buildDeepResearchSubmittedUserTurnExpression(
        expectedConversationId,
        minTurnIndex,
        prompt,
        options.promptIsPreview === true,
      ),
      awaitPromise: true,
      returnByValue: true,
    });
    const value = result?.value as
      | {
          conversationId?: string | null;
          changed?: boolean;
          messageId?: string;
          turnIndex?: number;
          unavailable?: boolean;
          reason?: string;
          status?: number;
          branchUserCount?: number;
          branchPromptMatched?: boolean;
          domUserCount?: number;
          exactDomMatchCount?: number;
          promptDomMatchCount?: number;
        }
      | undefined;
    if (value?.changed || value?.conversationId !== expectedConversationId) {
      throw new BrowserAutomationError(
        "ChatGPT left the submitted Deep Research conversation before its exact user turn could be bound.",
        { stage: "deep-research-scope", code: "deep-research-conversation-changed" },
      );
    }
    if (
      typeof value.messageId === "string" &&
      value.messageId.trim() &&
      typeof value.turnIndex === "number" &&
      value.turnIndex >= minTurnIndex
    ) {
      return { messageId: value.messageId.trim(), turnIndex: Math.floor(value.turnIndex) };
    }
    if (value?.unavailable) {
      lastDiagnostic = {
        reason: value.reason ?? "unknown",
        ...(typeof value.status === "number" ? { status: value.status } : {}),
        ...(typeof value.branchUserCount === "number"
          ? { branchUserCount: value.branchUserCount }
          : {}),
        ...(typeof value.branchPromptMatched === "boolean"
          ? { branchPromptMatched: value.branchPromptMatched }
          : {}),
        ...(typeof value.domUserCount === "number" ? { domUserCount: value.domUserCount } : {}),
        ...(typeof value.exactDomMatchCount === "number"
          ? { exactDomMatchCount: value.exactDomMatchCount }
          : {}),
        ...(typeof value.promptDomMatchCount === "number"
          ? { promptDomMatchCount: value.promptDomMatchCount }
          : {}),
      };
    }
    await delay(100);
  } while (Date.now() < deadline);

  throw new BrowserAutomationError(
    "Deep Research submitted user turn did not expose one exact record message ID.",
    {
      stage: "deep-research-scope",
      code: "deep-research-user-turn-unavailable",
      ...(lastDiagnostic ? { diagnostic: lastDiagnostic } : {}),
    },
  );
}

export function buildDeepResearchSubmittedUserTurnExpressionForTest(
  expectedConversationId: string,
  minTurnIndex: number,
  expectedPrompt: string,
  promptIsPreview = false,
): string {
  return buildDeepResearchSubmittedUserTurnExpression(
    expectedConversationId,
    minTurnIndex,
    expectedPrompt,
    promptIsPreview,
  );
}

/**
 * Polls for Deep Research completion over 5-30+ minutes.
 * Returns the full response text, optional HTML, and turn metadata.
 */
export async function waitForDeepResearchCompletion(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  timeoutMs: number = DEEP_RESEARCH_DEFAULT_TIMEOUT_MS,
  minTurnIndex?: number | null,
  Page?: ChromeClient["Page"],
  client?: ChromeClient,
  options?: {
    ignoredTargetKeys?: readonly string[];
    targetBaseline?: readonly DeepResearchTargetBaseline[];
    requireScopedTargetOwner?: boolean;
    targetBaselineCaptured?: boolean;
    expectedConversationId?: string;
    expectedUserMessageId?: string;
  },
): Promise<DeepResearchCompletionResult> {
  const start = Date.now();
  let lastLogTime = start;
  let lastTextLength = 0;
  const minTurnLiteral =
    typeof minTurnIndex === "number" && Number.isFinite(minTurnIndex) && minTurnIndex >= 0
      ? Math.floor(minTurnIndex)
      : -1;
  const scopedToNewTurns = minTurnLiteral >= 0;
  const targetBaselineById = new Map(
    (options?.targetBaseline ?? []).map((entry) => [entry.targetId, entry] as const),
  );
  const ignoredTargetKeys = new Set([
    ...(options?.ignoredTargetKeys ?? []),
    ...targetBaselineById.keys(),
  ]);
  const requireScopedTargetOwner = options?.requireScopedTargetOwner === true || scopedToNewTurns;
  if (options?.targetBaselineCaptured === false) {
    throw new BrowserAutomationError(
      "Deep Research target baseline capture failed before submission; refusing to verify a report whose target freshness cannot be established.",
      {
        stage: "deep-research-scope",
        code: "deep-research-target-baseline-unavailable",
      },
    );
  }
  if (options?.targetBaselineCaptured === true && !scopedToNewTurns) {
    throw new BrowserAutomationError(
      "Deep Research conversation turn boundary was unavailable after submission; refusing an unscoped completed report.",
      { stage: "deep-research-scope", code: "deep-research-scope-unavailable" },
    );
  }
  if (options?.requireScopedTargetOwner === true && !scopedToNewTurns) {
    throw new BrowserAutomationError(
      "Deep Research owner scoping was required, but no valid conversation turn index was available.",
      { stage: "deep-research-scope", code: "deep-research-scope-unavailable" },
    );
  }
  if (requireScopedTargetOwner && !options?.expectedConversationId?.trim()) {
    throw new BrowserAutomationError(
      "Deep Research conversation ID was unavailable after submission; refusing an unpinned completed report.",
      { stage: "deep-research-scope", code: "deep-research-conversation-unavailable" },
    );
  }
  if (requireScopedTargetOwner && !options?.expectedUserMessageId?.trim()) {
    throw new BrowserAutomationError(
      "Deep Research submitted user message ID was unavailable; refusing a report that is not bound to the exact requested turn.",
      { stage: "deep-research-scope", code: "deep-research-user-turn-unavailable" },
    );
  }
  let observedResearchEvidence = false;
  let loggedIncompleteResult = false;

  logger(`Monitoring Deep Research (timeout: ${Math.round(timeoutMs / 60_000)}min)...`);

  while (Date.now() - start < timeoutMs) {
    const { result } = await Runtime.evaluate({
      expression: buildDeepResearchCompletionPollExpression(minTurnLiteral),
      returnByValue: true,
    });

    const val = result?.value as
      | {
          finished?: boolean;
          stopVisible?: boolean;
          textLength?: number;
          hasIframe?: boolean;
          hasActiveScopedResearch?: boolean;
          incompleteResult?: boolean;
          researchActivity?: boolean;
          accountBlocked?: boolean;
          conversationId?: string | null;
        }
      | undefined;

    if (options?.expectedConversationId && val?.conversationId !== options.expectedConversationId) {
      throw new BrowserAutomationError(
        "ChatGPT navigated away from the submitted Deep Research conversation; refusing to read another conversation's report.",
        { stage: "deep-research-scope", code: "deep-research-conversation-changed" },
      );
    }

    if (val?.accountBlocked) {
      throw new BrowserAutomationError(
        "ChatGPT account security block detected during Deep Research. Open chatgpt.com in Chrome, secure the account, then rerun Oracle.",
        { stage: "chatgpt-account-blocked", code: "chatgpt-account-blocked" },
      );
    }
    // ChatGPT renders the Deep Research report inside an out-of-process,
    // sandboxed iframe (connector_openai_deep_research.*.oaiusercontent.com),
    // doubly nested and same-origin. That OOPIF does NOT appear in the main
    // page's frame tree, so the in-page isolated-world path
    // (readDeepResearchFrameResult) can never see it. The target-attach path
    // (readDeepResearchTargetResult) attaches to the iframe's own CDP target and
    // walks its nested frames, so it CAN read the report. Prefer the target path
    // and fall back to the in-page frame path for legacy/inline rendering.
    const rawTargetResult = client
      ? ((
          await readDeepResearchTargetResult(
            client,
            ignoredTargetKeys,
            scopedToNewTurns ? minTurnLiteral : -1,
            requireScopedTargetOwner,
            true,
            targetBaselineById,
            options?.expectedConversationId,
            options?.expectedUserMessageId,
          ).catch(() => null)
        )?.read ?? null)
      : null;
    const targetResult = filterIncompleteDeepResearchRead(rawTargetResult);
    // A scoped run must complete through the exact target-owner path. The
    // legacy inline-frame fallback has no pre-submit content baseline, so it is
    // retained only for explicitly unscoped compatibility reads.
    const inPageScan =
      !targetResult?.completed && Page && !requireScopedTargetOwner
        ? await readDeepResearchFrameResult(
            Runtime,
            Page,
            client,
            scopedToNewTurns ? minTurnLiteral : -1,
            scopedToNewTurns,
          ).catch(() => null)
        : null;
    const rawInPageResult = inPageScan?.read ?? null;
    const inPageResult = filterIncompleteDeepResearchRead(rawInPageResult);
    const read = pickPreferredDeepResearchRead(targetResult, inPageResult);
    // Target keys captured before submission are ignored, so a target result is
    // tied to this run. Main-page iframes are not: old reports can remain in the
    // conversation and must never authorize a new normal-response fallback.
    observedResearchEvidence ||= Boolean(
      rawTargetResult ||
      (scopedToNewTurns && rawInPageResult) ||
      val?.researchActivity ||
      val?.hasActiveScopedResearch,
    );
    if (read?.completed && read.text) {
      logger(`Deep Research completed (${Math.round((Date.now() - start) / 1000)}s elapsed)`);
      return finalizeDeepResearchResult(read.text, read.html, read.meta, read.citationStatus);
    }

    // Completion detected
    if (val?.finished && !requireScopedTargetOwner) {
      if (!observedResearchEvidence) {
        throw new BrowserAutomationError(
          "ChatGPT returned a completed response without starting Deep Research. The Deep Research selection may have silently fallen back to a normal response.",
          { stage: "deep-research-not-started", code: "deep-research-not-started" },
        );
      }
      logger(`Deep Research completed (${Math.round((Date.now() - start) / 1000)}s elapsed)`);
      return await extractDeepResearchResult(Runtime, logger, minTurnIndex ?? undefined);
    }

    const incompleteFrameResult = Boolean(
      (rawTargetResult?.completed && !targetResult?.completed) ||
      (rawInPageResult?.completed && !inPageResult?.completed),
    );
    if ((val?.incompleteResult || incompleteFrameResult) && !loggedIncompleteResult) {
      logger("Deep Research interim status detected; waiting for the final report");
      loggedIncompleteResult = true;
    }

    // Progress logging every 60 seconds
    const now = Date.now();
    if (now - lastLogTime >= 60_000) {
      const elapsed = Math.round((now - start) / 1000);
      const chars = Math.max(val?.textLength ?? 0, read?.textLength ?? 0);
      const phase =
        read?.inProgress || val?.hasIframe
          ? "researching"
          : val?.stopVisible
            ? "generating"
            : "waiting";
      logger(`Deep Research ${phase}... ${elapsed}s elapsed, ~${chars} chars`);
      lastLogTime = now;
    }

    lastTextLength = Math.max(val?.textLength ?? 0, read?.textLength ?? 0, lastTextLength);
    await delay(DEEP_RESEARCH_POLL_INTERVAL_MS);
  }

  // Timeout — throw with metadata for potential reattach
  const elapsed = Math.round((Date.now() - start) / 1000);
  throw new BrowserAutomationError(
    `Deep Research did not complete within ${Math.round(timeoutMs / 60_000)} minutes (${elapsed}s elapsed). ` +
      "Use 'oracle session <id>' to reattach later, or increase --timeout.",
    {
      stage: "deep-research-timeout",
      code: "deep-research-timeout",
      elapsedMs: Date.now() - start,
      lastTextLength,
    },
  );
}

/**
 * Extracts the Deep Research result using existing assistant response
 * extraction logic (readAssistantSnapshot + captureAssistantMarkdown).
 */
export async function extractDeepResearchResult(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  minTurnIndex?: number,
): Promise<DeepResearchCompletionResult> {
  const snapshot = await readAssistantSnapshot(Runtime, minTurnIndex);
  const meta = {
    turnId: snapshot?.turnId ?? null,
    messageId: snapshot?.messageId ?? null,
    turnIndex: snapshot?.turnIndex ?? null,
    modelSlug: snapshot?.modelSlug ?? null,
  };

  // Try the copy-button approach first for clean markdown
  const markdown = await captureAssistantMarkdown(Runtime, meta, logger);
  if (markdown && !isDeepResearchIncompleteText(markdown)) {
    return finalizeDeepResearchResult(markdown, snapshot?.html ?? undefined, meta);
  }

  // Fall back to snapshot text
  if (snapshot?.text && !isDeepResearchIncompleteText(snapshot.text)) {
    return finalizeDeepResearchResult(snapshot.text, snapshot.html ?? undefined, meta);
  }

  throw new BrowserAutomationError(
    "Deep Research completed but failed to extract the response text.",
    { stage: "deep-research-extract", code: "extraction-failed" },
  );
}

export function isDeepResearchPlaceholderTextForTest(text: string): boolean {
  return isDeepResearchIncompleteText(text);
}

interface DeepResearchFrameTree {
  frame?: { id?: string; url?: string; name?: string };
  childFrames?: DeepResearchFrameTree[];
}

interface DeepResearchFrameStatus {
  completed: boolean;
  inProgress: boolean;
  textLength: number;
  text?: string;
  html?: string;
  meta?: DeepResearchTurnMetadata;
  citationStatus?: DeepResearchCitationStatus;
  citationMarkerNonce?: string;
  citationRootComparable?: string;
  citationReportNeedle?: string;
  declaredCitationCount?: number;
  contentSha256?: string;
}

export interface DeepResearchCitationSource {
  index: number;
  url: string;
  label?: string;
}

interface DeepResearchCitationSourceScan {
  observedIndexes: number[];
  sources: DeepResearchCitationSource[];
}

function hasVerifiedDeepResearchCitationUiContract(
  scan: DeepResearchCitationSourceScan | null,
  declaredCitationCount: number | undefined,
): boolean {
  return (
    scan !== null && (scan.observedIndexes.length > 0 || typeof declaredCitationCount === "number")
  );
}

export function hasVerifiedDeepResearchCitationUiContractForTest(
  scan: DeepResearchCitationSourceScan | null,
  declaredCitationCount: number | undefined,
): boolean {
  return hasVerifiedDeepResearchCitationUiContract(scan, declaredCitationCount);
}

interface DeepResearchTargetScanResult {
  read: DeepResearchFrameStatus | null;
  targetKeys: string[];
  targetBaseline: DeepResearchTargetBaseline[];
}

interface DeepResearchTargetSessionResult {
  confirmed: boolean;
  read: DeepResearchFrameStatus | null;
  frameId?: string;
}

interface DeepResearchFrameReadResult {
  read: DeepResearchFrameStatus;
  ownerMeta: DeepResearchTurnMetadata | null;
}

function isEligibleScopedDeepResearchOwner(
  meta: DeepResearchTurnMetadata | null | undefined,
  minTurnIndex: number,
): boolean {
  const messageId = meta?.messageId?.trim();
  return Boolean(
    typeof meta?.turnIndex === "number" &&
    meta.turnIndex >= minTurnIndex &&
    messageId &&
    !/^request-web:/i.test(messageId),
  );
}

function isAuthoritativeDeepResearchOwner(
  meta: DeepResearchTurnMetadata | null | undefined,
  minTurnIndex: number,
): boolean {
  return (
    isEligibleScopedDeepResearchOwner(meta, minTurnIndex) &&
    meta?.metadataSource === "chatgpt-conversation-record"
  );
}

function isEligibleScopedDeepResearchOwnerPosition(
  meta: DeepResearchTurnMetadata | null | undefined,
  minTurnIndex: number,
): boolean {
  const messageId = meta?.messageId?.trim();
  return Boolean(
    typeof meta?.turnIndex === "number" &&
    meta.turnIndex >= minTurnIndex &&
    (!messageId || !/^request-web:/i.test(messageId)),
  );
}

function isSameDeepResearchOwner(
  before: DeepResearchTurnMetadata | null | undefined,
  after: DeepResearchTurnMetadata | null | undefined,
): boolean {
  const first = normalizeDeepResearchTurnMetadata(before);
  const second = normalizeDeepResearchTurnMetadata(after);
  const stablePosition = Boolean(
    typeof first?.turnIndex === "number" &&
    second?.turnIndex === first.turnIndex &&
    first.turnId &&
    second.turnId === first.turnId,
  );
  const stableExactMessage = Boolean(
    first?.messageId &&
    second?.messageId === first.messageId &&
    typeof first.turnIndex === "number" &&
    second.turnIndex === first.turnIndex,
  );
  const hasEitherExactMessage = Boolean(first?.messageId || second?.messageId);
  return Boolean(
    (hasEitherExactMessage ? stableExactMessage : stablePosition) &&
    (!first?.turnId || !second?.turnId || second.turnId === first.turnId),
  );
}

export function isSameDeepResearchOwnerForTest(
  before: DeepResearchTurnMetadata | null | undefined,
  after: DeepResearchTurnMetadata | null | undefined,
): boolean {
  return isSameDeepResearchOwner(before, after);
}

function fingerprintDeepResearchContent(text: string): string {
  // The serializer uses a random nonce to distinguish its markers from report
  // text. Canonicalize only that nonce before hashing the pre-link Markdown.
  const canonical = text
    .trim()
    .replace(/\[\[ORACLE_DEEP_RESEARCH_CITATION(?:_[a-f0-9]{32})?_(\d{1,3})\]\]/gi, "[$1]");
  return createHash("sha256").update(canonical).digest("hex");
}

function hasStableCompletedDeepResearchRead(
  first: DeepResearchFrameStatus | null | undefined,
  second: DeepResearchFrameStatus | null | undefined,
): boolean {
  if (
    first?.completed !== true ||
    second?.completed !== true ||
    !first.text ||
    !second.text ||
    !first.contentSha256 ||
    !second.contentSha256
  ) {
    return false;
  }
  const citationStatusKey = (status: DeepResearchCitationStatus | undefined): string | null =>
    status
      ? JSON.stringify({
          total: status.total,
          linked: status.linked,
          missingIndexes: [...status.missingIndexes].sort((a, b) => a - b),
        })
      : null;
  return (
    first.contentSha256 === second.contentSha256 &&
    first.text === second.text &&
    citationStatusKey(first.citationStatus) === citationStatusKey(second.citationStatus)
  );
}

export function hasStableCompletedDeepResearchReadForTest(
  first: DeepResearchFrameStatus | null | undefined,
  second: DeepResearchFrameStatus | null | undefined,
): boolean {
  return hasStableCompletedDeepResearchRead(first, second);
}

function hasFreshDeepResearchContentProof(
  baseline: DeepResearchTargetBaseline,
  currentContentSha256: string | undefined,
): boolean {
  if (baseline.completed === false) return true;
  if (baseline.completed !== true) return false;
  return Boolean(
    baseline.contentSha256 &&
    currentContentSha256 &&
    baseline.contentSha256 !== currentContentSha256,
  );
}

export function hasFreshDeepResearchContentProofForTest(
  baseline: DeepResearchTargetBaseline,
  currentContentSha256: string | undefined,
): boolean {
  return hasFreshDeepResearchContentProof(baseline, currentContentSha256);
}

function preferEarlierScopedRead(
  current: DeepResearchFrameStatus | null,
  candidate: DeepResearchFrameStatus,
  minTurnIndex: number,
): DeepResearchFrameStatus {
  if (!current || minTurnIndex < 0) {
    return candidate;
  }
  const currentIndex = current.meta?.turnIndex;
  const candidateIndex = candidate.meta?.turnIndex;
  if (typeof candidateIndex !== "number") {
    return current;
  }
  if (typeof currentIndex !== "number" || candidateIndex < currentIndex) {
    return candidate;
  }
  return current;
}

function filterIncompleteDeepResearchRead(
  result: DeepResearchFrameStatus | null,
): DeepResearchFrameStatus | null {
  if (!result?.completed || !result.text || !isDeepResearchIncompleteText(result.text)) {
    return result;
  }
  return { ...result, completed: false, inProgress: true };
}

function shouldSkipDeepResearchTarget(
  targetId: string | undefined,
  ignoredTargetKeys: ReadonlySet<string>,
  hasCapturedTargetBaseline: boolean,
  minTurnIndex: number,
  requireScopedTargetOwner: boolean,
): boolean {
  if (!targetId || !ignoredTargetKeys.has(targetId)) return false;
  return !(hasCapturedTargetBaseline && requireScopedTargetOwner && minTurnIndex >= 0);
}

export function shouldSkipDeepResearchTargetForTest(
  targetId: string | undefined,
  ignoredTargetKeys: readonly string[],
  hasCapturedTargetBaseline: boolean,
  minTurnIndex: number,
  requireScopedTargetOwner: boolean,
): boolean {
  return shouldSkipDeepResearchTarget(
    targetId,
    new Set(ignoredTargetKeys),
    hasCapturedTargetBaseline,
    minTurnIndex,
    requireScopedTargetOwner,
  );
}

export function filterIncompleteDeepResearchReadForTest(
  result: DeepResearchFrameStatus | null,
): DeepResearchFrameStatus | null {
  return filterIncompleteDeepResearchRead(result);
}

/**
 * Choose the authoritative Deep Research read between the target-attach result
 * and the in-page frame result. A completed read wins (target preferred, since
 * it reads the live OOPIF directly); otherwise the best in-progress/text-bearing
 * read is kept so progress logging still advances. This preserves the legacy
 * Page-first inline behaviour: when the target read is missing or incomplete,
 * a completed in-page result is still returned.
 */
function pickPreferredDeepResearchRead(
  targetResult: DeepResearchFrameStatus | null,
  inPageResult: DeepResearchFrameStatus | null,
): DeepResearchFrameStatus | null {
  if (targetResult?.completed) {
    return targetResult;
  }
  if (inPageResult?.completed) {
    return inPageResult;
  }
  return targetResult ?? inPageResult;
}

export function pickPreferredDeepResearchReadForTest(
  targetResult: DeepResearchFrameStatus | null,
  inPageResult: DeepResearchFrameStatus | null,
): DeepResearchFrameStatus | null {
  return pickPreferredDeepResearchRead(targetResult, inPageResult);
}

async function readDeepResearchFrameResult(
  Runtime: ChromeClient["Runtime"],
  Page: ChromeClient["Page"],
  client?: ChromeClient,
  minTurnIndex = -1,
  requireScopedTargetOwner = false,
): Promise<DeepResearchFrameReadResult | null> {
  const pageWithFrames = Page as ChromeClient["Page"] & {
    getFrameTree?: () => Promise<{ frameTree?: DeepResearchFrameTree }>;
    createIsolatedWorld?: (params: {
      frameId: string;
      worldName?: string;
      grantUniveralAccess?: boolean;
    }) => Promise<{ executionContextId?: number }>;
  };
  if (
    typeof pageWithFrames.getFrameTree !== "function" ||
    typeof pageWithFrames.createIsolatedWorld !== "function"
  ) {
    return null;
  }
  if (requireScopedTargetOwner && minTurnIndex < 0) {
    return null;
  }
  const frameTree = (await pageWithFrames.getFrameTree())?.frameTree;
  const frameIds = collectPageDeepResearchFrameIds(frameTree);
  if (frameIds.length === 0) {
    return null;
  }
  const rawClient = client as
    | (ChromeClient & {
        send?: (
          method: string,
          params?: Record<string, unknown>,
          sessionId?: string,
        ) => Promise<unknown>;
        oraclePageSessionId?: string;
      })
    | undefined;
  if (minTurnIndex >= 0 && requireScopedTargetOwner && typeof rawClient?.send !== "function") {
    return null;
  }
  if (typeof rawClient?.send === "function") {
    await rawClient.send("DOM.enable", {}, rawClient.oraclePageSessionId).catch(() => undefined);
    await rawClient
      .send("Runtime.enable", {}, rawClient.oraclePageSessionId)
      .catch(() => undefined);
  }
  let best: DeepResearchFrameReadResult | null = null;
  for (const frameId of frameIds) {
    let ownerMeta: DeepResearchTurnMetadata | null = null;
    if (rawClient?.send) {
      ownerMeta = await readDeepResearchTargetOwnerTurnMetadata(
        rawClient as ChromeClient & { send: NonNullable<typeof rawClient.send> },
        frameId,
        rawClient.oraclePageSessionId,
      );
    }
    if (minTurnIndex >= 0) {
      if (
        requireScopedTargetOwner &&
        !isEligibleScopedDeepResearchOwnerPosition(ownerMeta, minTurnIndex)
      ) {
        continue;
      }
    }
    const world = await pageWithFrames.createIsolatedWorld({
      frameId,
      worldName: "oracle-deep-research",
      grantUniveralAccess: true,
    });
    if (typeof world.executionContextId !== "number") {
      continue;
    }
    const { result } = await Runtime.evaluate({
      expression: buildDeepResearchFrameStatusExpression(),
      contextId: world.executionContextId,
      returnByValue: true,
    });
    const read = (result?.value as DeepResearchFrameStatus | undefined) ?? null;
    if (!read) {
      continue;
    }
    if (read.completed && requireScopedTargetOwner && rawClient?.send) {
      const ownerAfter = await readDeepResearchTargetOwnerTurnMetadata(
        rawClient as ChromeClient & { send: NonNullable<typeof rawClient.send> },
        frameId,
        rawClient.oraclePageSessionId,
      );
      if (
        !isEligibleScopedDeepResearchOwnerPosition(ownerAfter, minTurnIndex) ||
        !isSameDeepResearchOwner(ownerMeta, ownerAfter)
      ) {
        continue;
      }
      ownerMeta = ownerAfter;
    }
    const readWithFingerprint =
      read.completed && read.text
        ? { ...read, contentSha256: fingerprintDeepResearchContent(read.text) }
        : read;
    const citationApplied =
      readWithFingerprint.completed && readWithFingerprint.text
        ? applyDeepResearchCitationSources(
            readWithFingerprint.text,
            [],
            readWithFingerprint.citationMarkerNonce,
            [],
            false,
          )
        : null;
    const normalizedRead = citationApplied
      ? {
          ...readWithFingerprint,
          text: citationApplied.markdown,
          ...(citationApplied.status ? { citationStatus: citationApplied.status } : {}),
        }
      : readWithFingerprint;
    const enrichedOwnerMeta =
      normalizedRead.completed && ownerMeta && rawClient?.send
        ? await enrichDeepResearchTurnMetadataFromConversationRecord(
            rawClient as ChromeClient & { send: NonNullable<typeof rawClient.send> },
            ownerMeta,
            rawClient.oraclePageSessionId,
          )
        : ownerMeta;
    if (
      normalizedRead.completed &&
      requireScopedTargetOwner &&
      !isEligibleScopedDeepResearchOwner(enrichedOwnerMeta, minTurnIndex)
    ) {
      continue;
    }
    const readWithMeta = enrichedOwnerMeta
      ? { ...normalizedRead, meta: enrichedOwnerMeta }
      : normalizedRead;
    best = { read: readWithMeta, ownerMeta: enrichedOwnerMeta };
    if (normalizedRead.completed) {
      return best;
    }
  }
  return best;
}

async function readDeepResearchTargetResult(
  client: ChromeClient,
  ignoredTargetKeys: ReadonlySet<string> = new Set(),
  minTurnIndex = -1,
  requireScopedTargetOwner = false,
  enrichCompletedOwnerMetadata = false,
  targetBaselineById: ReadonlyMap<string, DeepResearchTargetBaseline> = new Map(),
  expectedConversationId?: string,
  expectedUserMessageId?: string,
): Promise<DeepResearchTargetScanResult | null> {
  const rawClient = client as ChromeClient & {
    send?: (
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string,
    ) => Promise<unknown>;
    oraclePageSessionId?: string;
  };
  if (typeof rawClient.send !== "function") {
    return null;
  }
  if (typeof client.on !== "function") {
    return null;
  }
  if (requireScopedTargetOwner && minTurnIndex < 0) {
    return null;
  }

  // On the browser-WSEndpoint path, `client` is a session-bound wrapper whose
  // domain methods target the page session but whose raw `send` is the
  // browser-level send. We must therefore pass the page session id explicitly so
  // Target.setAutoAttach binds to THIS page (not the whole browser). For a direct
  // tab client this is undefined and `send` already defaults to the page session.
  const pageSessionId = rawClient.oraclePageSessionId;

  const sessions = new Map<string, { targetId?: string; url: string }>();
  const ownedSessionIds = new Set<string>();
  const onAttached = (params: unknown, parentSessionId?: string) => {
    // chrome-remote-interface emits flattened target events both on the
    // session-specific event name and on the shared base event. The second
    // callback argument identifies the parent page session; ignore events from
    // other tabs when this client wraps a shared browser WebSocket.
    if (pageSessionId && parentSessionId !== pageSessionId) {
      return;
    }
    const targetInfo = (
      params as { targetInfo?: { targetId?: string; url?: string; type?: string } } | undefined
    )?.targetInfo;
    const eventSessionId =
      (params as { sessionId?: string } | undefined)?.sessionId ?? parentSessionId;
    const url = targetInfo?.url ?? "";
    const type = targetInfo?.type ?? "";
    if (eventSessionId && isDeepResearchTarget(url, type)) {
      sessions.set(eventSessionId, { targetId: targetInfo?.targetId, url });
      ownedSessionIds.add(eventSessionId);
    }
  };

  client.on("Target.attachedToTarget", onAttached as never);
  try {
    // Scope discovery to the current Oracle-controlled page. `client` is
    // connected to the conversation page target, so enabling auto-attach on this
    // session only attaches THIS page's related targets (its Deep Research OOPIF
    // subframe) and emits Target.attachedToTarget for them.
    //
    // We deliberately do NOT enumerate Target.getTargets / attachToTarget here:
    // that scan is browser-wide, and in a shared/persistent Chrome profile it
    // would surface another tab's completed Deep Research report and let it be
    // saved into the current session (cross-tab leak). Only auto-attached,
    // page-scoped sessions are treated as belonging to this run.
    const autoAttachEnabled = await rawClient
      .send(
        "Target.setAutoAttach",
        {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
        },
        pageSessionId,
      )
      .then(
        () => true,
        () => false,
      );
    if (!autoAttachEnabled) {
      return null;
    }
    await delay(100);

    await rawClient.send("DOM.enable", {}, pageSessionId).catch(() => undefined);
    await rawClient.send("Runtime.enable", {}, pageSessionId).catch(() => undefined);

    // Baseline targets and owner turns before the submitted prompt are removed
    // first. Among remaining targets, a completed report is authoritative;
    // otherwise retain the newest meaningful progress read for status logging.
    let completed: DeepResearchFrameStatus | null = null;
    let latestProgress: DeepResearchFrameStatus | null = null;
    const targetKeys: string[] = [];
    const capturedBaselineById = new Map<string, DeepResearchTargetBaseline>();
    for (const [sessionId, target] of sessions) {
      const capturedBaseline = target.targetId
        ? targetBaselineById.get(target.targetId)
        : undefined;
      // ChatGPT can create the Deep Research OOPIF when the capability is
      // selected, before the user prompt is submitted, and then reuse that
      // exact target for the completed report. A target-id baseline alone
      // therefore cannot permanently exclude the target. Reconsider a reused
      // target only when the current run has a mandatory conversation-turn
      // boundary; the owner check below must then prove that the report belongs
      // to a turn at or after that boundary. Unscoped scans retain the strict
      // pre-submission target exclusion.
      if (
        shouldSkipDeepResearchTarget(
          target.targetId,
          ignoredTargetKeys,
          capturedBaseline !== undefined,
          minTurnIndex,
          requireScopedTargetOwner,
        )
      ) {
        continue;
      }
      const sessionResult = await readDeepResearchTargetSession(rawClient, sessionId, target.url);
      if (!sessionResult.confirmed) {
        continue;
      }
      if (target.targetId) {
        targetKeys.push(target.targetId);
        capturedBaselineById.set(target.targetId, {
          targetId: target.targetId,
          completed: sessionResult.read ? sessionResult.read.completed === true : null,
          ...(sessionResult.read?.contentSha256
            ? { contentSha256: sessionResult.read.contentSha256 }
            : {}),
        });
      }
      let ownerMeta = sessionResult.frameId
        ? await readDeepResearchTargetOwnerTurnMetadata(
            rawClient,
            sessionResult.frameId,
            pageSessionId,
          )
        : null;
      if (minTurnIndex >= 0) {
        if (
          requireScopedTargetOwner &&
          !isEligibleScopedDeepResearchOwnerPosition(ownerMeta, minTurnIndex)
        ) {
          continue;
        }
      }

      // Bind a completed report to a stable owner: owner-before, fresh report
      // read, owner-after. Persist only the middle read. This prevents a DOM
      // remount from pairing old report bytes with a newly reparented turn.
      let verifiedSessionResult = sessionResult;
      if (sessionResult.read?.completed && requireScopedTargetOwner) {
        const rawOwnerBefore = ownerMeta;
        const ownerBefore =
          enrichCompletedOwnerMetadata && rawOwnerBefore
            ? await enrichDeepResearchTurnMetadataFromConversationRecord(
                rawClient,
                rawOwnerBefore,
                pageSessionId,
                expectedConversationId,
                expectedUserMessageId,
              )
            : rawOwnerBefore;
        if (
          !isEligibleScopedDeepResearchOwnerPosition(rawOwnerBefore, minTurnIndex) ||
          (enrichCompletedOwnerMetadata &&
            !isAuthoritativeDeepResearchOwner(ownerBefore, minTurnIndex))
        ) {
          continue;
        }
        const reread = await readDeepResearchTargetSession(rawClient, sessionId, target.url);
        const rawOwnerAfter = reread.frameId
          ? await readDeepResearchTargetOwnerTurnMetadata(rawClient, reread.frameId, pageSessionId)
          : null;
        const ownerAfter =
          enrichCompletedOwnerMetadata && rawOwnerAfter
            ? await enrichDeepResearchTurnMetadataFromConversationRecord(
                rawClient,
                rawOwnerAfter,
                pageSessionId,
                expectedConversationId,
                expectedUserMessageId,
              )
            : rawOwnerAfter;
        if (
          !reread.confirmed ||
          !reread.read?.completed ||
          reread.frameId !== sessionResult.frameId ||
          !hasStableCompletedDeepResearchRead(sessionResult.read, reread.read) ||
          !isEligibleScopedDeepResearchOwnerPosition(rawOwnerAfter, minTurnIndex) ||
          (enrichCompletedOwnerMetadata &&
            !isAuthoritativeDeepResearchOwner(ownerAfter, minTurnIndex)) ||
          !isSameDeepResearchOwner(rawOwnerBefore, rawOwnerAfter) ||
          !isSameDeepResearchOwner(ownerBefore, ownerAfter)
        ) {
          continue;
        }
        verifiedSessionResult = reread;
        ownerMeta = ownerAfter;
      }
      if (
        verifiedSessionResult.read?.completed &&
        requireScopedTargetOwner &&
        !isEligibleScopedDeepResearchOwner(ownerMeta, minTurnIndex)
      ) {
        continue;
      }

      if (verifiedSessionResult.read?.completed && target.targetId && capturedBaseline) {
        const currentContentSha256 = verifiedSessionResult.read.contentSha256;
        if (!hasFreshDeepResearchContentProof(capturedBaseline, currentContentSha256)) {
          continue;
        }
      }

      const value = verifiedSessionResult.read
        ? ownerMeta
          ? { ...verifiedSessionResult.read, meta: ownerMeta }
          : verifiedSessionResult.read
        : null;
      if (value?.completed) {
        completed = preferEarlierScopedRead(completed, value, minTurnIndex);
      } else if (value && (value.inProgress || value.textLength > 0)) {
        latestProgress = value;
      }
    }
    return {
      read: completed ?? latestProgress,
      targetKeys,
      targetBaseline: Array.from(capturedBaselineById.values()),
    };
  } finally {
    await rawClient
      .send(
        "Target.setAutoAttach",
        {
          autoAttach: false,
          waitForDebuggerOnStart: false,
          flatten: true,
        },
        pageSessionId,
      )
      .catch(() => undefined);
    await Promise.all(
      Array.from(ownedSessionIds, (sessionId) =>
        rawClient.send("Target.detachFromTarget", { sessionId }).catch(() => undefined),
      ),
    );
    (
      client as ChromeClient & { removeListener?: (event: string, listener: unknown) => void }
    ).removeListener?.("Target.attachedToTarget", onAttached);
  }
}

export async function captureDeepResearchTargetKeys(client: ChromeClient): Promise<string[]> {
  return (await captureDeepResearchTargetBaseline(client)).map((entry) => entry.targetId);
}

export async function captureDeepResearchTargetBaseline(
  client: ChromeClient,
): Promise<DeepResearchTargetBaseline[]> {
  const scan = await readDeepResearchTargetResult(client);
  if (!scan) {
    throw new Error("Deep Research target baseline capture unavailable");
  }
  return scan.targetBaseline;
}

async function readDeepResearchTargetOwnerTurnMetadata(
  rawClient: {
    send: (
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string,
    ) => Promise<unknown>;
  },
  frameId: string,
  pageSessionId?: string,
): Promise<DeepResearchTurnMetadata | null> {
  const owner = (await rawClient
    .send("DOM.getFrameOwner", { frameId }, pageSessionId)
    .catch(() => null)) as { backendNodeId?: number } | null;
  if (typeof owner?.backendNodeId !== "number") {
    return null;
  }
  const resolved = (await rawClient
    .send("DOM.resolveNode", { backendNodeId: owner.backendNodeId }, pageSessionId)
    .catch(() => null)) as { object?: { objectId?: string } } | null;
  const objectId = resolved?.object?.objectId;
  if (!objectId) {
    return null;
  }
  try {
    const response = (await rawClient
      .send(
        "Runtime.callFunctionOn",
        {
          objectId,
          functionDeclaration: `function() {
            const turns = ${buildConversationTurnListExpression()};
            const index = turns.findIndex((turn) => turn === this || turn.contains?.(this));
            if (index < 0) return null;
            const turn = turns[index];
            const assistantSelector = ${JSON.stringify(ASSISTANT_ROLE_SELECTOR)};
            const messageRoot =
              (turn.matches?.(assistantSelector) ? turn : null) ||
              turn.querySelector?.(assistantSelector) ||
              turn.querySelector?.('.agent-turn') ||
              (turn.querySelector?.('iframe[src*="connector_openai_deep_research"], iframe[src*="deep-research"]')
                ? turn
                : null) ||
              null;
            if (!messageRoot) return null;
            const normalizeMessageId = (value) => {
              const candidate = typeof value === 'string' ? value.trim() : '';
              return candidate &&
                !/^request-web:/i.test(candidate) &&
                !/^conversation-turn-\\d+$/i.test(candidate)
                ? candidate
                : null;
            };
            // The outer conversation-turn ID is authoritative. Nested app nodes
            // can expose request-WEB:* IDs that are not conversation-record IDs.
            const messageIdCandidates = [
              turn.getAttribute?.('data-turn-id') ||
                null,
              turn.getAttribute?.('data-turn-id-container') ||
                null,
              turn.getAttribute?.('data-message-id') ||
                null,
              messageRoot.getAttribute?.('data-message-id') ||
                null,
              messageRoot.querySelector?.('[data-message-id]')?.getAttribute?.('data-message-id') ||
                null,
              messageRoot.getAttribute?.('data-turn-id') ||
                null,
              messageRoot.querySelector?.('[data-turn-id]')?.getAttribute?.('data-turn-id') ||
                null,
              messageRoot.getAttribute?.('data-turn-id-container') ||
                null,
              messageRoot.querySelector?.('[data-turn-id-container]')?.getAttribute?.('data-turn-id-container') ||
                null,
            ];
            const messageId = messageIdCandidates.map(normalizeMessageId).find(Boolean) || null;
            const turnId =
              messageRoot.getAttribute?.('data-testid') ||
              turn.getAttribute?.('data-testid') ||
              null;
            const modelSlug =
              messageRoot.getAttribute?.('data-message-model-slug') ||
              turn.getAttribute?.('data-message-model-slug') ||
              messageRoot.querySelector?.('[data-message-model-slug]')?.getAttribute?.('data-message-model-slug') ||
              null;
            return { messageId, turnId, turnIndex: index, modelSlug };
          }`,
          returnByValue: true,
        },
        pageSessionId,
      )
      .catch(() => null)) as { result?: { value?: unknown } } | null;
    return normalizeDeepResearchTurnMetadata(response?.result?.value);
  } finally {
    await rawClient
      .send("Runtime.releaseObject", { objectId }, pageSessionId)
      .catch(() => undefined);
  }
}

function buildDeepResearchConversationRecordMetadataExpression(
  messageId: string | null,
  timeoutMs = 8_000,
  expectedTurnIndex?: number,
  expectedConversationId?: string,
  expectedUserMessageId?: string,
): string {
  return `(async () => {
    // oracle-deep-research-conversation-record-metadata
    const expectedMessageId = ${JSON.stringify(messageId)};
    const expectedTurnIndex = ${JSON.stringify(expectedTurnIndex ?? null)};
    const expectedConversationId = ${JSON.stringify(expectedConversationId ?? null)};
    const expectedUserMessageId = ${JSON.stringify(expectedUserMessageId ?? null)};
    const asString = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
    const normalizePromptComparable = (value) =>
      String(value || '')
        .replace(/\\r\\n?/g, '\\n')
        .trim()
        .replace(/^@?deep research\\b[ \\t\\n]*/i, '')
        .trim();
    const readDomBinding = () => {
      if (expectedMessageId) return null;
      const turns = ${buildConversationTurnListExpression()};
      const reportTurn = turns[expectedTurnIndex];
      if (!reportTurn) return null;
      const reportRole = reportTurn?.getAttribute?.('data-message-author-role') ||
        reportTurn?.getAttribute?.('data-turn') ||
        (reportTurn?.querySelector?.('[data-message-author-role="assistant"], [data-turn="assistant"], .agent-turn')
          ? 'assistant'
          : null);
      if (reportRole !== 'assistant') return null;
      const priorDomUsers = [];
      for (let index = 0; index < expectedTurnIndex; index += 1) {
        const candidate = turns[index];
        const role = candidate?.getAttribute?.('data-message-author-role') ||
          candidate?.getAttribute?.('data-turn') ||
          (candidate?.querySelector?.('[data-message-author-role="user"], [data-turn="user"]')
            ? 'user'
            : null);
        if (role === 'user') priorDomUsers.push(candidate);
      }
      const priorDomUser = priorDomUsers[priorDomUsers.length - 1] || null;
      const priorDomText = normalizePromptComparable(
        priorDomUser?.innerText || priorDomUser?.textContent || '',
      );
      if (!priorDomUser || !priorDomText) return null;
      const nodeKey = (node) => asString(
        node?.getAttribute?.('data-testid') ||
        node?.getAttribute?.('data-turn-id') ||
        node?.getAttribute?.('data-turn-id-container'),
      );
      const transientNodeKey = (node) => {
        const values = [
          node?.getAttribute?.('data-message-id'),
          node?.getAttribute?.('data-turn-id'),
          node?.getAttribute?.('data-turn-id-container'),
          node?.querySelector?.('[data-message-id]')?.getAttribute?.('data-message-id'),
          node?.querySelector?.('[data-turn-id]')?.getAttribute?.('data-turn-id'),
          node?.querySelector?.('[data-turn-id-container]')?.getAttribute?.('data-turn-id-container'),
        ].map(asString).filter(Boolean);
        return values.length > 0 ? Array.from(new Set(values)).join('\\n') : null;
      };
      const recordMessageIds = (node) => Array.from(new Set([
        node?.getAttribute?.('data-message-id'),
        node?.querySelector?.('[data-message-id]')?.getAttribute?.('data-message-id'),
        node?.getAttribute?.('data-turn-id'),
        node?.querySelector?.('[data-turn-id]')?.getAttribute?.('data-turn-id'),
        node?.getAttribute?.('data-turn-id-container'),
        node?.querySelector?.('[data-turn-id-container]')?.getAttribute?.('data-turn-id-container'),
      ].map(asString).filter((candidate) =>
        candidate &&
        !/^request-web:/i.test(candidate) &&
        !/^conversation-turn-\\d+$/i.test(candidate)
      )));
      return {
        priorDomText,
        priorUserOrdinal: priorDomUsers.length - 1,
        priorUserKey: nodeKey(priorDomUser),
        priorUserMessageIds: recordMessageIds(priorDomUser),
        reportTurnKey: nodeKey(reportTurn),
        reportTransientKey: transientNodeKey(reportTurn),
      };
    };
    try {
      const protocol = String(location.protocol || '').toLowerCase();
      const hostname = String(location.hostname || '').toLowerCase();
      const port = String(location.port || '');
      const allowedHostname = hostname === 'chatgpt.com' || hostname === 'chat.openai.com';
      if (protocol !== 'https:' || !allowedHostname || (port && port !== '443')) return null;
      const conversationMatch = String(location.pathname || '').match(/\\/c\\/([^/?#]+)/);
      const conversationId = conversationMatch?.[1] || null;
      if (
        !conversationId ||
        (expectedConversationId && conversationId !== expectedConversationId) ||
        (!expectedMessageId && !Number.isInteger(expectedTurnIndex))
      ) return null;
      const initialDomBinding = expectedMessageId ? null : readDomBinding();
      if (!expectedMessageId && !initialDomBinding) return null;

      // This runs inside the user's authenticated ChatGPT page. The bearer token
      // never leaves that browser context; only the compact, allowlisted turn
      // metadata below is returned over CDP.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), ${JSON.stringify(timeoutMs)});
      let record;
      try {
        const authResponse = await fetch('/api/auth/session', {
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          signal: controller.signal,
        });
        if (!authResponse.ok) return null;
        const auth = await authResponse.json();
        const accessToken = asString(auth?.accessToken);
        if (!accessToken) return null;
        const recordResponse = await fetch(
          '/backend-api/conversation/' + encodeURIComponent(conversationId),
          {
            credentials: 'same-origin',
            cache: 'no-store',
            redirect: 'error',
            signal: controller.signal,
            headers: { authorization: 'Bearer ' + accessToken },
          },
        );
        if (!recordResponse.ok) return null;
        record = await recordResponse.json();
      } finally {
        clearTimeout(timeout);
      }
      const mapping = record?.mapping;
      if (!mapping || typeof mapping !== 'object') return null;

      const currentBranch = [];
      const seen = new Set();
      let cursor = record?.current_node;
      if (typeof cursor !== 'string' || !cursor) return null;
      let branchInvalid = false;
      while (typeof cursor === 'string' && cursor) {
        if (seen.has(cursor) || currentBranch.length >= 10_000) {
          branchInvalid = true;
          break;
        }
        seen.add(cursor);
        const node = mapping[cursor];
        if (!node) {
          branchInvalid = true;
          break;
        }
        currentBranch.push(node);
        if (node.parent == null) {
          cursor = null;
          break;
        }
        if (typeof node.parent !== 'string' || !node.parent) {
          branchInvalid = true;
          break;
        }
        cursor = node.parent;
      }
      if (branchInvalid) return null;
      currentBranch.reverse();
      const messageText = (message) => {
        const content = message?.content;
        if (typeof content?.text === 'string') return content.text;
        if (Array.isArray(content?.parts)) {
          return content.parts.filter((part) => typeof part === 'string').join('\\n');
        }
        return '';
      };
      let owner = null;
      let priorUser = null;
      if (expectedMessageId) {
        const matchingBranchOwners = currentBranch.filter(
          (node) =>
            node?.message?.id === expectedMessageId &&
            node?.message?.author?.role === 'assistant',
        );
        if (matchingBranchOwners.length !== 1) return null;
        owner = matchingBranchOwners[0];
      } else {
        const priorDomText = initialDomBinding?.priorDomText;
        const priorUserOrdinal = initialDomBinding?.priorUserOrdinal;
        const priorUserMessageIds = initialDomBinding?.priorUserMessageIds;
        if (
          !priorDomText ||
          !Number.isInteger(priorUserOrdinal) ||
          !Array.isArray(priorUserMessageIds) ||
          priorUserMessageIds.length === 0
        ) return null;
        const branchUsers = currentBranch.filter(
          (node) => node?.message?.author?.role === 'user',
        );
        const matchingBranchUsers = branchUsers.filter((node) => {
          const message = node?.message;
          return Boolean(
            priorUserMessageIds.includes(asString(message?.id)) &&
            asString(message?.metadata?.deep_research_version) &&
            normalizePromptComparable(messageText(message)) === priorDomText
          );
        });
        // The prior visible user turn must name exactly one record message on
        // the active branch; prompt/ordinal agreement alone is only heuristic.
        if (matchingBranchUsers.length !== 1) return null;
        priorUser = matchingBranchUsers[0];
        const priorMessage = priorUser?.message;
        const requestId = asString(priorMessage?.metadata?.request_id);
        if (!requestId) return null;
        const priorUserIndex = currentBranch.indexOf(priorUser);
        if (priorUserIndex < 0) return null;
        const belongsToPriorUserSegment = (candidate) => {
          const visited = new Set();
          let cursor = candidate;
          while (cursor) {
            const key = asString(cursor?.message?.id) || asString(cursor?.id);
            if (key && visited.has(key)) return false;
            if (key) visited.add(key);
            const parentId = asString(cursor?.parent);
            if (!parentId) return false;
            const parent = mapping[parentId];
            if (!parent) return false;
            if (parent?.message?.author?.role === 'user') {
              return parent?.message?.id === priorMessage?.id;
            }
            cursor = parent;
          }
          return false;
        };
        const allMatchingOwners = Object.values(mapping).filter((node) => {
          const ownerMessage = node?.message;
          return (
            ownerMessage?.author?.role === 'assistant' &&
            ownerMessage?.recipient === 'api_tool.call_tool' &&
            ownerMessage?.end_turn !== true &&
            asString(ownerMessage?.metadata?.request_id) === requestId &&
            belongsToPriorUserSegment(node)
          );
        });
        // Regenerated sibling reports can share the exact user message. Without
        // a report-specific record ID, more than one eligible owner is ambiguous.
        if (allMatchingOwners.length !== 1) return null;
        const segment = [];
        for (const node of currentBranch.slice(priorUserIndex + 1)) {
          if (node?.message?.author?.role === 'user') break;
          segment.push(node);
        }
        const matchingOwners = segment.filter((node) => {
          const ownerMessage = node?.message;
          return (
            ownerMessage?.author?.role === 'assistant' &&
            ownerMessage?.recipient === 'api_tool.call_tool' &&
            ownerMessage?.end_turn !== true &&
            asString(ownerMessage?.metadata?.request_id) === requestId
          );
        });
        if (matchingOwners.length !== 1) return null;
        owner = matchingOwners[0];
        if (owner?.message?.id !== allMatchingOwners[0]?.message?.id) return null;
        if (!owner || !priorUser) return null;
      }

      const ownerMessageId = asString(owner?.message?.id);
      if (!ownerMessageId || owner?.message?.author?.role !== 'assistant') return null;
      const ownerIndex = currentBranch.findIndex(
        (node) => node === owner || node?.message?.id === ownerMessageId,
      );
      if (ownerIndex < 0) return null;

      priorUser = priorUser || currentBranch
        .slice(0, ownerIndex)
        .reverse()
        .find((node) => node?.message?.author?.role === 'user');
      if (!priorUser) return null;
      if (
        expectedUserMessageId &&
        asString(priorUser?.message?.id) !== expectedUserMessageId
      ) return null;
      const priorRequestId = asString(priorUser?.message?.metadata?.request_id);
      const ownerRequestId = asString(owner?.message?.metadata?.request_id);
      if (priorRequestId && ownerRequestId && priorRequestId !== ownerRequestId) return null;
      const resolvedRequestId = priorRequestId || ownerRequestId;
      const terminalCandidates = owner?.message?.end_turn === true ? [owner] : [];
      for (const node of currentBranch.slice(ownerIndex + 1)) {
        const role = node?.message?.author?.role;
        if (role === 'user') break;
        if (
          role === 'assistant' &&
          node?.message?.id !== ownerMessageId &&
          node?.message?.end_turn === true
        ) {
          terminalCandidates.push(node);
        }
      }
      if (terminalCandidates.length !== 1) return null;
      const finalAssistant = terminalCandidates[0];
      const finalRequestId = asString(finalAssistant?.message?.metadata?.request_id);
      if (resolvedRequestId && finalRequestId && finalRequestId !== resolvedRequestId) return null;

      const metadata = owner?.message?.metadata || {};
      const modelSlug = asString(metadata.model_slug);
      const defaultModelSlug = asString(metadata.default_model_slug);
      if (!expectedMessageId) {
        const finalDomBinding = readDomBinding();
        if (
          !initialDomBinding ||
          !finalDomBinding ||
          finalDomBinding.priorDomText !== initialDomBinding.priorDomText ||
          finalDomBinding.priorUserOrdinal !== initialDomBinding.priorUserOrdinal ||
          finalDomBinding.priorUserKey !== initialDomBinding.priorUserKey ||
          finalDomBinding.priorUserMessageIds.join('\\n') !==
            initialDomBinding.priorUserMessageIds.join('\\n') ||
          finalDomBinding.reportTurnKey !== initialDomBinding.reportTurnKey
          || !initialDomBinding.reportTransientKey
          || finalDomBinding.reportTransientKey !== initialDomBinding.reportTransientKey
        ) return null;
      }
      const finalConversationMatch = String(location.pathname || '').match(/\\/c\\/([^/?#]+)/);
      if (finalConversationMatch?.[1] !== conversationId) return null;
      return {
        messageId: ownerMessageId,
        finalMessageId: asString(finalAssistant?.message?.id),
        // Preserve the record's exact, distinct fields. The owner message's
        // model_slug does not claim the identity of hidden research workers.
        modelSlug,
        resolvedModelSlug: asString(metadata.resolved_model_slug),
        defaultModelSlug,
        deepResearchVersion: asString(priorUser?.message?.metadata?.deep_research_version),
        metadataSource: 'chatgpt-conversation-record',
      };
    } catch {
      return null;
    }
  })()`;
}

async function enrichDeepResearchTurnMetadataFromConversationRecord(
  rawClient: {
    send: (
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string,
    ) => Promise<unknown>;
  },
  meta: DeepResearchTurnMetadata | null,
  pageSessionId?: string,
  expectedConversationId?: string,
  expectedUserMessageId?: string,
): Promise<DeepResearchTurnMetadata | null> {
  const normalized = normalizeDeepResearchTurnMetadata(meta);
  const messageId = normalized?.messageId;
  const turnIndex = normalized?.turnIndex;
  if (!normalized || (!messageId && typeof turnIndex !== "number")) {
    return normalized;
  }
  const response = (await rawClient
    .send(
      "Runtime.evaluate",
      {
        expression: buildDeepResearchConversationRecordMetadataExpression(
          messageId ?? null,
          8_000,
          messageId || typeof turnIndex !== "number" ? undefined : turnIndex,
          expectedConversationId,
          expectedUserMessageId,
        ),
        awaitPromise: true,
        returnByValue: true,
      },
      pageSessionId,
    )
    .catch(() => null)) as { result?: { value?: unknown } } | null;
  const recordMeta = normalizeDeepResearchTurnMetadata(response?.result?.value);
  if (
    !recordMeta?.messageId ||
    (messageId && recordMeta.messageId !== messageId) ||
    recordMeta.metadataSource !== "chatgpt-conversation-record"
  ) {
    return expectedConversationId ? null : normalized;
  }
  return normalizeDeepResearchTurnMetadata({
    ...normalized,
    messageId: recordMeta.messageId,
    // Once the authenticated conversation record is authoritative, absence is
    // evidence too. Never backfill a missing record field from DOM attributes.
    finalMessageId: recordMeta.finalMessageId ?? null,
    modelSlug: recordMeta.modelSlug ?? null,
    resolvedModelSlug: recordMeta.resolvedModelSlug ?? null,
    defaultModelSlug: recordMeta.defaultModelSlug ?? null,
    deepResearchVersion: recordMeta.deepResearchVersion ?? null,
    metadataSource: recordMeta.metadataSource,
  });
}

export async function enrichDeepResearchTurnMetadataFromConversationRecordForTest(
  rawClient: {
    send: (
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string,
    ) => Promise<unknown>;
  },
  meta: DeepResearchTurnMetadata | null,
  pageSessionId?: string,
  expectedConversationId?: string,
  expectedUserMessageId?: string,
): Promise<DeepResearchTurnMetadata | null> {
  return enrichDeepResearchTurnMetadataFromConversationRecord(
    rawClient,
    meta,
    pageSessionId,
    expectedConversationId,
    expectedUserMessageId,
  );
}

export function buildDeepResearchConversationRecordMetadataExpressionForTest(
  messageId: string,
  timeoutMs?: number,
  expectedConversationId?: string,
  expectedUserMessageId?: string,
): string {
  return buildDeepResearchConversationRecordMetadataExpression(
    messageId,
    timeoutMs,
    undefined,
    expectedConversationId,
    expectedUserMessageId,
  );
}

export function buildDeepResearchActiveRecordMetadataExpressionForTest(
  turnIndex: number,
  timeoutMs?: number,
  expectedConversationId?: string,
  expectedUserMessageId?: string,
): string {
  return buildDeepResearchConversationRecordMetadataExpression(
    null,
    timeoutMs,
    turnIndex,
    expectedConversationId,
    expectedUserMessageId,
  );
}

function buildDeepResearchCitationSourcesExpression(scope?: {
  rootComparable?: string;
  reportNeedle?: string;
}): string {
  return `(() => {
    // oracle-deep-research-citation-sources
    const expectedRootComparable = ${JSON.stringify(scope?.rootComparable ?? null)};
    const expectedReportNeedle = ${JSON.stringify(scope?.reportNeedle ?? null)};
    const asLabel = (value) => typeof value === 'string' && value.trim()
      ? value.trim().slice(0, 500)
      : null;
    const sanitizeUrl = (value) => {
      const raw = typeof value === 'string' ? value.trim() : '';
      if (!raw || raw.length > 4096) return null;
      try {
        const parsed = new URL(raw, location.href);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
      } catch {
        return null;
      }
    };
    const sources = [];
    const observedIndexes = new Set();
    const normalizeComparable = (value) =>
      String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
    const isHiddenElement = (element) => {
      if (!element) return false;
      if (
        element.hidden ||
        element.getAttribute?.('aria-hidden') === 'true' ||
        typeof element.getAttribute?.('hidden') === 'string'
      ) return true;
      const inlineStyle = String(element.getAttribute?.('style') || '').toLowerCase();
      if (/display\\s*:\\s*none|visibility\\s*:\\s*(?:hidden|collapse)/.test(inlineStyle)) {
        return true;
      }
      if (typeof getComputedStyle === 'function') {
        try {
          const style = getComputedStyle(element);
          if (
            style?.display === 'none' ||
            style?.visibility === 'hidden' ||
            style?.visibility === 'collapse'
          ) return true;
        } catch {
          return true;
        }
      }
      return false;
    };
    const isVisibleInDocument = (element) => {
      let cursor = element;
      while (cursor) {
        if (isHiddenElement(cursor)) return false;
        cursor = cursor.parentElement;
      }
      return true;
    };
    let scanRoot = document;
    if (expectedRootComparable && expectedReportNeedle) {
      const roots = typeof document.querySelectorAll === 'function'
        ? Array.from(document.querySelectorAll('article, main, [role="main"]'))
        : [];
      const matchingRoots = roots.filter((candidate) => {
        const text = normalizeComparable(candidate?.innerText || candidate?.textContent || '');
        return isVisibleInDocument(candidate) && text.includes(expectedReportNeedle);
      });
      const root = matchingRoots.sort((a, b) =>
        normalizeComparable(a?.innerText || a?.textContent || '').length -
        normalizeComparable(b?.innerText || b?.textContent || '').length
      )[0] || (isVisibleInDocument(document.body) ? document.body : null);
      const rootText = normalizeComparable(root?.innerText || root?.textContent || '');
      if (!root || rootText !== expectedRootComparable) {
        return null;
      }
      scanRoot = root;
    }
    const isVisibleWithinRoot = (element) => {
      let cursor = element;
      let sawRoot = scanRoot === document;
      while (cursor) {
        if (isHiddenElement(cursor)) return false;
        if (cursor === scanRoot) sawRoot = true;
        cursor = cursor.parentElement;
      }
      return sawRoot;
    };
    const chips = Array.from(scanRoot.querySelectorAll(
      'sup[data-citation-interactive="true"][data-citation-index]'
    )).filter(isVisibleWithinRoot);
    for (const chip of chips) {
      const index = Number(chip.getAttribute('data-citation-index'));
      if (!Number.isInteger(index) || index < 1 || index > 999) continue;
      observedIndexes.add(index);
      const fiberKey = Object.keys(chip).find((key) => key.startsWith('__reactFiber$'));
      if (!fiberKey) continue;
      let fiber = chip[fiberKey];
      const matchingItems = [];
      for (let depth = 0; fiber && depth < 12; depth += 1, fiber = fiber.return) {
        const candidate = fiber?.memoizedProps?.item;
        if (candidate && Number(candidate.index) === index) {
          matchingItems.push(candidate);
        }
      }
      const candidateUrls = Array.from(
        new Set(matchingItems.map((item) => sanitizeUrl(item?.url)).filter(Boolean))
      );
      // Multiple same-index React items can occur while the tree is updating.
      // If they disagree, there is no exact chip-to-destination binding.
      if (candidateUrls.length !== 1) continue;
      const url = candidateUrls[0];
      const item = matchingItems.find((candidate) => sanitizeUrl(candidate?.url) === url);
      if (!item) continue;
      const records = Array.isArray(item.reference?.items) ? item.reference.items : [];
      const matchingRecord = records.find((record) => sanitizeUrl(record?.url) === url);
      const label =
        asLabel(matchingRecord?.title) ||
        asLabel(item.attribution) ||
        asLabel(matchingRecord?.attribution) ||
        undefined;
      sources.push({ index, url, ...(label ? { label } : {}) });
    }
    return {
      observedIndexes: Array.from(observedIndexes).sort((a, b) => a - b),
      sources,
    };
  })()`;
}

function normalizeDeepResearchCitationSources(
  value: unknown,
): DeepResearchCitationSourceScan | null {
  const legacyArray = Array.isArray(value);
  const rawObject =
    !legacyArray && value && typeof value === "object"
      ? (value as { observedIndexes?: unknown; sources?: unknown })
      : null;
  const rawSources = legacyArray ? value : rawObject?.sources;
  const rawObservedIndexes = legacyArray
    ? value.map((item) =>
        item && typeof item === "object" ? (item as { index?: unknown }).index : null,
      )
    : rawObject?.observedIndexes;
  if (!Array.isArray(rawSources) || !Array.isArray(rawObservedIndexes)) return null;

  const observedIndexes = Array.from(
    new Set(
      rawObservedIndexes.filter(
        (index): index is number =>
          typeof index === "number" && Number.isInteger(index) && index >= 1 && index <= 999,
      ),
    ),
  ).sort((a, b) => a - b);
  const observedIndexSet = new Set(observedIndexes);
  const seen = new Set<string>();
  const normalized: DeepResearchCitationSource[] = [];
  for (const item of rawSources) {
    if (!item || typeof item !== "object") continue;
    const raw = item as { index?: unknown; url?: unknown; label?: unknown };
    const index =
      typeof raw.index === "number" && Number.isInteger(raw.index) && raw.index >= 1
        ? raw.index
        : null;
    const rawUrl = typeof raw.url === "string" ? raw.url.trim() : "";
    if (
      index === null ||
      index > 999 ||
      !observedIndexSet.has(index) ||
      !rawUrl ||
      rawUrl.length > 4096
    ) {
      continue;
    }
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    const key = `${index}\n${url.href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = typeof raw.label === "string" ? raw.label.trim().slice(0, 500) : "";
    normalized.push({ index, url: url.href, ...(label ? { label } : {}) });
  }
  return { observedIndexes, sources: normalized };
}

function applyDeepResearchCitationSources(
  markdown: string,
  sources: readonly DeepResearchCitationSource[],
  citationMarkerNonce: string | undefined,
  observedIndexes: readonly number[],
  scanAvailable: boolean,
  declaredCitationCount = 0,
): { markdown: string; status?: DeepResearchCitationStatus } {
  const marker = /^[a-f0-9]{32}$/.test(citationMarkerNonce ?? "")
    ? new RegExp(`\\[\\[ORACLE_DEEP_RESEARCH_CITATION_${citationMarkerNonce}_(\\d+)\\]\\]`, "g")
    : null;
  const markerIndexes = marker
    ? Array.from(new Set(Array.from(markdown.matchAll(marker), (match) => Number(match[1]))))
    : [];
  const declaredIndexes =
    Number.isInteger(declaredCitationCount) && declaredCitationCount > 0
      ? Array.from({ length: Math.min(declaredCitationCount, 999) }, (_value, index) => index + 1)
      : [];
  const indexes = Array.from(new Set([...markerIndexes, ...observedIndexes, ...declaredIndexes]))
    .filter((index) => Number.isInteger(index) && index >= 1 && index <= 999)
    .sort((a, b) => a - b);

  const urlsByIndex = new Map<number, string[]>();
  for (const source of sources) {
    const urls = urlsByIndex.get(source.index) ?? [];
    if (!urls.includes(source.url)) urls.push(source.url);
    urlsByIndex.set(source.index, urls);
  }
  const exactUrlByIndex = new Map<number, string>();
  for (const index of indexes) {
    const urls = urlsByIndex.get(index) ?? [];
    // Contradictory URLs for one displayed index are not guessed between.
    if (urls.length === 1) exactUrlByIndex.set(index, urls[0]);
  }
  const markerIndexSet = new Set(markerIndexes);
  const linkedIndexes = indexes.filter(
    (index) => markerIndexSet.has(index) && exactUrlByIndex.has(index),
  );
  const rewrittenMarkdown = marker
    ? markdown.replace(marker, (_match, rawIndex: string) => {
        const index = Number(rawIndex);
        const url = exactUrlByIndex.get(index);
        return url ? `[${index}](<${url}>)` : `[${index}]`;
      })
    : markdown;
  return {
    markdown: rewrittenMarkdown,
    ...(scanAvailable
      ? {
          status: {
            total: indexes.length,
            linked: linkedIndexes.length,
            missingIndexes: indexes.filter((index) => !linkedIndexes.includes(index)),
          },
        }
      : {}),
  };
}

async function readDeepResearchCitationSources(
  rawClient: {
    send: (
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string,
    ) => Promise<unknown>;
  },
  sessionId: string,
  contextId: number | undefined,
  scope?: { rootComparable?: string; reportNeedle?: string },
): Promise<DeepResearchCitationSourceScan | null> {
  if (typeof contextId !== "number" || !scope?.rootComparable || !scope?.reportNeedle) {
    return null;
  }
  const response = (await rawClient
    .send(
      "Runtime.evaluate",
      {
        expression: buildDeepResearchCitationSourcesExpression(scope),
        contextId,
        returnByValue: true,
      },
      sessionId,
    )
    .catch(() => null)) as { result?: { value?: unknown } } | null;
  return normalizeDeepResearchCitationSources(response?.result?.value);
}

export function buildDeepResearchCitationSourcesExpressionForTest(scope?: {
  rootComparable?: string;
  reportNeedle?: string;
}): string {
  return buildDeepResearchCitationSourcesExpression(scope);
}

export function applyDeepResearchCitationSourcesForTest(
  markdown: string,
  sources: readonly DeepResearchCitationSource[],
  options: {
    citationMarkerNonce?: string;
    observedIndexes?: readonly number[];
    scanAvailable?: boolean;
    declaredCitationCount?: number;
  } = {},
): { markdown: string; status?: DeepResearchCitationStatus } {
  return applyDeepResearchCitationSources(
    markdown,
    sources,
    options.citationMarkerNonce,
    options.observedIndexes ?? sources.map((source) => source.index),
    options.scanAvailable ?? true,
    options.declaredCitationCount ?? 0,
  );
}

export function normalizeDeepResearchCitationSourcesForTest(
  value: unknown,
): DeepResearchCitationSourceScan | null {
  return normalizeDeepResearchCitationSources(value);
}

async function readDeepResearchTargetSession(
  rawClient: {
    send: (
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string,
    ) => Promise<unknown>;
    on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
    removeListener?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  },
  sessionId: string,
  targetUrl: string,
): Promise<DeepResearchTargetSessionResult> {
  const defaultContextByFrame = new Map<string, number>();
  const onExecutionContextCreated = (params: unknown, eventSessionId?: unknown) => {
    if (typeof eventSessionId === "string" && eventSessionId !== sessionId) return;
    const context = (
      params as {
        context?: {
          id?: number;
          auxData?: { frameId?: string; isDefault?: boolean };
        };
      }
    )?.context;
    const frameId = context?.auxData?.frameId;
    if (
      typeof context?.id === "number" &&
      typeof frameId === "string" &&
      context.auxData?.isDefault === true
    ) {
      defaultContextByFrame.set(frameId, context.id);
    }
  };
  rawClient.on?.("Runtime.executionContextCreated", onExecutionContextCreated);
  try {
    // Runtime.enable replays existing execution contexts. Capture the default
    // (main-world) context for each nested report frame; React citation metadata
    // is intentionally not visible from the isolated world used for report text.
    await rawClient.send("Runtime.enable", {}, sessionId).catch(() => undefined);
    await rawClient.send("Page.enable", {}, sessionId).catch(() => undefined);

    const frameTree = (await rawClient
      .send("Page.getFrameTree", {}, sessionId)
      .catch(() => null)) as { frameTree?: DeepResearchFrameTree } | null;
    const ownerFrameId = frameTree?.frameTree?.frame?.id;
    if (!isConfirmedDeepResearchTarget(targetUrl, frameTree?.frameTree)) {
      return { confirmed: false, read: null };
    }
    const frameIds = collectDeepResearchFrameIds(frameTree?.frameTree);
    let best: DeepResearchFrameStatus | null = null;

    const addCitationEvidence = async (
      value: DeepResearchFrameStatus,
      frameId: string | undefined,
    ): Promise<DeepResearchFrameStatus> => {
      if (!value.completed || !value.text) return value;
      const citationScan = await readDeepResearchCitationSources(
        rawClient,
        sessionId,
        frameId ? defaultContextByFrame.get(frameId) : undefined,
        {
          rootComparable: value.citationRootComparable,
          reportNeedle: value.citationReportNeedle,
        },
      );
      const applied = applyDeepResearchCitationSources(
        value.text,
        citationScan?.sources ?? [],
        value.citationMarkerNonce,
        citationScan?.observedIndexes ?? [],
        hasVerifiedDeepResearchCitationUiContract(citationScan, value.declaredCitationCount),
        value.declaredCitationCount ?? 0,
      );
      return {
        ...value,
        text: applied.markdown,
        ...(applied.status ? { citationStatus: applied.status } : {}),
      };
    };

    for (const frameId of frameIds) {
      const world = (await rawClient
        .send(
          "Page.createIsolatedWorld",
          {
            frameId,
            worldName: "oracle-deep-research",
            grantUniveralAccess: true,
          },
          sessionId,
        )
        .catch(() => null)) as { executionContextId?: number } | null;
      if (typeof world?.executionContextId !== "number") {
        continue;
      }
      const value = await evaluateDeepResearchFrameStatus(
        rawClient,
        sessionId,
        world.executionContextId,
      );
      if (value?.completed) {
        const completedValue = value.text
          ? { ...value, contentSha256: fingerprintDeepResearchContent(value.text) }
          : value;
        return {
          confirmed: true,
          read: await addCitationEvidence(completedValue, frameId),
          frameId: ownerFrameId,
        };
      }
      if ((value?.textLength ?? 0) > (best?.textLength ?? 0) || value?.inProgress) {
        best = value;
      }
    }

    const topFrameValue = await evaluateDeepResearchFrameStatus(rawClient, sessionId);
    if (topFrameValue?.completed) {
      const completedValue = topFrameValue.text
        ? {
            ...topFrameValue,
            contentSha256: fingerprintDeepResearchContent(topFrameValue.text),
          }
        : topFrameValue;
      return {
        confirmed: true,
        read: await addCitationEvidence(completedValue, ownerFrameId),
        frameId: ownerFrameId,
      };
    }
    if ((topFrameValue?.textLength ?? 0) > (best?.textLength ?? 0) || topFrameValue?.inProgress) {
      best = topFrameValue;
    }

    return { confirmed: true, read: best, frameId: ownerFrameId };
  } finally {
    // Each call installs a fresh execution-context listener. Runtime.enable is
    // idempotent and Chrome need not replay existing contexts on a second call,
    // so disable this Oracle-owned child session before the stable reread/poll.
    // The next enable then produces a fresh, session-scoped main-world map.
    await rawClient.send("Runtime.disable", {}, sessionId).catch(() => undefined);
    rawClient.removeListener?.("Runtime.executionContextCreated", onExecutionContextCreated);
  }
}

async function evaluateDeepResearchFrameStatus(
  rawClient: {
    send: (
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string,
    ) => Promise<unknown>;
  },
  sessionId: string,
  contextId?: number,
): Promise<DeepResearchFrameStatus | null> {
  const response = (await rawClient
    .send(
      "Runtime.evaluate",
      {
        expression: buildDeepResearchFrameStatusExpression(),
        returnByValue: true,
        ...(typeof contextId === "number" ? { contextId } : {}),
      },
      sessionId,
    )
    .catch(() => null)) as { result?: { value?: DeepResearchFrameStatus } } | null;
  return response?.result?.value ?? null;
}

function isDeepResearchTarget(url: string, type: string): boolean {
  return type.toLowerCase() === "iframe" || isDeepResearchFrameDescriptor(url);
}

function isConfirmedDeepResearchTarget(
  targetUrl: string,
  tree: DeepResearchFrameTree | undefined,
): boolean {
  return isDeepResearchFrameDescriptor(targetUrl) || Boolean(findDeepResearchFrameId(tree));
}

function isDeepResearchFrameDescriptor(url: string, name = ""): boolean {
  const descriptor = `${url}\n${name}`.toLowerCase();
  return (
    descriptor.includes("connector_openai_deep_research") || descriptor.includes("deep-research")
  );
}

function findDeepResearchFrameId(tree: DeepResearchFrameTree | undefined): string | null {
  return collectPageDeepResearchFrameIds(tree)[0] ?? null;
}

function collectPageDeepResearchFrameIds(tree: DeepResearchFrameTree | undefined): string[] {
  if (!tree?.frame) {
    return [];
  }
  const ids: string[] = [];
  if (tree.frame.id && isDeepResearchFrameDescriptor(tree.frame.url ?? "", tree.frame.name ?? "")) {
    ids.push(tree.frame.id);
  }
  for (const child of tree.childFrames ?? []) {
    ids.push(...collectPageDeepResearchFrameIds(child));
  }
  return ids;
}

function collectDeepResearchFrameIds(tree: DeepResearchFrameTree | undefined): string[] {
  if (!tree?.frame) {
    return [];
  }
  const ids: string[] = [];
  const url = tree.frame.url ?? "";
  const name = tree.frame.name ?? "";
  if (
    url.includes("connector_openai_deep_research") ||
    url.includes("deep-research") ||
    name.includes("deep-research") ||
    name === "root"
  ) {
    if (tree.frame.id) {
      ids.push(tree.frame.id);
    }
  }
  for (const child of tree.childFrames ?? []) {
    ids.push(...collectDeepResearchFrameIds(child));
  }
  return ids;
}

function buildDeepResearchFrameStatusExpression(): string {
  // A fresh 128-bit nonce makes serializer-inserted citation markers distinct
  // from any literal marker-like text already present in the report.
  const citationMarkerNonce = randomBytes(16).toString("hex");
  return `(() => {
    const citationMarkerNonce = ${JSON.stringify(citationMarkerNonce)};
    const rawText = document.body?.innerText || '';
    const rawLines = String(rawText || '')
      .split(/\\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
    const reportChromeIndex = rawLines.findIndex((line) => /deep research report/i.test(line));
    const chromeLines = reportChromeIndex >= 0
      ? rawLines.slice(0, reportChromeIndex + 1)
      : rawLines.slice(0, 12);
    const citationCounterLabel =
      '(?:citations?|sources?|cytaty|cytatów|źródła|źródeł)';
    const declaredCitationCounts = [];
    let citationCounterObserved = false;
    for (let index = 0; index < chromeLines.length; index += 1) {
      const line = chromeLines[index] || '';
      const sameLine = line.match(new RegExp(
        '^(?:' + citationCounterLabel + '\\\\s*[:：]?\\\\s*(\\\\d+)|(\\\\d+)\\\\s+' + citationCounterLabel + ')\\\\b',
        'i',
      ));
      if (sameLine) {
        const sameLineCount = Number(sameLine[1] ?? sameLine[2]);
        if (Number.isInteger(sameLineCount) && sameLineCount >= 0 && sameLineCount <= 999) {
          citationCounterObserved = true;
          declaredCitationCounts.push(sameLineCount);
        }
      }
      const standaloneCount = /^\\d+$/.test(line) ? Number(line) : null;
      const nextLine = chromeLines[index + 1] || '';
      if (
        standaloneCount !== null &&
        standaloneCount >= 0 &&
        standaloneCount <= 999 &&
        new RegExp('^' + citationCounterLabel + '\\\\b', 'i').test(nextLine)
      ) {
        citationCounterObserved = true;
        declaredCitationCounts.push(standaloneCount);
      }
    }
    const declaredCitationCount = citationCounterObserved
      ? Math.max(...declaredCitationCounts)
      : undefined;
    const isPlaceholder = (line) => /^(called tool|used tool|użyto narzędzia|narzędzie wywołane)$/i.test(line);
    const isCompletionLine = (line) =>
      /^(research completed|badanie ukończone)\\b/i.test(line);
    const isCounterLine = (line) =>
      /^(\\d+\\s+)?(citation|citations|source|sources|search|searches|cytat|cytaty|cytatów|źródło|źródła|wyszukiwanie|wyszukiwania|wyszukiwań)\\b/i.test(line);
    const normalizeReport = (text) => {
      const lines = String(text || '')
        .split(/\\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !/^\\d+$/.test(line));
      const reportIndex = lines.findIndex((line) => /deep research report/i.test(line));
      const candidates = reportIndex >= 0 ? lines.slice(reportIndex + 1) : lines;
      let started = false;
      const reportLines = candidates.filter((line) => {
        if (!started) {
          if (
            /deep research report/i.test(line) ||
            isCompletionLine(line) ||
            isCounterLine(line) ||
            isPlaceholder(line)
          ) {
            return false;
          }
          started = true;
        }
        return true;
      });
      if (reportLines.length > 1 && reportLines[0] === reportLines[1]) {
        reportLines.shift();
      }
      return reportLines.join('\\n').trim();
    };
    const reportText = normalizeReport(rawText);
    const backslash = String.fromCharCode(92);
    const backtick = String.fromCharCode(96);
    const escapeMarkdownText = (value) => {
      let escaped = String(value || '').split('&').join('&amp;');
      escaped = escaped.split('<').join('&lt;').split('>').join('&gt;');
      for (const char of [backslash, '*', '_', '[', ']', '|']) {
        escaped = escaped.split(char).join(backslash + char);
      }
      return escaped;
    };
    const normalizeInlineText = (value) =>
      escapeMarkdownText(value).replace(/\\s+/g, ' ');
    const childNodesOf = (node) =>
      Array.from(node?.childNodes || node?.children || []);
    const tagNameOf = (node) => String(node?.tagName || '').toUpperCase();
    const isHidden = (element) => {
      if (!element) return false;
      if (
        element.hidden ||
        element.getAttribute?.('aria-hidden') === 'true' ||
        typeof element.getAttribute?.('hidden') === 'string'
      ) return true;
      const inlineStyle = String(element.getAttribute?.('style') || '').toLowerCase();
      if (/display\\s*:\\s*none|visibility\\s*:\\s*(?:hidden|collapse)/.test(inlineStyle)) {
        return true;
      }
      if (typeof getComputedStyle === 'function') {
        try {
          const style = getComputedStyle(element);
          if (
            style?.display === 'none' ||
            style?.visibility === 'hidden' ||
            style?.visibility === 'collapse'
          ) return true;
        } catch {
          return true;
        }
      }
      return false;
    };
    const isVisibleInDocument = (element) => {
      let cursor = element;
      while (cursor) {
        if (isHidden(cursor)) return false;
        cursor = cursor.parentElement;
      }
      return true;
    };
    const codeFence = (value, minimum) => {
      let longest = 0;
      let current = 0;
      for (const char of String(value || '')) {
        current = char === backtick ? current + 1 : 0;
        longest = Math.max(longest, current);
      }
      return backtick.repeat(Math.max(minimum, longest + 1));
    };
    const sanitizeHref = (element) => {
      const raw = element?.getAttribute?.('href') || element?.href || '';
      if (!raw || typeof URL !== 'function') return null;
      try {
        const base = document.baseURI ||
          (typeof location !== 'undefined' ? location.href : 'https://chatgpt.com/');
        const url = new URL(raw, base);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
      } catch {
        return null;
      }
    };
    let serializeNode;
    const preformattedText = (node) => {
      if (!node) return '';
      if (node.nodeType === 3) return String(node.textContent || '');
      if (node.nodeType != null && node.nodeType !== 1) return '';
      if (isHidden(node)) return '';
      const tag = tagNameOf(node);
      if (tag === 'BR') return '\\n';
      if (['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'IFRAME', 'FORM', 'BUTTON', 'SVG', 'IMG'].includes(tag)) {
        return '';
      }
      return childNodesOf(node).map((child) => preformattedText(child)).join('');
    };
    const serializeChildren = (node, depth = 0) =>
      childNodesOf(node).map((child) => serializeNode(child, depth)).join('');
    const serializeList = (element, depth) => {
      const ordered = tagNameOf(element) === 'OL';
      const items = Array.from(element?.children || []).filter((child) => tagNameOf(child) === 'LI');
      return items.map((item, index) => {
        const nested = [];
        const direct = childNodesOf(item).map((child) => {
          const tag = tagNameOf(child);
          if (tag === 'UL' || tag === 'OL') {
            nested.push(serializeList(child, depth + 1));
            return '';
          }
          return serializeNode(child, depth + 1);
        }).join('').replace(/\\s+/g, ' ').trim();
        const prefix = ordered ? String(index + 1) + '. ' : '- ';
        const indent = '  '.repeat(depth);
        const nestedText = nested
          .map((value) => '\\n' + String(value).split('\\n').map((line) => line ? '  ' + line : line).join('\\n'))
          .join('');
        return indent + prefix + direct + nestedText;
      }).join('\\n') + '\\n\\n';
    };
    const serializeTable = (element) => {
      const rows = Array.from(element?.querySelectorAll?.('tr') || []);
      const values = rows.map((row) =>
        Array.from(row.querySelectorAll?.('th, td') || []).map((cell) =>
          serializeChildren(cell).replace(/\\s+/g, ' ').trim()
        )
      ).filter((row) => row.length > 0);
      if (values.length === 0) return '';
      const width = Math.max(...values.map((row) => row.length));
      const pad = (row) => Array.from({ length: width }, (_, index) => row[index] || '');
      const header = pad(values[0]);
      const lines = [
        '| ' + header.join(' | ') + ' |',
        '| ' + header.map(() => '---').join(' | ') + ' |',
        ...values.slice(1).map((row) => '| ' + pad(row).join(' | ') + ' |'),
      ];
      return '\\n\\n' + lines.join('\\n') + '\\n\\n';
    };
    serializeNode = (node, depth = 0) => {
      if (!node) return '';
      if (node.nodeType === 3) return normalizeInlineText(node.textContent || '');
      if (node.nodeType != null && node.nodeType !== 1) return '';
      if (isHidden(node)) return '';
      const tag = tagNameOf(node);
      if (['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'IFRAME', 'FORM', 'BUTTON', 'SVG', 'IMG'].includes(tag)) {
        return '';
      }
      if (/^H[1-6]$/.test(tag)) {
        return '\\n\\n' + '#'.repeat(Number(tag.slice(1))) + ' ' + serializeChildren(node, depth).trim() + '\\n\\n';
      }
      if (tag === 'BR') return '\\n';
      if (tag === 'HR') return '\\n\\n---\\n\\n';
      if (tag === 'STRONG' || tag === 'B') return '**' + serializeChildren(node, depth) + '**';
      if (tag === 'EM' || tag === 'I') return '*' + serializeChildren(node, depth) + '*';
      if (tag === 'A') {
        const label = serializeChildren(node, depth).trim() || normalizeInlineText(node.textContent || '');
        const href = sanitizeHref(node);
        return href ? '[' + (label || href) + '](<' + href + '>)' : label;
      }
      if (
        tag === 'SUP' &&
        node.getAttribute?.('data-citation-interactive') === 'true'
      ) {
        const index = Number(node.getAttribute?.('data-citation-index'));
        if (Number.isInteger(index) && index >= 1 && index <= 999) {
          return '[[ORACLE_DEEP_RESEARCH_CITATION_' + citationMarkerNonce + '_' + String(index) + ']]';
        }
      }
      if (tag === 'PRE') {
        const value = preformattedText(node).replace(/^\\n+|\\n+$/g, '');
        if (!value) return '';
        const fence = codeFence(value, 3);
        return '\\n\\n' + fence + '\\n' + value + '\\n' + fence + '\\n\\n';
      }
      if (tag === 'CODE') {
        const value = preformattedText(node).replace(/\\s+/g, ' ').trim();
        if (!value) return '';
        const fence = codeFence(value, 1);
        const padding = value.startsWith(backtick) || value.endsWith(backtick) ? ' ' : '';
        return fence + padding + value + padding + fence;
      }
      if (tag === 'UL' || tag === 'OL') return '\\n' + serializeList(node, depth);
      if (tag === 'LI') return serializeChildren(node, depth);
      if (tag === 'BLOCKQUOTE') {
        const value = serializeChildren(node, depth).trim();
        return '\\n\\n' + value.split('\\n').map((line) => '> ' + line).join('\\n') + '\\n\\n';
      }
      if (tag === 'TABLE') return serializeTable(node);
      const content = serializeChildren(node, depth);
      if (['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'FIGURE', 'FIGCAPTION'].includes(tag)) {
        return '\\n\\n' + content.trim() + '\\n\\n';
      }
      return content;
    };
    const normalizeComparable = (value) =>
      String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
    const reportNeedle = normalizeComparable(reportText).slice(0, 120);
    const roots = typeof document.querySelectorAll === 'function'
      ? Array.from(document.querySelectorAll('article, main, [role="main"]'))
      : [];
    const matchingRoots = roots.filter((candidate) => {
      const text = normalizeComparable(candidate?.innerText || candidate?.textContent || '');
      return reportNeedle.length >= 20 && isVisibleInDocument(candidate) && text.includes(reportNeedle);
    });
    const root = matchingRoots.sort((a, b) =>
      String(a?.innerText || a?.textContent || '').length -
      String(b?.innerText || b?.textContent || '').length
    )[0] || (isVisibleInDocument(document.body) ? document.body : null);
    const citationRootComparable = normalizeComparable(
      root?.innerText || root?.textContent || '',
    );
    const hasStructuredDom = childNodesOf(root).length > 0;
    const cleanMarkdown = (value) => String(value || '')
      .replace(/[ \\t]+\\n/g, '\\n')
      .replace(/\\n[ \\t]+/g, '\\n')
      .replace(/\\n{3,}/g, '\\n\\n')
      .trim();
    const stripLeadingChrome = (value) => {
      let lines = cleanMarkdown(value).split('\\n');
      const plainLine = (line) => line
        .replace(/^#{1,6}\\s+/, '')
        .split(backtick).join('')
        .split('*').join('')
        .split('_').join('')
        .split(backslash).join('')
        .trim();
      const marker = lines.findIndex((line) => /deep research report/i.test(plainLine(line)));
      if (marker >= 0) lines = lines.slice(marker + 1);
      while (lines.length > 0) {
        const line = plainLine(lines[0] || '');
        if (!line || /^\\d+$/.test(line) || isCompletionLine(line) || isCounterLine(line) || isPlaceholder(line)) {
          lines.shift();
          continue;
        }
        break;
      }
      return cleanMarkdown(lines.join('\\n'));
    };
    const serialized = stripLeadingChrome(serializeNode(root));
    const reportMarkdown = hasStructuredDom
      ? serialized
      : (serialized.length >= 40 ? serialized : reportText);
    const completed = /research completed|badanie ukończone/i.test(rawText) &&
      reportMarkdown.length >= 40 &&
      !isPlaceholder(reportText);
    const inProgress = /researching|badanie|searching|searches|wyszukiwa|citation|cytat|source|źród|reading|completed|ukończone/i.test(rawText);
    return {
      completed,
      inProgress,
      textLength: reportText.length || rawText.trim().length,
      text: completed ? reportMarkdown : undefined,
      citationMarkerNonce: completed ? citationMarkerNonce : undefined,
      citationRootComparable: completed ? citationRootComparable : undefined,
      citationReportNeedle: completed ? reportNeedle : undefined,
      declaredCitationCount: completed ? declaredCitationCount : undefined,
    };
  })()`;
}

export function findDeepResearchFrameIdForTest(
  tree: DeepResearchFrameTree | undefined,
): string | null {
  return findDeepResearchFrameId(tree);
}

export function isConfirmedDeepResearchTargetForTest(
  targetUrl: string,
  tree: DeepResearchFrameTree | undefined,
): boolean {
  return isConfirmedDeepResearchTarget(targetUrl, tree);
}

export function buildDeepResearchFrameStatusExpressionForTest(): string {
  return buildDeepResearchFrameStatusExpression();
}

/**
 * Quick status check for Deep Research — used during reattach to determine
 * whether research has completed, is still in progress, or is in an unknown state.
 */
export async function checkDeepResearchStatus(
  Runtime: ChromeClient["Runtime"],
  _logger: BrowserLogger,
): Promise<{
  completed: boolean;
  inProgress: boolean;
  hasIframe: boolean;
  textLength: number;
  placeholderOnly: boolean;
}> {
  const { result } = await Runtime.evaluate({
    expression: buildDeepResearchStatusExpression(),
    returnByValue: true,
  });

  const val = result?.value as
    | {
        completed?: boolean;
        inProgress?: boolean;
        hasIframe?: boolean;
        textLength?: number;
        placeholderOnly?: boolean;
      }
    | undefined;

  return {
    completed: val?.completed ?? false,
    inProgress: val?.inProgress ?? false,
    hasIframe: val?.hasIframe ?? false,
    textLength: val?.textLength ?? 0,
    placeholderOnly: val?.placeholderOnly ?? false,
  };
}

// ---------------------------------------------------------------------------
// DOM expression builder
// ---------------------------------------------------------------------------

function buildDeepResearchStatusExpression(): string {
  const finishedSelector = JSON.stringify(FINISHED_ACTIONS_SELECTOR);
  const stopSelector = JSON.stringify(STOP_BUTTON_SELECTOR);

  return `(() => {
    const stopVisible = Boolean(document.querySelector(${stopSelector}));
    const iframes = Array.from(document.querySelectorAll('iframe')).filter(f => {
      const rect = f.getBoundingClientRect();
      return rect.width > 200 && rect.height > 200;
    });
    const turns = document.querySelectorAll('[data-message-author-role="assistant"]');
    const lastTurn = turns[turns.length - 1];
    const finished = Boolean(lastTurn?.querySelector?.(${finishedSelector}));
    const text = (lastTurn?.textContent || '').trim();
    const normalized = text.toLowerCase().replace(/\\s+/g, ' ').trim();
    const placeholderOnly = /^(called tool|used tool|użyto narzędzia|narzędzie wywołane)$/.test(normalized);
    const textLength = text.length;
    return {
      completed: finished && !placeholderOnly && textLength >= 40,
      inProgress: stopVisible || iframes.length > 0,
      hasIframe: iframes.length > 0,
      textLength,
      placeholderOnly,
    };
  })()`;
}

function buildDeepResearchCompletionPollExpression(minTurnIndex: number): string {
  const finishedSelector = JSON.stringify(FINISHED_ACTIONS_SELECTOR);
  const stopSelector = JSON.stringify(STOP_BUTTON_SELECTOR);
  return `(() => {
    const MIN_TURN_INDEX = ${minTurnIndex};
    const conversationId = typeof location === 'undefined'
      ? null
      : (String(location.pathname || '').match(/\\/c\\/([^/?#]+)/)?.[1] || null);
    const stopVisible = Boolean(document.querySelector(${stopSelector}));
    const scopedToNewTurns = MIN_TURN_INDEX >= 0;
    const pageText = String(document.body?.innerText || '').toLowerCase().replace(/\\s+/g, ' ');
    const accountBlocked = pageText.includes('suspicious activity detected') &&
      pageText.includes('secure your account') &&
      pageText.includes('regain access');
    const isAssistantTurn = (node) => {
      const attr = String(node.getAttribute('data-message-author-role') || node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
      return attr === 'assistant' ||
        Boolean(node.querySelector('[data-message-author-role="assistant"], [data-turn="assistant"]')) ||
        String(node.getAttribute('data-testid') || '').toLowerCase().includes('conversation-turn') &&
          /chatgpt\\s+said/i.test(node.innerText || node.textContent || '');
    };
    const conversationTurns = ${buildConversationTurnListExpression()};
    const allAssistantTurns = Array.from(document.querySelectorAll('[data-message-author-role="assistant"], [data-turn="assistant"]'));
    const scopedTurns = scopedToNewTurns
      ? conversationTurns.slice(MIN_TURN_INDEX).filter(isAssistantTurn)
      : allAssistantTurns;
    const lastTurn = scopedTurns[scopedTurns.length - 1] || (scopedToNewTurns ? null : allAssistantTurns[allAssistantTurns.length - 1]);
    const text = (lastTurn?.textContent || '').trim();
    const normalized = text.toLowerCase().replace(/\\s+/g, ' ').trim();
    const textLength = text.length;
    const lines = text.split(/\\n+/).map(line => line.trim()).filter(Boolean);
    const tailIsPlanningPanel = text.length <= 1500 &&
      lines.length >= 4 &&
      lines.length <= 20 &&
      /^update$/i.test(lines[1] || '') &&
      /^stop research$/i.test(lines[lines.length - 1] || '') &&
      /^determining steps for creating a report(?:\\.\\.\\.)?$/i.test(lines[lines.length - 2] || '');
    const isToolStub = normalized === 'called tool' ||
      normalized === 'used tool' ||
      normalized === 'użyto narzędzia' ||
      normalized === 'narzędzie wywołane';
    const incompleteResult = isToolStub ||
      normalized === 'planning' ||
      normalized === 'researching' ||
      normalized === 'searching the web' ||
      (text.trimStart().startsWith('<system-reminder>') &&
        /<system-reminder>[\\s\\S]*#\\s*plan mode\\b/i.test(text)) ||
      tailIsPlanningPanel;
    const finished = Boolean(lastTurn?.querySelector(${finishedSelector})) &&
      textLength >= 40 &&
      !incompleteResult;
    const hasIframe = Array.from(document.querySelectorAll('iframe')).some(f => {
      const rect = f.getBoundingClientRect();
      return rect.width > 200 && rect.height > 200;
    });
    const hasScopedDeepResearchIframe = Array.from(lastTurn?.querySelectorAll?.('iframe') || []).some(f => {
      const rect = f.getBoundingClientRect();
      const descriptor = String(f.getAttribute('src') || '') + ' ' + String(f.getAttribute('name') || '');
      return rect.width > 200 && rect.height > 200 &&
        /connector_openai_deep_research|deep-research/i.test(descriptor);
    });
    const hasActiveScopedResearch = scopedToNewTurns && Boolean(lastTurn) &&
      hasScopedDeepResearchIframe &&
      (textLength < 40 || isToolStub || tailIsPlanningPanel || /chatgpt\\s+said:?$/i.test(text));
    return { finished, stopVisible, textLength, hasIframe, isToolStub, incompleteResult, researchActivity: tailIsPlanningPanel || (isToolStub && hasScopedDeepResearchIframe), hasActiveScopedResearch, accountBlocked, conversationId };
  })()`;
}

export function buildDeepResearchStatusExpressionForTest(): string {
  return buildDeepResearchStatusExpression();
}

export function buildDeepResearchCompletionPollExpressionForTest(minTurnIndex = -1): string {
  return buildDeepResearchCompletionPollExpression(minTurnIndex);
}

function buildFindDeepResearchPillExpression(functionName = "findDeepResearchPill"): string {
  const pillLabel = JSON.stringify(DEEP_RESEARCH_PILL_LABEL);
  return `const ${functionName} = () => {
      const label = ${pillLabel}.toLowerCase();
      const selectors = [
        '.__composer-pill-composite',
        '.__composer-pill',
        '[class*="composer-pill"]',
      ].join(',');
      const candidates = Array.from(document.querySelectorAll(selectors));
      const composerRoots = Array.from(document.querySelectorAll('[data-testid="composer"], form, [class*="composer"]'));
      for (const root of composerRoots) {
        candidates.push(...Array.from(root.querySelectorAll('button, [role="button"], [class*="pill"], [class*="composer-pill"]')));
      }
      const seen = new Set();
      for (const pill of candidates) {
        if (!(pill instanceof Element) || seen.has(pill)) continue;
        seen.add(pill);
        const rect = pill.getBoundingClientRect?.();
        if (!rect || rect.width <= 0 || rect.height <= 0) continue;
        const text = (pill.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        const aria = (
          pill.getAttribute('aria-label') ||
          pill.querySelector('button')?.getAttribute('aria-label') ||
          ''
        ).toLowerCase();
        if (text.includes(label) || aria.includes(label)) {
          return pill;
        }
      }
      return null;
    };`;
}

function buildWaitForDeepResearchPillExpression(timeoutMs: number): string {
  return `(async () => {
    ${buildFindDeepResearchPillExpression()}
    const deadline = Date.now() + ${JSON.stringify(Math.max(timeoutMs, 0))};
    while (Date.now() < deadline) {
      if (findDeepResearchPill()) return true;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    return Boolean(findDeepResearchPill());
  })()`;
}

function buildActivateDeepResearchExpression(): string {
  const plusBtnSelector = JSON.stringify(DEEP_RESEARCH_PLUS_BUTTON);
  const targetText = JSON.stringify(DEEP_RESEARCH_DROPDOWN_ITEM_TEXT);

  return `(async () => {
    ${buildClickDispatcher()}
    ${buildFindDeepResearchPillExpression()}

    const waitForPill = () => new Promise((resolve) => {
      let elapsed = 0;
      const tick = () => {
        if (findDeepResearchPill()) {
          resolve(true); return;
        }
        elapsed += 200;
        if (elapsed > 5000) { resolve(false); return; }
        setTimeout(tick, 200);
      };
      setTimeout(tick, 200);
    });

    const menuItemSelector = [
      '[data-radix-collection-item]',
      '[role="option"]',
      '[cmdk-item]',
      'button',
      '[role="menuitem"]',
      '[role="menuitemradio"]',
      '.__menu-item',
      '[class*="__menu-item"]',
      '[class*="menu-item"]',
    ].join(',');
    const dropdownItemSelector = [
      '[data-radix-collection-item]',
      '[role="menuitem"]',
      '[role="menuitemradio"]',
      '[role="option"]',
      '[cmdk-item]',
      'button',
      '.__menu-item',
      '[class*="__menu-item"]',
      '[class*="menu-item"]',
    ].join(',');
    const popoverSelector = [
      '.popover',
      '[class*="popover"]',
      '[data-radix-popper-content-wrapper]',
      '[data-floating-ui-portal]',
    ].join(',');
    const target = ${targetText}.toLowerCase();
    const normalizeText = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const getText = (item) => normalizeText(item.textContent || item.getAttribute?.('aria-label') || '');
    const isInPopover = (item) => Boolean(item.closest?.(popoverSelector));
    const isVisible = (item) => {
      const rect = item.getBoundingClientRect?.();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle?.(item);
      return !style || (style.visibility !== 'hidden' && style.display !== 'none');
    };
    const findPopoverSearchInput = () => Array.from(
      document.querySelectorAll('input, textarea, [contenteditable="true"]')
    ).find(item => {
      const type = (item.getAttribute?.('type') || '').toLowerCase();
      const testId = (item.getAttribute?.('data-testid') || '').toLowerCase();
      return isInPopover(item) &&
        isVisible(item) &&
        type !== 'file' &&
        testId !== 'upload-photos-input';
    }) || null;
    const setSearchText = (input, text) => {
      input.focus?.();
      if ('value' in input) input.value = text;
      else input.textContent = text;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const isDeepResearchText = (text) => (
      text === target ||
      text.startsWith(target + ' ') ||
      text === 'get a detailed report' ||
      text.startsWith('get a detailed report ') ||
      (text.includes(target) && text.includes('detailed report')) ||
      text.replace(/\\s+/g, '').startsWith('deepresearch')
    );
    const getClickableItem = (item) => item.closest?.(
      '[data-radix-collection-item], [role="option"], [cmdk-item], button, [role="menuitem"], [role="menuitemradio"], .__menu-item, [class*="__menu-item"], [class*="menu-item"]'
    ) || item;
    const findDeepResearchItem = (options = {}) => {
      const matches = Array.from(document.querySelectorAll(menuItemSelector))
        .filter(item => {
          const text = getText(item);
          return text &&
            text.length <= 180 &&
            isVisible(item) &&
            (!options.requirePopover || isInPopover(item)) &&
            isDeepResearchText(text);
        })
        .map(item => {
          const text = getText(item);
          const clickable = getClickableItem(item);
          const exact = text === target ? 0 : 1;
          const menuRow = /(^|\\s)__menu-item(\\s|$)/.test(clickable.className || '') ? 0 : 1;
          return { item: clickable, score: exact + menuRow, textLength: text.length };
        })
        .sort((a, b) => a.score - b.score || a.textLength - b.textLength);
      return matches[0]?.item || null;
    };
    const collectAvailableItems = (options = {}) => {
      const seen = new Set();
      return Array.from(document.querySelectorAll(dropdownItemSelector))
        .filter(item => !options.requirePopover || isInPopover(item))
        .filter(item => isVisible(item))
        .map(item => (item.textContent || '').replace(/\\s+/g, ' ').trim())
        .filter(text => text && text.length <= 180)
        .filter(text => {
          const key = text.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    };

    // Step 0: Check if already active
    if (findDeepResearchPill()) {
      return { status: 'already-active' };
    }

    // Step 1: Open the composer tools menu. Avoid slash commands because they
    // mutate the main composer and can be submitted as normal prompt text.
    const plusBtn = document.querySelector(${plusBtnSelector}) ||
      Array.from(document.querySelectorAll('button')).find(
        b => (b.getAttribute('aria-label') || '').toLowerCase().includes('add files')
      );
    if (!plusBtn) return { status: 'plus-button-missing' };
    dispatchClickSequence(plusBtn);

    // Step 2: Wait for dropdown
    const waitForDropdown = () => new Promise((resolve) => {
      let elapsed = 0;
      const tick = () => {
        const items = collectAvailableItems({ requirePopover: true });
        if (findDeepResearchItem({ requirePopover: true }) || items.some(text => {
          const normalized = normalizeText(text);
          return normalized.includes('add photos') ||
            normalized.includes('create image') ||
            normalized.includes('web search') ||
            normalized.includes('deep research') ||
            normalized.includes('get a detailed report');
        })) { resolve(items); return; }
        elapsed += 150;
        if (elapsed > 3000) { resolve(items.length ? items : null); return; }
        setTimeout(tick, 150);
      };
      setTimeout(tick, 150);
    });
    const items = await waitForDropdown();
    if (!items) return { status: 'dropdown-item-missing', available: [] };

    // Step 3: Find "Deep research" item. Some ChatGPT variants only reveal it
    // after typing in the tools menu search field.
    let match = findDeepResearchItem({ requirePopover: true });
    let available = Array.isArray(items) ? items : collectAvailableItems({ requirePopover: true });
    if (!match) {
      const searchInput = findPopoverSearchInput();
      if (searchInput) {
        setSearchText(searchInput, ${targetText});
        await new Promise(resolve => setTimeout(resolve, 600));
        match = findDeepResearchItem({ requirePopover: true });
        available = collectAvailableItems({ requirePopover: true });
      }
    }
    if (!match) return { status: 'dropdown-item-missing', available };

    // Step 4: Click it
    match.scrollIntoView?.({ block: 'center', inline: 'center' });
    await new Promise(resolve => setTimeout(resolve, 100));
    const rect = match.getBoundingClientRect();
    const clickPoint = rect && rect.width > 0 && rect.height > 0
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : undefined;
    dispatchClickSequence(match);

    // Step 5: Verify pill appeared
    const pillConfirmed = await waitForPill();
    return pillConfirmed ? { status: 'activated' } : { status: 'pill-not-confirmed', clickPoint };
  })()`;
}

export function buildActivateDeepResearchExpressionForTest(): string {
  return buildActivateDeepResearchExpression();
}
