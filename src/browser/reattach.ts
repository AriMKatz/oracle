import CDP from "chrome-remote-interface";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import type {
  BrowserAssistantTurnEvidence,
  BrowserRunWarning,
  BrowserRuntimeMetadata,
  BrowserSessionConfig,
} from "../sessionStore.js";
import {
  waitForAssistantResponse,
  captureAssistantMarkdown,
  navigateToChatGPT,
  ensureNotBlocked,
  ensureLoggedIn,
  ensurePromptReady,
  readAssistantSnapshot,
} from "./pageActions.js";
import type { BrowserArchiveResult, BrowserLogger, ChromeClient } from "./types.js";
import {
  launchChrome,
  connectToChrome,
  positionChromeWindowOffscreen,
  connectToRemoteChromeTarget,
  listRemoteChromeTargets,
} from "./chromeLifecycle.js";
import { resolveBrowserConfig } from "./config.js";
import { clearStaleChatGptConversationCookies, syncCookies } from "./cookies.js";
import { CHATGPT_URL } from "./constants.js";
import { buildConversationTurnListExpression } from "./conversationTurns.js";
import {
  cleanupExactCopiedProfileChrome,
  cleanupStaleProfileState,
  validateExactCopiedProfileChrome,
  type ExactCopiedProfileChrome,
} from "./profileState.js";
import { readDevToolsActivePortInfo } from "./detect.js";
import {
  pickTarget,
  extractConversationIdFromUrl,
  buildConversationUrl,
  withTimeout,
  openConversationFromSidebar,
  openConversationFromSidebarWithRetry,
  waitForLocationChange,
  readConversationTurnIndex,
  buildPromptEchoMatcher,
  recoverPromptEcho,
  alignPromptEchoMarkdown,
  type TargetInfoLite,
} from "./reattachHelpers.js";
import { waitForDeepResearchCompletion } from "./actions/deepResearch.js";
import {
  buildDeepResearchAnswerFields,
  type DeepResearchAnswerFields,
} from "./deepResearchAnswer.js";
import {
  archiveChatGptConversation,
  resolveBrowserArchiveDecision,
} from "./actions/archiveConversation.js";
import {
  buildAssistantTurnEvidence,
  missingNormalAssistantTurnEvidenceFields,
} from "./assistantTurnEvidence.js";

export interface ReattachDeps {
  listTargets?: (connection?: {
    host: string;
    port: number;
    browserWSEndpoint?: string;
  }) => Promise<TargetInfoLite[]>;
  connect?: (options?: unknown) => Promise<ChromeClient>;
  waitForAssistantResponse?: typeof waitForAssistantResponse;
  captureAssistantMarkdown?: typeof captureAssistantMarkdown;
  readAssistantSnapshot?: typeof readAssistantSnapshot;
  waitForDeepResearchCompletion?: typeof waitForDeepResearchCompletion;
  recoverSession?: (
    runtime: BrowserRuntimeMetadata,
    config: BrowserSessionConfig | undefined,
  ) => Promise<ReattachResult>;
  /**
   * Persist the captured answer while the exact conversation is still open.
   * Return true only after every required local artifact has been saved; this
   * gates any configured post-capture archive action.
   */
  persistResultBeforeClose?: (result: ReattachResult) => Promise<boolean>;
  promptPreview?: string;
  validateCopiedProfileChrome?: typeof validateExactCopiedProfileChrome;
  cleanupCopiedProfileChrome?: typeof cleanupExactCopiedProfileChrome;
}

export interface ReattachResult {
  answerText: string;
  answerMarkdown: string;
  answerHtml?: string;
  assistantTurn?: BrowserAssistantTurnEvidence;
  citationStatus?: DeepResearchAnswerFields["citationStatus"];
  warnings?: BrowserRunWarning[];
  archive?: BrowserArchiveResult;
}

class ReattachArtifactPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReattachArtifactPersistenceError";
  }
}

class ReattachTurnEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReattachTurnEvidenceError";
  }
}

