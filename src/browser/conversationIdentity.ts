export const CHATGPT_CONVERSATION_PATH_SEGMENT_PATTERN = "[^/?#]+";

function decodeConversationPathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function extractConversationIdFromUrl(url: string): string | undefined {
  const value = String(url ?? "").trim();
  if (!value) return undefined;
  let pathname = value.split(/[?#]/, 1)[0] ?? value;
  try {
    pathname = new URL(value).pathname;
  } catch {
    // Relative paths are valid inputs for DOM and target helpers.
  }
  const match = pathname.match(new RegExp(`/c/(${CHATGPT_CONVERSATION_PATH_SEGMENT_PATTERN})`));
  const segment = match?.[1];
  return segment ? decodeConversationPathSegment(segment) : undefined;
}

export function isConversationUrl(url: string): boolean {
  return extractConversationIdFromUrl(url) !== undefined;
}

export function isProvisionalWebConversationId(conversationId: string | null | undefined): boolean {
  return /^WEB:/i.test(String(conversationId ?? "").trim());
}

export function buildConversationIdReadExpression(valueExpression: string): string {
  const pattern = JSON.stringify(CHATGPT_CONVERSATION_PATH_SEGMENT_PATTERN);
  return `((value) => {
    const match = String(value || '').match(new RegExp('/c/(' + ${pattern} + ')'));
    const segment = match?.[1] || null;
    if (!segment) return null;
    try { return decodeURIComponent(segment); } catch { return segment; }
  })(${valueExpression})`;
}
