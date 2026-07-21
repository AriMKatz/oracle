import { createHash } from "node:crypto";
import type { BrowserAssistantTurnEvidence } from "../sessionStore.js";
import { cleanAssistantText } from "./actions/assistantResponse.js";

export interface AssistantTurnSnapshot {
  text?: string | null;
  messageId?: string | null;
  turnId?: string | null;
  turnIndex?: number | null;
  modelSlug?: string | null;
}

export function buildAssistantTurnEvidence(
  snapshot: AssistantTurnSnapshot | null,
  responseText: string,
  responseMarkdown: string,
): BrowserAssistantTurnEvidence | undefined {
  if (!snapshot) return undefined;
  const normalizeText = (value: string): string =>
    cleanAssistantText(value).replace(/\s+/g, " ").trim();
  if (!snapshot.text || normalizeText(snapshot.text) !== normalizeText(responseText)) {
    return undefined;
  }
  const messageId = snapshot.messageId?.trim() || undefined;
  const turnId = snapshot.turnId?.trim() || undefined;
  const turnIndex = typeof snapshot.turnIndex === "number" ? snapshot.turnIndex : undefined;
  const modelSlug = snapshot.modelSlug?.trim() || undefined;
  if (!messageId && !turnId && turnIndex === undefined && !modelSlug) return undefined;
  return {
    messageId,
    turnId,
    turnIndex,
    modelSlug,
    responseSha256: createHash("sha256").update(responseMarkdown.trim()).digest("hex"),
    capturedAt: new Date().toISOString(),
  };
}

export function missingNormalAssistantTurnEvidenceFields(
  evidence: BrowserAssistantTurnEvidence | undefined,
): string[] {
  if (!evidence) {
    return ["messageId/turnId", "turnIndex", "modelSlug", "responseSha256"];
  }
  const missing: string[] = [];
  if (!evidence.messageId?.trim() && !evidence.turnId?.trim()) missing.push("messageId/turnId");
  if (typeof evidence.turnIndex !== "number" || evidence.turnIndex < 0) missing.push("turnIndex");
  if (!evidence.modelSlug?.trim()) missing.push("modelSlug");
  if (!/^[0-9a-f]{64}$/.test(evidence.responseSha256)) missing.push("responseSha256");
  return missing;
}