export async function resumeBrowserSession(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  deps: ReattachDeps = {},
): Promise<ReattachResult> {
  const copiedProfileSource = config?.copyProfileSource?.trim();
  const requireExistingChrome = Boolean(copiedProfileSource);
  const recoverSession =
    deps.recoverSession ??
    (async (runtimeMeta, configMeta) =>
      resumeBrowserSessionViaNewChrome(runtimeMeta, configMeta, logger, deps));
  let closeAttachedConnection: (() => Promise<void>) | null = null;
  let copiedProfileChrome: ExactCopiedProfileChrome | null = null;
  let copiedProfileCleanupAttempted = false;
  const closeAttached = async (): Promise<void> => {
    const close = closeAttachedConnection;
    closeAttachedConnection = null;
    await close?.().catch(() => undefined);
  };
  const cleanupCopiedProfile = async (): Promise<void> => {
    if (!copiedProfileChrome || copiedProfileCleanupAttempted) return;
    copiedProfileCleanupAttempted = true;
    await (deps.cleanupCopiedProfileChrome ?? cleanupExactCopiedProfileChrome)(
      copiedProfileChrome,
      logger,
    );
  };

  if (!runtime.chromePort && !runtime.chromeBrowserWSEndpoint) {
    if (requireExistingChrome) {
      throw new Error(
        "Copied-profile recovery requires the exact existing Chrome endpoint; fresh browser fallback is disabled.",
      );
    }
    logger("No running Chrome detected; reopening browser to locate the session.");
    return recoverSession(runtime, config);
  }

  try {
    if (requireExistingChrome) {
      const chromePid = runtime.chromePid;
      const chromePort = runtime.chromePort;
      const userDataDir = runtime.userDataDir?.trim();
      const copiedProfileRoot = runtime.copiedProfileRoot?.trim();
      if (!copiedProfileSource || !userDataDir || !copiedProfileRoot || !chromePid || !chromePort) {
        throw new Error(
          "Copied-profile recovery requires the persisted source profile, temporary user-data directory, copied-profile root, Chrome pid, and DevTools port.",
        );
      }
      copiedProfileChrome = await (
        deps.validateCopiedProfileChrome ?? validateExactCopiedProfileChrome
      )({
        userDataDir,
        sourceUserDataDir: copiedProfileSource,
        copiedProfileRoot,
        pid: chromePid,
        port: chromePort,
        host: runtime.chromeHost,
      });
    }

    // A copied-profile recovery is pinned to the persisted, validated process
    // and port. Ordinary reattach may still refresh stale endpoint metadata.
    const liveRuntime = requireExistingChrome
      ? {
          ...runtime,
          chromeHost: copiedProfileChrome?.host,
          chromePort: copiedProfileChrome?.port,
          chromeBrowserWSEndpoint: undefined,
        }
      : ((await refreshAttachRuntime(runtime).catch(() => runtime)) ?? runtime);
    const host = liveRuntime.chromeHost ?? "127.0.0.1";
    const port =
      liveRuntime.chromePort ?? inferPortFromBrowserWSEndpoint(liveRuntime.chromeBrowserWSEndpoint);
    // Copied-profile recovery must never trust a persisted websocket URL. The
    // validated process identity owns the exact host+port transport.
    const browserWSEndpoint = requireExistingChrome
      ? undefined
      : (liveRuntime.chromeBrowserWSEndpoint ?? undefined);
    const listTargets =
      deps.listTargets ??
      (async () =>
        (await listRemoteChromeTargets({
          host,
          port: port ?? 9222,
          browserWSEndpoint,
        })) as TargetInfoLite[]);
    const targetList = (await listTargets({
      host,
      port: port ?? 9222,
      browserWSEndpoint,
    })) as TargetInfoLite[];
    const target = pickTarget(targetList, liveRuntime);
    const connection =
      browserWSEndpoint && !deps.connect
        ? await connectToRemoteChromeTarget(host, port ?? 9222, logger, {
            browserWSEndpoint,
            targetId: target?.targetId ?? target?.id,
            closeTargetOnDispose: false,
          })
        : await (async () => {
            const client = (await (
              deps.connect ?? ((options?: unknown) => CDP(options as CDP.Options))
            )(
              browserWSEndpoint
                ? {
                    target: browserWSEndpoint,
                    local: true,
                    targetId: target?.targetId ?? target?.id,
                  }
                : {
                    host,
                    port,
                    target: target?.targetId ?? target?.id,
                  },
            )) as unknown as ChromeClient;
            return { client, close: () => client.close() };
          })();
    closeAttachedConnection = () => connection.close();

    const client: ChromeClient = connection.client;
    const { Runtime, DOM, Page } = client;
    const expectedConversationId =
      runtime.conversationId ??
      extractConversationIdFromUrl(runtime.tabUrl ?? "") ??
      extractConversationIdFromUrl(config?.url ?? "");
    const finishAttachedCapture = async (result: ReattachResult): Promise<ReattachResult> => {
      try {
        return await finalizeReattachCapture({
          result,
          Runtime,
          runtime,
          config,
          expectedConversationId,
          logger,
          persistResultBeforeClose: deps.persistResultBeforeClose,
        });
      } finally {
        await closeAttached();
      }
    };
    if (Runtime?.enable) {
      await Runtime.enable();
    }
    if (DOM && typeof DOM.enable === "function") {
      await DOM.enable();
    }
    if (Page && typeof Page.enable === "function") {
      await Page.enable();
    }

    const ensureConversationOpen = async () => {
      const { result } = await Runtime.evaluate({
        expression: "location.href",
        returnByValue: true,
      });
      const href = typeof result?.value === "string" ? result.value : "";
      if (href.includes("/c/")) {
        const currentId = extractConversationIdFromUrl(href);
        if (!expectedConversationId || (currentId && currentId === expectedConversationId)) {
          return;
        }
      }
      const opened = await openConversationFromSidebarWithRetry(
        Runtime,
        {
          conversationId: expectedConversationId,
          preferProjects: true,
          promptPreview: deps.promptPreview,
        },
        15_000,
      );
      if (!opened) {
        throw new Error("Unable to locate prior ChatGPT conversation in sidebar.");
      }
      await waitForLocationChange(Runtime, 15_000);
    };

    const waitForResponse = deps.waitForAssistantResponse ?? waitForAssistantResponse;
    const captureMarkdown = deps.captureAssistantMarkdown ?? captureAssistantMarkdown;
    const timeoutMs = config?.timeoutMs ?? 120_000;
    const pingTimeoutMs = Math.min(5_000, Math.max(1_500, Math.floor(timeoutMs * 0.05)));
    await withTimeout(
      Runtime.evaluate({ expression: "1+1", returnByValue: true }),
      pingTimeoutMs,
      "Reattach target did not respond",
    );
    await ensureConversationOpen();
    const minTurnIndex =
      config?.researchMode === "deep"
        ? null
        : await readReattachMinTurnIndex(Runtime, deps.promptPreview, logger);
    if (config?.researchMode === "deep") {
      if (!expectedConversationId) {
        throw new Error(
          "Unable to establish the saved conversation ID for Deep Research reattach.",
        );
      }
      await requirePinnedConversation(Runtime, expectedConversationId);
      const submittedUserMessageId = runtime.submittedUserMessageId?.trim();
      const submittedUserTurnIndex = runtime.submittedUserTurnIndex;
      if (
        !submittedUserMessageId ||
        typeof submittedUserTurnIndex !== "number" ||
        submittedUserTurnIndex < 0
      ) {
        throw new Error(
          "Deep Research reattach lacks the persisted exact submitted user turn; refusing prompt-based reconstruction.",
        );
      }
      const waitForDeepResearch =
        deps.waitForDeepResearchCompletion ?? waitForDeepResearchCompletion;
      const researchResult = await withTimeout(
        waitForDeepResearch(Runtime, logger, timeoutMs, submittedUserTurnIndex, Page, client, {
          requireScopedTargetOwner: true,
          expectedConversationId,
          expectedUserMessageId: submittedUserMessageId,
        }),
        timeoutMs + 5_000,
        "Reattach Deep Research response timed out",
      );
      const result = await finishAttachedCapture(buildDeepResearchAnswerFields(researchResult));
      await cleanupCopiedProfile();
      return result;
    }
    const promptEcho = buildPromptEchoMatcher(deps.promptPreview);
    const answer = await withTimeout(
      waitForResponse(
        Runtime,
        timeoutMs,
        logger,
        minTurnIndex ?? undefined,
        expectedConversationId,
      ),
      timeoutMs + 5_000,
      "Reattach response timed out",
    );
    const recovered = await recoverPromptEcho(
      Runtime,
      answer,
      promptEcho,
      logger,
      minTurnIndex,
      timeoutMs,
    );
    const markdown =
      (await withTimeout(
        captureMarkdown(Runtime, recovered.meta, logger),
        15_000,
        "Reattach markdown capture timed out",
      )) ?? recovered.text;
    const aligned = alignPromptEchoMarkdown(recovered.text, markdown, promptEcho, logger);
    const captured = await buildNormalReattachResult({
      Runtime,
      answerText: aligned.answerText,
      answerMarkdown: aligned.answerMarkdown,
      minTurnIndex,
      expectedConversationId,
      readSnapshot: deps.readAssistantSnapshot,
    });

    const result = await finishAttachedCapture(captured);
    await cleanupCopiedProfile();
    return result;
  } catch (error) {
    await closeAttached();
    const message = error instanceof Error ? error.message : String(error);
    if (requireExistingChrome) {
      let cleanupFailure: string | null = null;
      const preserveForArtifactRecovery =
        error instanceof ReattachArtifactPersistenceError ||
        error instanceof ReattachTurnEvidenceError;
      if (!preserveForArtifactRecovery) {
        try {
          await cleanupCopiedProfile();
        } catch (cleanupError) {
          cleanupFailure =
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        }
      }
      const cleanupSuffix = cleanupFailure
        ? ` Copied-profile cleanup also failed (${cleanupFailure}).`
        : preserveForArtifactRecovery
          ? " Exact Chrome and copied profile were preserved because required local artifacts or exact assistant-turn evidence were not saved."
          : "";
      throw new Error(
        `Exact copied-profile Chrome recovery failed (${message}); fresh browser fallback is disabled.${cleanupSuffix}`,
        { cause: error },
      );
    }
    if (error instanceof ReattachArtifactPersistenceError) {
      throw error;
    }
    logger(
      `Existing Chrome reattach failed (${message}); reopening browser to locate the session.`,
    );
    return recoverSession(runtime, config);
  }
}

