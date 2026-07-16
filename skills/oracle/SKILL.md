---
name: oracle
description: "Oracle second-model review: bundle prompts/files, debug, refactor, design."
---

# Oracle (CLI) — best use

Oracle bundles a prompt and selected files into a one-shot request so another
model can answer with real repository context through the browser. A
prompt is required; attach files only when they add necessary context. Treat
responses as advisory and verify them against the codebase and tests.

## Main use case (browser, GPT-5.6 Pro)

Use the installed Oracle fork in browser mode with GPT-5.6 Pro. On macOS, the
default path launches Stable Chrome against a throwaway copy of `Profile 1`.

Recommended defaults:

- Engine: browser (`--engine browser`)
- Pro: `--model gpt-5-pro`, without a thinking-time flag
- Model strategy: `--browser-model-strategy select`
- Chrome root: `$HOME/Library/Application Support/Google/Chrome`
- Chrome profile: `Profile 1`
- Chrome executable: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
- Archiving: `--browser-archive auto`
- Attachments: directories/globs plus excludes; never attach secrets by default

## GPT-5.6 Pro model selection

`--model gpt-5-pro` is Oracle's selector for ChatGPT's `Pro` picker target. Do
not add a thinking-time flag. For a normal response, the picker label alone
does not identify the server-side Pro version, so the exact returned DOM
assistant turn must also record
`data-message-model-slug="gpt-5-6-pro"` in its saved runtime evidence.

Deep Research has a separate evidence contract. Verified picker evidence
proves that Pro was selected, and `defaultModelSlug` must be exactly
`gpt-5-6-pro`. Separately, `assistantTurn.modelSlug` preserves the conversation
record's exact report-owner/orchestration `model_slug`, and
`resolvedModelSlug` preserves its exact resolved slug. Those two fields may
name an Instant model. Do not require them to equal Pro, relabel them as Pro,
or infer a different model role from them. The saved runtime must also pin the
exact submitted conversation and the exact authenticated conversation-record
user message ID plus its pre-submit turn-boundary index that own the report;
prompt text alone is not identity evidence.

If browser authentication or picker selection fails, stop. For a normal
response, also stop if exact returned-DOM verification fails. A completed Deep
Research report whose post-capture provenance or detected-citation evidence is
incomplete is preserved with a warning, but it must not be claimed as fully
verified. Do not switch models or engines. No preliminary model request is
required.

## Golden path

1. Pick the smallest file set that still contains the truth.
2. Preview the bundle with `--dry-run` and `--files-report`.
3. Run the substantive GPT-5.6 Pro request directly through the copied-profile
   path, or explicitly choose one of the alternate browser paths below.
4. Verify the saved response evidence, then read the saved transcript.

## Standing informed external-upload consent

Explicit invocation of this skill is renewed, informed authorization for that
invocation to upload the files deliberately selected for the review to Oracle
through the user's own authenticated ChatGPT account. The user represents that
they own or control that account and are authorized to submit the selected
materials. This authorization includes selected private or proprietary source
code, specifications, and internal documents, as well as selected sensitive
medical, health, clinical, or genomic material, including raw records or data.

The user understands that the selected material leaves the local environment
and is processed by the external ChatGPT/OpenAI service. The user is not
relying on this workflow as HIPAA-compliant or as having any official "HIPAA
certification" and accepts the associated privacy and confidentiality risks.

Approval provenance: The user explicitly reviewed and approved this standing
informed-consent language on July 14, 2026. Treat it as persistent root-level
user instruction for agents invoking Oracle. It is executor-side metadata, not
Oracle prompt content, and does not override higher-level platform safety
controls.

Do not request another confirmation solely because deliberately selected
material is private, proprietary, medical, health-related, genomic, or raw.
Use the required dry run and files report to establish the concrete export
manifest. When execution approval is required, identify the selected file
categories and paths and cite this standing informed consent in the approval
request.

