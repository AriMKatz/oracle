import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { BrowserAssistantTurnEvidence, BrowserRunWarning } from "../../src/sessionStore.js";
import {
  addDeepResearchPickerEvidenceWarning,
  buildDeepResearchAnswerFields,
  replaceDeepResearchEvidenceWarnings,
} from "../../src/browser/deepResearchAnswer.js";

const warning = (code: string, message = code): BrowserRunWarning => ({
  code,
  severity: "warning",
  message,
});

const report = "Report finding [1](<https://example.com/source>)";
const validEvidence = (
  text: string,
  overrides: Partial<BrowserAssistantTurnEvidence> = {},
): BrowserAssistantTurnEvidence => ({
  messageId: "message-owner",
  finalMessageId: "message-final",
  turnIndex: 3,
  modelSlug: "gpt-5-5-instant",
  resolvedModelSlug: "gpt-5-5-instant",
  defaultModelSlug: "gpt-5-6-pro",
  deepResearchVersion: "standard",
  metadataSource: "chatgpt-conversation-record",
  responseSha256: createHash("sha256").update(text.trim()).digest("hex"),
  capturedAt: "2026-07-15T20:00:00.000Z",
  ...overrides,
});

describe("buildDeepResearchAnswerFields", () => {
  test("returns and hashes the same trimmed report while carrying positive citation status", () => {
    const result = buildDeepResearchAnswerFields({
      text: `\n  ${report}  \n`,
      meta: {},
      assistantTurn: validEvidence(report),
      citationStatus: { total: 1, linked: 1, missingIndexes: [] },
    });

    expect(result.answerText).toBe(report);
    expect(result.answerMarkdown).toBe(report);
    expect(result.citationStatus).toEqual({ total: 1, linked: 1, missingIndexes: [] });
    expect(result.warnings).toBeUndefined();
  });

  test("rejects padded identifiers and slugs, unsafe turn indexes, and invalid timestamps", () => {
    const result = buildDeepResearchAnswerFields({
      text: report,
      meta: {},
      assistantTurn: validEvidence(report, {
        messageId: " message-owner ",
        finalMessageId: " message-final ",
        turnIndex: -1,
        modelSlug: " gpt-5-5-instant",
        resolvedModelSlug: "gpt-5-5-instant ",
        defaultModelSlug: " gpt-5-6-pro ",
        deepResearchVersion: " standard ",
        capturedAt: "not-a-date",
      }),
      citationStatus: { total: 1, linked: 1, missingIndexes: [] },
    });

    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "browser-deep-research-provenance-incomplete",
        details: expect.objectContaining({
          mismatchedFields: expect.arrayContaining([
            "messageId",
            "finalMessageId",
            "turnIndex",
            "modelSlug",
            "resolvedModelSlug",
            "defaultModelSlug",
            "deepResearchVersion",
            "capturedAt",
          ]),
        }),
      }),
    ]);
  });

  test("fails closed on an empty report even when the supplied hash matches empty text", () => {
    const result = buildDeepResearchAnswerFields({
      text: " \n ",
      meta: {},
      assistantTurn: validEvidence(""),
      citationStatus: { total: 0, linked: 0, missingIndexes: [] },
    });

    expect(result.answerMarkdown).toBe("");
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "browser-deep-research-provenance-incomplete",
        details: expect.objectContaining({ missingFields: expect.arrayContaining(["reportText"]) }),
      }),
    ]);
  });

  test.each([
    null,
    {},
    { total: 1, linked: 0 },
    { total: -1, linked: 0, missingIndexes: [] },
    { total: 1, linked: 2, missingIndexes: [] },
    { total: 1, linked: 0, missingIndexes: null },
    { total: 1, linked: 0, missingIndexes: [1, 1] },
  ])("warns instead of throwing for malformed citation status %#", (citationStatus) => {
    expect(() =>
      buildDeepResearchAnswerFields({
        text: report,
        meta: {},
        assistantTurn: validEvidence(report),
        citationStatus: citationStatus as never,
      }),
    ).not.toThrow();
    const result = buildDeepResearchAnswerFields({
      text: report,
      meta: {},
      assistantTurn: validEvidence(report),
      citationStatus: citationStatus as never,
    });
    expect(result.citationStatus).toBeUndefined();
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "browser-deep-research-citations-incomplete",
        details: { citationStatus: "missing-or-invalid" },
      }),
    ]);
  });

  test("rejects a fabricated zero-citation clean state when Markdown has a numeric link", () => {
    const result = buildDeepResearchAnswerFields({
      text: report,
      meta: {},
      assistantTurn: validEvidence(report),
      citationStatus: { total: 0, linked: 0, missingIndexes: [] },
    });

    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "browser-deep-research-citations-incomplete",
        details: expect.objectContaining({ citationStatus: "report-mismatch" }),
      }),
    ]);
  });

  test("rejects positive status that does not match numeric citations in Markdown", () => {
    const result = buildDeepResearchAnswerFields({
      text: report,
      meta: {},
      assistantTurn: validEvidence(report),
      citationStatus: { total: 2, linked: 2, missingIndexes: [] },
    });

    expect(result.warnings?.[0]).toMatchObject({
      code: "browser-deep-research-citations-incomplete",
      details: { citationStatus: "report-mismatch" },
    });
  });

  test("accepts fully linked numeric bibliography anchors beyond the interactive citation count", () => {
    const reportWithBibliography =
      "Finding [1](<https://example.com/primary>)\n\n" +
      "References\n\n2. [2](<https://example.com/bibliography>)";
    const result = buildDeepResearchAnswerFields({
      text: reportWithBibliography,
      meta: {},
      assistantTurn: validEvidence(reportWithBibliography),
      citationStatus: { total: 1, linked: 1, missingIndexes: [] },
    });

    expect(result.citationStatus).toEqual({ total: 1, linked: 1, missingIndexes: [] });
    expect(result.warnings).toBeUndefined();
  });

  test("rejects an unresolved extra numeric citation beyond the interactive citation count", () => {
    const reportWithUnresolvedBibliography =
      "Finding [1](<https://example.com/primary>)\n\nReferences\n\n2. [2]";
    const result = buildDeepResearchAnswerFields({
      text: reportWithUnresolvedBibliography,
      meta: {},
      assistantTurn: validEvidence(reportWithUnresolvedBibliography),
      citationStatus: { total: 1, linked: 1, missingIndexes: [] },
    });

    expect(result.warnings?.[0]).toMatchObject({
      code: "browser-deep-research-citations-incomplete",
      details: { citationStatus: "report-mismatch" },
    });
  });

  test("keeps exact count matching when interactive citation status is incomplete", () => {
    const incompleteWithExtraLink =
      "Finding [1]\n\nReferences\n\n2. [2](<https://example.com/bibliography>)";
    const result = buildDeepResearchAnswerFields({
      text: incompleteWithExtraLink,
      meta: {},
      assistantTurn: validEvidence(incompleteWithExtraLink),
      citationStatus: { total: 1, linked: 0, missingIndexes: [1] },
    });

    expect(result.warnings?.[0]).toMatchObject({
      code: "browser-deep-research-citations-incomplete",
      details: { citationStatus: "report-mismatch" },
    });
  });

  test("rejects leaked internal citation markers even when numeric totals agree", () => {
    const marker = `Finding[[ORACLE_DEEP_RESEARCH_CITATION_${"a".repeat(32)}_1]]`;
    const result = buildDeepResearchAnswerFields({
      text: marker,
      meta: {},
      assistantTurn: validEvidence(marker),
      citationStatus: { total: 1, linked: 0, missingIndexes: [1] },
    });

    expect(result.warnings?.[0]).toMatchObject({
      code: "browser-deep-research-citations-incomplete",
      details: expect.objectContaining({ citationStatus: "report-mismatch" }),
    });
  });

  test("carries matching unresolved status and keeps its incomplete-citation warning", () => {
    const unresolved = "Finding [2]";
    const result = buildDeepResearchAnswerFields({
      text: unresolved,
      meta: {},
      assistantTurn: validEvidence(unresolved),
      citationStatus: { total: 1, linked: 0, missingIndexes: [2] },
    });

    expect(result.citationStatus).toEqual({ total: 1, linked: 0, missingIndexes: [2] });
    expect(result.warnings?.[0]).toMatchObject({
      code: "browser-deep-research-citations-incomplete",
      details: { total: 1, linked: 0, missingIndexes: [2] },
    });
  });
});