async function refreshAttachRuntime(
  runtime: BrowserRuntimeMetadata,
): Promise<BrowserRuntimeMetadata | null> {
  if (!runtime.chromeProfileRoot) {
    return runtime;
  }
  const host = runtime.chromeHost ?? "127.0.0.1";
  const activePort = await readDevToolsActivePortInfo(runtime.chromeProfileRoot, {
    host,
  });
  if (!activePort) {
    return runtime;
  }
  return {
    ...runtime,
    chromeHost: host,
    chromePort: activePort.port,
    chromeBrowserWSEndpoint: activePort.browserWSEndpoint,
  };
}

function inferPortFromBrowserWSEndpoint(browserWSEndpoint?: string): number | undefined {
  if (!browserWSEndpoint) {
    return undefined;
  }
  try {
    const parsed = new URL(browserWSEndpoint);
    const port = Number.parseInt(parsed.port, 10);
    if (Number.isFinite(port) && port > 0) {
      return port;
    }
  } catch {
    // ignore malformed ws endpoints and fall back to caller defaults
  }
  return undefined;
}

async function resumeBrowserSessionViaNewChrome(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  deps: ReattachDeps,
): Promise<ReattachResult> {
  const resolved = resolveBrowserConfig(config ?? {});
  const manualLogin = Boolean(resolved.manualLogin);
  const userDataDir = manualLogin
    ? (resolved.manualLoginProfileDir ?? path.join(os.homedir(), ".oracle", "browser-profile"))
    : await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-"));
  if (manualLogin) {
    await mkdir(userDataDir, { recursive: true });
  }
  const chrome = await launchChrome(resolved, userDataDir, logger);
  const chromeHost = (chrome as unknown as { host?: string }).host ?? "127.0.0.1";
  const client = await connectToChrome(chrome.port, logger, chromeHost);
  const { Network, Page, Runtime, DOM, Target } = client;

  if (Runtime?.enable) {
    await Runtime.enable();
  }
  if (DOM && typeof DOM.enable === "function") {
    await DOM.enable();
  }
  if (!resolved.headless && resolved.hideWindow) {
    await positionChromeWindowOffscreen(client, logger);
  }
  let appliedCookies = 0;
  if (!manualLogin && resolved.cookieSync) {
    appliedCookies = await syncCookies(Network, resolved.url, resolved.chromeProfile, logger, {
      allowErrors: resolved.allowCookieErrors,
      filterNames: resolved.cookieNames ?? undefined,
      inlineCookies: resolved.inlineCookies ?? undefined,
      cookiePath: resolved.chromeCookiePath ?? undefined,
      waitMs: resolved.cookieSyncWaitMs ?? 0,
    });
  }

  await clearStaleChatGptConversationCookies(Network, Target, logger, {
    preserveConversationIds: [
      runtime.conversationId,
      extractConversationIdFromUrl(runtime.tabUrl ?? ""),
      extractConversationIdFromUrl(resolved.url),
    ],
  });

  await navigateToChatGPT(Page, Runtime, CHATGPT_URL, logger);
  await ensureNotBlocked(Runtime, resolved.headless, logger);
  await ensureLoggedIn(Runtime, logger, { appliedCookies });
  if (resolved.url !== CHATGPT_URL) {
    await navigateToChatGPT(Page, Runtime, resolved.url, logger);
    await ensureNotBlocked(Runtime, resolved.headless, logger);
  }
  await ensurePromptReady(Runtime, resolved.inputTimeoutMs, logger);

  const conversationUrl = buildConversationUrl(runtime, resolved.url);
  const expectedConversationId =
    runtime.conversationId ??
    extractConversationIdFromUrl(runtime.tabUrl ?? "") ??
    extractConversationIdFromUrl(resolved.url);
  if (conversationUrl) {
    logger(`Reopening conversation at ${conversationUrl}`);
    await navigateToChatGPT(Page, Runtime, conversationUrl, logger);
    await ensureNotBlocked(Runtime, resolved.headless, logger);
    await ensurePromptReady(Runtime, resolved.inputTimeoutMs, logger);
  } else {
    const opened = await openConversationFromSidebarWithRetry(
      Runtime,
      {
        conversationId:
          runtime.conversationId ?? extractConversationIdFromUrl(runtime.tabUrl ?? ""),
        preferProjects:
          resolved.url !== CHATGPT_URL ||
          Boolean(
            runtime.tabUrl && (/\/g\//.test(runtime.tabUrl) || runtime.tabUrl.includes("/project")),
          ),
        promptPreview: deps.promptPreview,
      },
      15_000,
    );
    if (!opened) {
      throw new Error("Unable to locate prior ChatGPT conversation in sidebar.");
    }
    await waitForLocationChange(Runtime, 15_000);
  }

  const waitForResponse = deps.waitForAssistantResponse ?? waitForAssistantResponse;
  const captureMarkdown = deps.captureAssistantMarkdown ?? captureAssistantMarkdown;
  const timeoutMs = resolved.timeoutMs ?? 120_000;
  const cleanup = async () => {
    if (client && typeof client.close === "function") {
      try {
        await client.close();
      } catch {
        // ignore
      }
    }
    if (!resolved.keepBrowser) {
      try {
        await chrome.kill();
      } catch {
        // ignore
      }
      if (manualLogin) {
        await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: "never" }).catch(
          () => undefined,
        );
      } else {
        await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  };
  const finishRecoveredCapture = async (result: ReattachResult): Promise<ReattachResult> => {
    try {
      return await finalizeReattachCapture({
        result,
        Runtime,
        runtime,
        config: resolved,
        expectedConversationId,
        logger,
        persistResultBeforeClose: deps.persistResultBeforeClose,
      });
    } finally {
      await cleanup();
    }
  };
  const minTurnIndex =
    resolved.researchMode === "deep"
      ? null
      : await readReattachMinTurnIndex(Runtime, deps.promptPreview, logger);
  if (resolved.researchMode === "deep") {
    if (!expectedConversationId) {
      await cleanup();
      throw new Error("Unable to establish the saved conversation ID for Deep Research reattach.");
    }
    try {
      await requirePinnedConversation(Runtime, expectedConversationId);
    } catch (error) {
      await cleanup();
      throw error;
    }
    const submittedUserMessageId = runtime.submittedUserMessageId?.trim();
    const submittedUserTurnIndex = runtime.submittedUserTurnIndex;
    if (
      !submittedUserMessageId ||
      typeof submittedUserTurnIndex !== "number" ||
      submittedUserTurnIndex < 0
    ) {
      await cleanup();
      throw new Error(
        "Deep Research reattach lacks the persisted exact submitted user turn; refusing prompt-based reconstruction.",
      );
    }
    const waitForDeepResearch = deps.waitForDeepResearchCompletion ?? waitForDeepResearchCompletion;
    const researchResult = await waitForDeepResearch(
      Runtime,
      logger,
      timeoutMs,
      submittedUserTurnIndex,
      Page,
      client,
      {
        requireScopedTargetOwner: true,
        expectedConversationId,
        expectedUserMessageId: submittedUserMessageId,
      },
    );
    return finishRecoveredCapture(buildDeepResearchAnswerFields(researchResult));
  }
  const promptEcho = buildPromptEchoMatcher(deps.promptPreview);
  const answer = await waitForResponse(
    Runtime,
    timeoutMs,
    logger,
    minTurnIndex ?? undefined,
    expectedConversationId,
  );
  const recovered = await recoverPromptEcho(
    Runtime,
    answer,
    promptEcho,
    logger,
    minTurnIndex,
    timeoutMs,
  );
  const markdown = (await captureMarkdown(Runtime, recovered.meta, logger)) ?? recovered.text;
  const aligned = alignPromptEchoMarkdown(recovered.text, markdown, promptEcho, logger);
  let captured: ReattachResult;
  try {
    captured = await buildNormalReattachResult({
      Runtime,
      answerText: aligned.answerText,
      answerMarkdown: aligned.answerMarkdown,
      minTurnIndex,
      expectedConversationId,
      readSnapshot: deps.readAssistantSnapshot,
    });
  } catch (error) {
    await cleanup();
    throw error;
  }

  return finishRecoveredCapture(captured);
}

async function buildNormalReattachResult({
  Runtime,
  answerText,
  answerMarkdown,
  minTurnIndex,
  expectedConversationId,
  readSnapshot,
}: {
  Runtime: ChromeClient["Runtime"];
  answerText: string;
  answerMarkdown: string;
  minTurnIndex: number | null;
  expectedConversationId?: string;
  readSnapshot?: typeof readAssistantSnapshot;
}): Promise<ReattachResult> {
  const snapshot = await (readSnapshot ?? readAssistantSnapshot)(
    Runtime,
    minTurnIndex ?? undefined,
    expectedConversationId,
  ).catch(() => null);
  const assistantTurn = buildAssistantTurnEvidence(snapshot, answerText, answerMarkdown);
  const missingFields = missingNormalAssistantTurnEvidenceFields(assistantTurn);
  if (missingFields.length > 0) {
    throw new ReattachTurnEvidenceError(
      `Exact final assistant-turn evidence is incomplete (${missingFields.join(", ")}); refusing to finalize normal browser reattach.`,
    );
  }
  return { answerText, answerMarkdown, assistantTurn };
}

async function readPromptPreviewTurnIndex(
  Runtime: ChromeClient["Runtime"],
  promptPreview?: string | null,
): Promise<number | null> {
  const preview = promptPreview?.trim();
  if (!preview) {
    return null;
  }
  const { result } = await Runtime.evaluate({
    expression: `(() => {
      const needle = ${JSON.stringify(preview.toLowerCase().replace(/\s+/g, " ").slice(0, 120))};
      if (!needle) return null;
      const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
      const turns = ${buildConversationTurnListExpression()};
      let matched = null;
      for (const [index, node] of turns.entries()) {
        const attr = (node.getAttribute('data-message-author-role') || node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
        const isUser = attr === 'user' || Boolean(node.querySelector('[data-message-author-role="user"]'));
        if (!isUser) continue;
        const text = normalize(node.innerText || node.textContent || '');
        if (text.length > 0 && (text.includes(needle) || needle.includes(text.slice(0, needle.length)))) {
          matched = index;
        }
      }
      return matched;
    })()`,
    returnByValue: true,
  });
  return typeof result?.value === "number" ? result.value : null;
}

async function requirePinnedConversation(
  Runtime: ChromeClient["Runtime"],
  expectedConversationId: string,
): Promise<void> {
  const { result } = await Runtime.evaluate({
    expression: "location.href",
    returnByValue: true,
  });
  const href = typeof result?.value === "string" ? result.value : "";
  const currentConversationId = extractConversationIdFromUrl(href);
  if (currentConversationId !== expectedConversationId) {
    throw new Error(
      "ChatGPT is not showing the saved Deep Research conversation; refusing an unpinned reattach.",
    );
  }
}

async function readReattachMinTurnIndex(
  Runtime: ChromeClient["Runtime"],
  promptPreview: string | null | undefined,
  logger: BrowserLogger,
): Promise<number | null> {
  return (
    (await readPromptPreviewTurnIndex(Runtime, promptPreview)) ??
    (await readConversationTurnIndex(Runtime, logger))
  );
}

async function finalizeReattachCapture({
  result,
  Runtime,
  runtime,
  config,
  expectedConversationId,
  logger,
  persistResultBeforeClose,
}: {
  result: ReattachResult;
  Runtime: ChromeClient["Runtime"];
  runtime: BrowserRuntimeMetadata;
  config: BrowserSessionConfig | undefined;
  expectedConversationId?: string;
  logger: BrowserLogger;
  persistResultBeforeClose?: ReattachDeps["persistResultBeforeClose"];
}): Promise<ReattachResult> {
  if (!persistResultBeforeClose) return result;

  let requiredArtifactsSaved: boolean;
  try {
    requiredArtifactsSaved = await persistResultBeforeClose(result);
  } catch (error) {
    throw new ReattachArtifactPersistenceError(
      "Required local artifact persistence failed before reattach completion.",
      { cause: error },
    );
  }
  if (!requiredArtifactsSaved) {
    throw new ReattachArtifactPersistenceError(
      "Required local artifacts were not saved before reattach completion.",
    );
  }
  const mode = config?.archiveConversations ?? "auto";
  // Reattach does not persist enough turn history to safely re-evaluate the
  // automatic one-shot/multi-turn policy. Honor only the user's explicit
  // archive=always request here; never guess that an auto session is one-shot.
  if (mode !== "always") return result;
  const evaluatedUrl = await Runtime.evaluate({
    expression: "location.href",
    returnByValue: true,
  })
    .then(({ result: evaluated }) =>
      typeof evaluated?.value === "string" ? evaluated.value : undefined,
    )
    .catch(() => undefined);
  const conversationUrl = evaluatedUrl ?? runtime.tabUrl;
  const decision = resolveBrowserArchiveDecision({
    mode,
    chatgptUrl: config?.url,
    conversationUrl,
    researchMode: config?.researchMode,
    followUpCount: 0,
  });
  if (!decision.shouldArchive) {
    logger(`[browser] ChatGPT archive skipped (${decision.reason}).`);
    return {
      ...result,
      archive: {
        mode: decision.mode,
        attempted: false,
        archived: false,
        reason: decision.reason,
        conversationUrl,
      },
    };
  }
  const pinnedConversationId = expectedConversationId?.trim();
  if (!pinnedConversationId) {
    logger("[browser] ChatGPT archive skipped (missing-conversation-id).");
    return {
      ...result,
      archive: {
        mode: decision.mode,
        attempted: false,
        archived: false,
        reason: "missing-conversation-id",
        conversationUrl,
      },
    };
  }
  if (extractConversationIdFromUrl(conversationUrl ?? "") !== pinnedConversationId) {
    logger("[browser] ChatGPT archive skipped (conversation-changed).");
    return {
      ...result,
      archive: {
        mode: decision.mode,
        attempted: false,
        archived: false,
        reason: "conversation-changed",
        conversationUrl,
      },
    };
  }

  const archive = await archiveChatGptConversation(Runtime, logger, {
    mode: decision.mode,
    conversationUrl,
    expectedConversationId: pinnedConversationId,
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    logger(`[browser] ChatGPT archive failed (${message}).`);
    return {
      mode: decision.mode,
      attempted: true,
      archived: false,
      reason: "archive-failed",
      conversationUrl,
      error: message,
    } satisfies BrowserArchiveResult;
  });
  return { ...result, archive };
}

// biome-ignore lint/style/useNamingConvention: test-only export used in vitest suite
export const __test__ = {
  pickTarget,
  extractConversationIdFromUrl,
  buildConversationUrl,
  openConversationFromSidebar,
  readPromptPreviewTurnIndex,
  readReattachMinTurnIndex,
  requirePinnedConversation,
};