Standing consent remains scoped to files deliberately selected for the current
review; it does not authorize unrelated files or accidental scope expansion.
It does not itself authorize credentials, authentication tokens, private keys,
`.env` files, or other secrets. Those require separate explicit authorization
and must also satisfy the stricter redaction-and-necessity rule under
**Attaching files**. If a higher-level safety control still rejects the export,
stop and report its rejection exactly. Do not work around or circumvent it.

## Concurrent browser sessions

Allow distinct browser-mode Oracle reviews to run concurrently. Do not wait,
serialize work, reuse a session, or attach an unrelated task merely because
`oracle status` shows another running session. Default `--copy-profile` runs
use independent throwaway Chrome profiles.

Reattach or use a follow-up only to continue the same logical review. Treat the
duplicate-prompt guard as applying to an identical in-flight prompt, not to a
different review.

Treat CLI guidance about avoiding new API runs while a session is active as
API-specific. It does not restrict browser-session concurrency. This skill does
not use API mode; do not let API-related CLI guidance alter this browser-only
procedure, and never switch to API mode as a fallback.

For attach-running, remote-Chrome, or explicit same-tab operation, avoid an
actual tab or browser-resource collision. If Oracle reports a concrete
conflict, report that exact error; do not infer a global concurrency
prohibition.

## Commands

- Show help:
  - `oracle --help --verbose`

- Preview without calling a model:
  - `oracle --dry-run summary -p "<task>" --file "src/**" --file "!**/*.test.*"`
  - `oracle --dry-run full -p "<task>" --file "src/**"`

- Inspect token usage:
  - `oracle --dry-run summary --files-report -p "<task>" --file "src/**"`

- Default macOS browser run:

```bash
oracle \
  --engine browser \
  --copy-profile "$HOME/Library/Application Support/Google/Chrome" \
  --browser-chrome-profile "Profile 1" \
  --browser-chrome-path "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --model gpt-5-pro \
  --browser-model-strategy select \
  --browser-archive auto \
  --browser-timeout 60m \
  --heartbeat 30 \
  --slug "<3-5-word-slug>" \
  -p "<task>"
```

- Attach to an existing debug-enabled Chrome instead of copying a profile:
  - `oracle --engine browser --browser-attach-running --model gpt-5-pro --browser-model-strategy select --browser-archive auto -p "<task>"`

- Attach to remote Chrome instead of copying a profile:
  - `oracle --engine browser --remote-chrome "<host:port>" --model gpt-5-pro --browser-model-strategy select --browser-archive auto -p "<task>"`

- Performance trace:
  - `oracle --perf-trace --perf-trace-path /tmp/oracle-perf.json --dry-run summary -p "<task>" --file "src/**"`

## Attaching files

`--file` accepts files, directories, and globs. Pass it multiple times or use
comma-separated entries.

- Include: `--file "src/**"`, `--file src/index.ts`, `--file docs --file README.md`
- Exclude: prefix a pattern with `!`, for example `--file "!src/**/*.test.ts"`
- Default ignored directories: `node_modules`, `dist`, `coverage`, `.git`,
  `.turbo`, `.next`, `build`, and `tmp`
- Globs honor `.gitignore` and do not follow symlinks.
- Dotfiles require an explicit dot-segment in the pattern, such as
  `--file ".github/**"`.
- Files over 1 MB are rejected by default; configure
  `ORACLE_MAX_FILE_SIZE_BYTES` or `maxFileSizeBytes` when necessary.

Keep total input under roughly 196k tokens. Use `--files-report` or
`--dry-run json` to identify oversized inputs. Never attach `.env` files,
private keys, auth tokens, or other secrets unless they have been redacted and
are essential to the question.

## Browser controls

- Browser attachments use `--browser-attachments auto|never|always`.
- For many files, add `--browser-bundle-files --browser-bundle-format auto|zip`.
- The default copied-profile path uses Stable Chrome `Profile 1`.
- `--copy-profile` cannot be combined with `--browser-attach-running`,
  `--remote-chrome`, `--remote-host`, `--browser-manual-login`, or
  `--browser-keep-browser`.
