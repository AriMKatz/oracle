import { createHash } from "node:crypto";
import type {
  BrowserAssistantTurnEvidence,
  BrowserModelSelectionEvidence,
  BrowserRunWarning,
} from "../sessionStore.js";
import type { DeepResearchCompletionResult } from "./actions/deepResearch.js";

export const DEEP_RESEARCH_PROVENANCE_WARNING_CODE = "browser-deep-research-provenance-incomplete";
export const DEEP_RESEARCH_CITATIONS_WARNING_CODE = "browser-deep-research-citations-incomplete";
export const EXPECTED_DEEP_RESEARCH_DEFAULT_MODEL_SLUG = "gpt-5-6-pro";

const DEEP_RESEARCH_WARNING_CODES = new Set([
  DEEP_RESEARCH_PROVENANCE_WARNING_CODE,
  DEEP_RESEARCH_CITATIONS_WARNING_CODE,
]);

export interface DeepResearchAnswerFields {
  answerText: string;
  answerMarkdown: string;
  answerHtml?: string;
  assistantTurn?: BrowserAssistantTurnEvidence;
  citationStatus?: NonNullable<DeepResearchCompletionResult["citationStatus"]>;
  warnings?: BrowserRunWarning[];
}

function readStrictNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) return null;
  return value;
}

function addInvalidStringField(
  field: string,
  value: unknown,
  missingFields: string[],
  mismatchedFields: string[],
): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    missingFields.push(field);
    return null;
  }
  const normalized = readStrictNonEmptyString(value);
  if (!normalized) mismatchedFields.push(field);
  return normalized;
}

export function buildDeepResearchProvenanceWarnings(
  reportText: string,
  evidence: BrowserAssistantTurnEvidence | undefined,
): BrowserRunWarning[] {
  const missingFields: string[] = [];
  const mismatchedFields: string[] = [];
  const trimmedReport = typeof reportText === "string" ? reportText.trim() : "";
  if (!trimmedReport) missingFields.push("reportText");
  if (!evidence) {
    missingFields.push("assistantTurn");
  } else {
    addInvalidStringField("messageId", evidence.messageId, missingFields, mismatchedFields);
    addInvalidStringField(
      "finalMessageId",
      evidence.finalMessageId,
      missingFields,
      mismatchedFields,
    );
    if (evidence.turnIndex == null) {
      missingFields.push("turnIndex");
    } else if (!Number.isSafeInteger(evidence.turnIndex) || evidence.turnIndex < 0) {
      mismatchedFields.push("turnIndex");
    }
    // modelSlug and resolvedModelSlug are exact owner-message record fields,
    // not selected-model or hidden-worker claims. Require them, but do not
    // require them to equal Pro.
    addInvalidStringField("modelSlug", evidence.modelSlug, missingFields, mismatchedFields);
    addInvalidStringField(
      "resolvedModelSlug",
      evidence.resolvedModelSlug,
      missingFields,
      mismatchedFields,
    );
    const defaultModelSlug = addInvalidStringField(
      "defaultModelSlug",
      evidence.defaultModelSlug,
      missingFields,
      mismatchedFields,
    );
    if (defaultModelSlug && defaultModelSlug !== EXPECTED_DEEP_RESEARCH_DEFAULT_MODEL_SLUG) {
      mismatchedFields.push("defaultModelSlug");
    }
    addInvalidStringField(
      "deepResearchVersion",
      evidence.deepResearchVersion,
      missingFields,
      mismatchedFields,
    );
    if (evidence.metadataSource == null || String(evidence.metadataSource).trim().length === 0) {
      missingFields.push("metadataSource");
    } else if (evidence.metadataSource !== "chatgpt-conversation-record") {
      mismatchedFields.push("metadataSource");
    }
    const capturedAt = addInvalidStringField(
      "capturedAt",
      evidence.capturedAt,
      missingFields,
      mismatchedFields,
    );
    if (capturedAt && Number.isNaN(Date.parse(capturedAt))) mismatchedFields.push("capturedAt");
    const responseSha256 = addInvalidStringField(
      "responseSha256",
      evidence.responseSha256,
      missingFields,
      mismatchedFields,
    );
    const expectedHash = createHash("sha256").update(trimmedReport).digest("hex");
    if (
      responseSha256 &&
      (!/^[a-f0-9]{64}$/.test(responseSha256) || responseSha256 !== expectedHash)
    ) {
      mismatchedFields.push("responseSha256");
    }
  }

  const uniqueMissingFields = Array.from(new Set(missingFields));
  const uniqueMismatchedFields = Array.from(new Set(mismatchedFields));

  if (uniqueMissingFields.length === 0 && uniqueMismatchedFields.length === 0) return [];
  return [
    {
      code: DEEP_RESEARCH_PROVENANCE_WARNING_CODE,
      severity: "warning",
      message:
        "Deep Research report captured, but exact report-owner, selected/default-model, owner-model, or report-hash provenance is incomplete or inconsistent; do not claim a fully verified Deep Research response.",
      details: {
        ...(uniqueMissingFields.length > 0 ? { missingFields: uniqueMissingFields } : {}),
        ...(uniqueMismatchedFields.length > 0 ? { mismatchedFields: uniqueMismatchedFields } : {}),
        expectedDefaultModelSlug: EXPECTED_DEEP_RESEARCH_DEFAULT_MODEL_SLUG,
      },
    },
  ];
}

