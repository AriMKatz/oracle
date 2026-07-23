import vm from "node:vm";
import { describe, expect, test } from "vitest";
import {
  buildConversationIdReadExpression,
  extractConversationIdFromUrl,
  isConversationUrl,
} from "../../src/browser/conversationIdentity.js";

const WEB_ID = "WEB:4006dc3c-d3c2-43d1-9391-1b5f51e324ef";

describe("ChatGPT conversation identity", () => {
  test("preserves the complete WEB conversation path segment", () => {
    expect(extractConversationIdFromUrl(`https://chatgpt.com/c/${WEB_ID}`)).toBe(WEB_ID);
    expect(extractConversationIdFromUrl(`https://chatgpt.com/c/${WEB_ID}?model=pro#turn`)).toBe(
      WEB_ID,
    );
    expect(
      extractConversationIdFromUrl(`https://chatgpt.com/c/${encodeURIComponent(WEB_ID)}`),
    ).toBe(WEB_ID);
    expect(isConversationUrl(`https://chatgpt.com/c/${WEB_ID}`)).toBe(true);
    expect(extractConversationIdFromUrl("https://chatgpt.com/")).toBeUndefined();
    expect(extractConversationIdFromUrl(`https://example.com/?next=/c/${WEB_ID}`)).toBeUndefined();
  });

  test("uses the same path-segment parser inside browser expressions", () => {
    const expression = buildConversationIdReadExpression(
      JSON.stringify(`/c/${encodeURIComponent(WEB_ID)}`),
    );
    expect(new vm.Script(expression).runInNewContext()).toBe(WEB_ID);
  });
});