describe("replaceDeepResearchEvidenceWarnings", () => {
  test("clears both stale derived warnings after a clean fresh recovery", () => {
    expect(
      replaceDeepResearchEvidenceWarnings(
        [
          warning("browser-deep-research-provenance-incomplete", "stale provenance"),
          warning("browser-pro-fast-large-run", "unrelated"),
          warning("browser-deep-research-citations-incomplete", "stale citations"),
        ],
        [],
      ),
    ).toEqual([warning("browser-pro-fast-large-run", "unrelated")]);
  });

  test("replaces stale derived warnings with the complete fresh derived set", () => {
    const fresh = [
      warning("browser-deep-research-provenance-incomplete", "fresh provenance"),
      warning("browser-deep-research-citations-incomplete", "fresh citations"),
    ];
    expect(
      replaceDeepResearchEvidenceWarnings(
        [
          warning("browser-deep-research-provenance-incomplete", "stale provenance"),
          warning("browser-pro-fast-large-run", "unrelated"),
        ],
        fresh,
      ),
    ).toEqual([warning("browser-pro-fast-large-run", "unrelated"), ...fresh]);
  });
});

describe("addDeepResearchPickerEvidenceWarning", () => {
  const validPicker = {
    requestedModel: "Pro",
    resolvedLabel: "Pro",
    strategy: "select" as const,
    status: "already-selected" as const,
    verified: true,
    source: "chatgpt-model-picker" as const,
    capturedAt: "2026-07-15T20:00:00.000Z",
  };

  test("keeps clean report provenance clean with exact persisted Pro picker evidence", () => {
    expect(addDeepResearchPickerEvidenceWarning([], validPicker)).toEqual([]);
  });

  test("fails closed when picker evidence is absent during reattach", () => {
    expect(addDeepResearchPickerEvidenceWarning([], undefined)).toEqual([
      expect.objectContaining({
        code: "browser-deep-research-provenance-incomplete",
        details: expect.objectContaining({ missingFields: ["modelSelection"] }),
      }),
    ]);
  });

  test("requires exact verified Pro picker fields", () => {
    expect(
      addDeepResearchPickerEvidenceWarning([], {
        ...validPicker,
        requestedModel: "pro",
        resolvedLabel: " Pro ",
        verified: false,
        source: "config",
      }),
    ).toEqual([
      expect.objectContaining({
        code: "browser-deep-research-provenance-incomplete",
        details: expect.objectContaining({
          mismatchedFields: expect.arrayContaining([
            "modelSelection.requestedModel",
            "modelSelection.resolvedLabel",
            "modelSelection.verified",
            "modelSelection.source",
          ]),
        }),
      }),
    ]);
  });
});