/**
 * Require the durable model-picker receipt that proves this Deep Research run
 * was deliberately submitted from ChatGPT's Pro picker target. Reattach paths
 * must apply this again to the persisted receipt before replacing old derived
 * warnings; report recovery alone cannot upgrade missing picker provenance.
 */
export function addDeepResearchPickerEvidenceWarning(
  warnings: BrowserRunWarning[],
  evidence: BrowserModelSelectionEvidence | undefined,
): BrowserRunWarning[] {
  const missingFields: string[] = [];
  const mismatchedFields: string[] = [];
  if (!evidence) {
    missingFields.push("modelSelection");
  } else {
    if (!evidence.requestedModel) {
      missingFields.push("modelSelection.requestedModel");
    } else if (evidence.requestedModel !== "Pro") {
      mismatchedFields.push("modelSelection.requestedModel");
    }
    if (!evidence.resolvedLabel) {
      missingFields.push("modelSelection.resolvedLabel");
    } else if (evidence.resolvedLabel !== "Pro") {
      mismatchedFields.push("modelSelection.resolvedLabel");
    }
    if (evidence.verified !== true) mismatchedFields.push("modelSelection.verified");
    if (evidence.source !== "chatgpt-model-picker") {
      mismatchedFields.push("modelSelection.source");
    }
    if (evidence.strategy !== "select") mismatchedFields.push("modelSelection.strategy");
    if (evidence.status !== "already-selected" && evidence.status !== "switched") {
      mismatchedFields.push("modelSelection.status");
    }
    if (!evidence.capturedAt?.trim()) missingFields.push("modelSelection.capturedAt");
  }
  if (missingFields.length === 0 && mismatchedFields.length === 0) return warnings;

  const mergeDetails = (warning: BrowserRunWarning): BrowserRunWarning => {
    if (warning.code !== DEEP_RESEARCH_PROVENANCE_WARNING_CODE) return warning;
    const details = warning.details ?? {};
    const existingStrings = (key: "missingFields" | "mismatchedFields"): string[] =>
      Array.isArray(details[key])
        ? details[key].filter((value): value is string => typeof value === "string")
        : [];
    return {
      ...warning,
      details: {
        ...details,
        ...(missingFields.length > 0
          ? {
              missingFields: Array.from(
                new Set([...existingStrings("missingFields"), ...missingFields]),
              ),
            }
          : {}),
        ...(mismatchedFields.length > 0
          ? {
              mismatchedFields: Array.from(
                new Set([...existingStrings("mismatchedFields"), ...mismatchedFields]),
              ),
            }
          : {}),
        expectedPickerEvidence: {
          requestedModel: "Pro",
          resolvedLabel: "Pro",
          verified: true,
          source: "chatgpt-model-picker",
          strategy: "select",
          statuses: ["already-selected", "switched"],
        },
      },
    };
  };
  if (warnings.some((warning) => warning.code === DEEP_RESEARCH_PROVENANCE_WARNING_CODE)) {
    return warnings.map(mergeDetails);
  }
  return [
    ...warnings,
    mergeDetails({
      code: DEEP_RESEARCH_PROVENANCE_WARNING_CODE,
      severity: "warning",
      message:
        "Deep Research report captured, but exact report-owner, selected/default-model, owner-model, report-hash, or picker provenance is incomplete or inconsistent; do not claim a fully verified Deep Research response.",
      details: {},
    }),
  ];
}