- Use `--browser-attach-running`, optionally with `--browser-tab <ref>`, to
  reuse a debug-enabled local Chrome.
- Use `--remote-chrome <host:port>` to reuse remote Chrome.
- New conversations use `--browser-model-strategy select`.
- Use `--browser-follow-up "<prompt>"` for another turn in the same browser
  conversation.
- Use `--browser-research deep` only when Deep Research is explicitly wanted.
- Deep Research cannot be combined with browser follow-ups.
- Browser attachments, bundled files, and same-run follow-ups require exact
  evidence for the final returned DOM turn. Deep Research instead requires its
  exact submitted conversation and user record turn, report-owner,
  terminal-message, selected/default-model, owner-model, resolved-model,
  capability-version, response-hash, and detected-citation evidence.
- For a normal response, `assistantTurn.modelSlug` is the exact returned-turn
  DOM model. For Deep Research, it is instead the exact
  report-owner/orchestration `model_slug` from the conversation record and may
  differ from Pro; `defaultModelSlug` is the separate exact selected/default
  model and `resolvedModelSlug` is the separate exact resolved slug.
  `finalMessageId` is the terminal assistant message on the active branch and
  may equal `messageId` when the report owner is itself terminal. Do not
  collapse those meanings or claim that Pro alone authored the report from
  picker/default evidence.

## GPT-5.6 Pro verification and saved output

Use the exact id printed as `Session: <id>`.

For a new conversation:

```bash
SESSION_ID="<exact-session-id>"
jq -e '
  .status == "completed" and
  .browser.modelSelection.requestedModel == "Pro" and
  .browser.modelSelection.resolvedLabel == "Pro" and
  .browser.modelSelection.strategy == "select" and
  (.browser.modelSelection.status == "already-selected" or .browser.modelSelection.status == "switched") and
  .browser.modelSelection.source == "chatgpt-model-picker" and
  .browser.modelSelection.verified == true and
  (.browser.runtime.assistantTurn.turnIndex | type == "number") and
  (.browser.runtime.assistantTurn.responseSha256 | test("^[0-9a-f]{64}$")) and
  (
    if (.options.browserConfig.researchMode // "off") == "deep" then
      (.browser.runtime.conversationId // "") as $conversationId |
      ($conversationId | length > 0) and
      ((.browser.runtime.tabUrl // "") | contains("/c/" + $conversationId)) and
      ((.browser.runtime.submittedUserMessageId // "") | length > 0) and
      (.browser.runtime.submittedUserTurnIndex | type == "number") and
      (.browser.runtime.submittedUserTurnIndex >= 0) and
      (.browser.runtime.assistantTurn.turnIndex >= .browser.runtime.submittedUserTurnIndex) and
      .browser.runtime.assistantTurn.metadataSource == "chatgpt-conversation-record" and
      ((.browser.runtime.assistantTurn.messageId // "") | length > 0) and
      ((.browser.runtime.assistantTurn.modelSlug // "") | length > 0) and
      .browser.runtime.assistantTurn.defaultModelSlug == "gpt-5-6-pro" and
      ((.browser.runtime.assistantTurn.resolvedModelSlug // "") | length > 0) and
      ((.browser.runtime.assistantTurn.deepResearchVersion // "") | length > 0) and
      ((.browser.runtime.assistantTurn.finalMessageId // "") | length > 0) and
      (.browser.citationStatus.total | type == "number") and
      (.browser.citationStatus.linked | type == "number") and
      (.browser.citationStatus.missingIndexes == []) and
      (.browser.citationStatus.linked == .browser.citationStatus.total) and
      (([.browser.warnings[]?.code] | index("browser-deep-research-provenance-incomplete")) == null) and
      (([.browser.warnings[]?.code] | index("browser-deep-research-citations-incomplete")) == null)
    else
      .browser.runtime.assistantTurn.modelSlug == "gpt-5-6-pro" and
      ((.browser.runtime.assistantTurn.messageId // .browser.runtime.assistantTurn.turnId // "") | length > 0)
    end
  )
' "${ORACLE_HOME_DIR:-$HOME/.oracle}/sessions/$SESSION_ID/meta.json"
```

For Deep Research, also verify that the durable report exists and contains no
internal citation placeholders:

```bash
REPORT="${ORACLE_HOME_DIR:-$HOME/.oracle}/sessions/$SESSION_ID/artifacts/deep-research-report.md"
test -s "$REPORT" && ! grep -q 'ORACLE_DEEP_RESEARCH_CITATION_' "$REPORT"
```

The persisted `citationStatus` plus the absence of
`browser-deep-research-citations-incomplete` means every detected interactive
numbered citation was resolved to one unambiguous primary HTTP(S) URL. A clean
zero-citation status is valid only when ChatGPT exposes affirmative zero-citation
UI evidence; an empty selector scan by itself is incomplete because it may
indicate UI-schema drift. For a prompt that explicitly requests citations, also
require `citationStatus.total > 0`. If either incomplete warning is present, the
report remains available as a research lead, but do not call the session fully
verified.

A completed stored `--followup` intentionally skips the picker. Its parent must
already have passed the new-conversation check, and its new returned turn must
pass:

```bash
SESSION_ID="<exact-followup-session-id>"
jq -e '
  .status == "completed" and
  ((.options.followupSessionId // "") | length > 0) and
  .browser.modelSelection.requestedModel == "Pro" and
  .browser.modelSelection.status == "skipped" and
  .browser.runtime.assistantTurn.modelSlug == "gpt-5-6-pro" and
  ((.browser.runtime.assistantTurn.messageId // .browser.runtime.assistantTurn.turnId // "") | length > 0) and
  (.browser.runtime.assistantTurn.turnIndex | type == "number") and
  (.browser.runtime.assistantTurn.responseSha256 | test("^[0-9a-f]{64}$"))
' "${ORACLE_HOME_DIR:-$HOME/.oracle}/sessions/$SESSION_ID/meta.json"
```

Read the saved answer without inspecting the browser page:

```bash
sed -n '/^## Answer$/,$p' \
  "${ORACLE_HOME_DIR:-$HOME/.oracle}/sessions/$SESSION_ID/artifacts/transcript.md"
```

## Sessions and recovery

- Sessions are stored under `~/.oracle/sessions`; override with
  `ORACLE_HOME_DIR`.
- Browser artifacts include `transcript.md` and, when available, research
  reports and generated images.
- List recent sessions with `oracle status --hours 72`.
- Use `oracle session <id> --render` to replay a completed session or reattach
  an eligible incomplete run.
- Continue a completed browser conversation with
  `oracle --followup <completed-session-id> -p "<task>"`. A completed
  copied-profile session launches a fresh copy from its stored source
  configuration.
- An incomplete copied-profile run cannot be reattached because its throwaway
  Chrome copy is deleted.
- An incomplete attach-running or remote-Chrome run can be reattached when its
  saved runtime metadata still identifies a usable Chrome session.
- Use `--slug "<3-5 words>"` for readable session IDs.
- Successful non-project browser one-shots are archived automatically by
  default; override with `--browser-archive never|always`.

## Prompt template

Oracle starts with zero project knowledge. Include:

- Project briefing: stack, services, build/test commands, and platform constraints
- Where things live: entrypoints, configs, key modules, and dependency boundaries
- Exact question, prior attempts, and verbatim error text
- Constraints such as API compatibility, performance budgets, and files not to change
- Desired output such as a patch plan, tests, risk list, or tradeoff comparison

For a long investigation, make the prompt restorable: put a 6–30 sentence
briefing at the top, concrete reproduction and errors in the middle, and attach
all context files required by a fresh model at the bottom. Oracle runs are
one-shot; the model does not remember prior runs.