function normalizeCitationStatus(
  value: unknown,
): NonNullable<DeepResearchCompletionResult["citationStatus"]> | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { total?: unknown; linked?: unknown; missingIndexes?: unknown };
  if (
    !Number.isSafeInteger(raw.total) ||
    (raw.total as number) < 0 ||
    (raw.total as number) > 999 ||
    !Number.isSafeInteger(raw.linked) ||
    (raw.linked as number) < 0 ||
    (raw.linked as number) > (raw.total as number) ||
    !Array.isArray(raw.missingIndexes)
  ) {
    return null;
  }
  const missingIndexes = raw.missingIndexes;
  if (
    missingIndexes.some(
      (index) => !Number.isSafeInteger(index) || (index as number) < 1 || (index as number) > 999,
    ) ||
    new Set(missingIndexes).size !== missingIndexes.length ||
    (raw.linked as number) + missingIndexes.length !== (raw.total as number)
  ) {
    return null;
  }
  return {
    total: raw.total as number,
    linked: raw.linked as number,
    missingIndexes: (missingIndexes as number[]).slice(),
  };
}

function readMarkdownCitationEvidence(markdown: string): {
  total: number;
  linked: number;
  missingIndexes: number[];
  leakedInternalMarkers: number[];
} {
  const linkedIndexes = new Set<number>();
  const markerIndexes = new Set<number>();
  const internalIndexes = new Set<number>();
  for (const match of markdown.matchAll(/\[(\d{1,3})\]\(\s*<?https?:\/\//gi)) {
    const index = Number(match[1]);
    if (index >= 1 && index <= 999) linkedIndexes.add(index);
  }
  for (const match of markdown.matchAll(/\[(\d{1,3})\](?!\s*\()/g)) {
    const index = Number(match[1]);
    if (index >= 1 && index <= 999) markerIndexes.add(index);
  }
  for (const match of markdown.matchAll(
    /\[\[ORACLE_DEEP_RESEARCH_CITATION(?:_[a-f0-9]{32})?_(\d{1,3})\]\]/gi,
  )) {
    const index = Number(match[1]);
    if (index >= 1 && index <= 999) internalIndexes.add(index);
  }
  const allIndexes = new Set([...linkedIndexes, ...markerIndexes, ...internalIndexes]);
  const missingIndexes = Array.from(allIndexes)
    .filter((index) => !linkedIndexes.has(index))
    .sort((a, b) => a - b);
  return {
    total: allIndexes.size,
    linked: linkedIndexes.size,
    missingIndexes,
    leakedInternalMarkers: Array.from(internalIndexes).sort((a, b) => a - b),
  };
}

function citationStatusMatchesMarkdown(
  status: NonNullable<DeepResearchCompletionResult["citationStatus"]>,
  markdown: string,
): { matches: boolean; observed: ReturnType<typeof readMarkdownCitationEvidence> } {
  const observed = readMarkdownCitationEvidence(markdown);
  const expectedMissing = status.missingIndexes.slice().sort((a, b) => a - b);
  const missingMatchesExactly =
    expectedMissing.length === observed.missingIndexes.length &&
    expectedMissing.every((index, position) => index === observed.missingIndexes[position]);
  const exactCountsMatch =
    status.total === observed.total && status.linked === observed.linked && missingMatchesExactly;
  const completeStatusHasFullyLinkedBibliographySuperset =
    status.total > 0 &&
    status.missingIndexes.length === 0 &&
    observed.missingIndexes.length === 0 &&
    observed.total >= status.total &&
    observed.linked >= status.linked;
  return {
    matches:
      observed.leakedInternalMarkers.length === 0 &&
      (exactCountsMatch || completeStatusHasFullyLinkedBibliographySuperset),
    observed,
  };
}

/**
 * Applies the fork's fail-closed Deep Research evidence contract to a captured
 * report. Initial runs and every reattach path must use this same validator so
 * a useful report is never confused with a fully verified one.
 */
export function buildDeepResearchAnswerFields(
  result: DeepResearchCompletionResult,
): DeepResearchAnswerFields {
  const reportText = typeof result.text === "string" ? result.text.trim() : "";
  const evidence = result.assistantTurn;
  const warnings = buildDeepResearchProvenanceWarnings(reportText, evidence);

  const citationStatus = normalizeCitationStatus(result.citationStatus);
  if (!citationStatus) {
    warnings.push({
      code: DEEP_RESEARCH_CITATIONS_WARNING_CODE,
      severity: "warning",
      message:
        "Deep Research report captured, but complete interactive citation-destination evidence is unavailable; unresolved citation numbers were preserved without guessed links.",
      details: { citationStatus: "missing-or-invalid" },
    });
  } else {
    const comparison = citationStatusMatchesMarkdown(citationStatus, reportText);
    if (!comparison.matches) {
      warnings.push({
        code: DEEP_RESEARCH_CITATIONS_WARNING_CODE,
        severity: "warning",
        message:
          "Deep Research report captured, but its citation-status evidence does not match the returned Markdown; do not claim complete citation verification.",
        details: {
          citationStatus: "report-mismatch",
          recorded: citationStatus,
          observed: comparison.observed,
        },
      });
    } else if (citationStatus.missingIndexes.length > 0) {
      warnings.push({
        code: DEEP_RESEARCH_CITATIONS_WARNING_CODE,
        severity: "warning",
        message:
          "Deep Research report captured, but complete interactive citation-destination evidence is unavailable; unresolved citation numbers were preserved without guessed links.",
        details: {
          total: citationStatus.total,
          linked: citationStatus.linked,
          missingIndexes: citationStatus.missingIndexes,
        },
      });
    }
  }

  return {
    answerText: reportText,
    answerMarkdown: reportText,
    answerHtml: result.html,
    assistantTurn: evidence,
    ...(citationStatus ? { citationStatus } : {}),
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

export function revalidateDeepResearchAnswerFields(
  result: Pick<
    DeepResearchAnswerFields,
    "answerText" | "answerMarkdown" | "answerHtml" | "assistantTurn" | "citationStatus"
  >,
): DeepResearchAnswerFields {
  return buildDeepResearchAnswerFields({
    text: result.answerMarkdown,
    html: result.answerHtml,
    meta: result.assistantTurn ?? {},
    assistantTurn: result.assistantTurn,
    citationStatus: result.citationStatus,
  });
}

export function isDeepResearchEvidenceWarning(warning: BrowserRunWarning): boolean {
  return DEEP_RESEARCH_WARNING_CODES.has(warning.code);
}

/** Replace only the two derived Deep Research warnings, preserving unrelated diagnostics. */
export function replaceDeepResearchEvidenceWarnings(
  existing: readonly BrowserRunWarning[] | undefined,
  fresh: readonly BrowserRunWarning[],
): BrowserRunWarning[] | undefined {
  const merged = [
    ...(existing ?? []).filter((warning) => !isDeepResearchEvidenceWarning(warning)),
    ...fresh.filter(isDeepResearchEvidenceWarning),
  ];
  return merged.length > 0 ? merged : undefined;
}
