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
not add a thinking-time flag. The picker label alone does not identify the
server-side Pro version, so the final returned assistant turn must also record
`data-message-model-slug="gpt-5-6-pro"` in its saved runtime evidence.

If picker selection or exact returned-turn verification fails, stop. Do not
switch models or engines. No preliminary model request is required.

## Golden path

1. Pick the smallest file set that still contains the truth.
2. Preview the bundle with `--dry-run` and `--files-report`.
3. Run the substantive GPT-5.6 Pro request directly through the copied-profile
   path, or explicitly choose one of the alternate browser paths below.
4. Verify the saved returned-turn evidence, then read the saved transcript.

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
- Browser attachments, bundled files, same-run follow-ups, and Deep Research
  still require exact evidence for the final returned turn.

## GPT-5.6 Pro verification and saved output

Use the exact id printed as `Session: <id>`.

For a new conversation:

```bash
SESSION_ID="<exact-session-id>"
jq -e '
  .status == "completed" and
  .browser.modelSelection.requestedModel == "Pro" and
  .browser.modelSelection.strategy == "select" and
  .browser.modelSelection.verified == true and
  .browser.runtime.assistantTurn.modelSlug == "gpt-5-6-pro" and
  ((.browser.runtime.assistantTurn.messageId // .browser.runtime.assistantTurn.turnId // "") | length > 0) and
  (.browser.runtime.assistantTurn.turnIndex | type == "number") and
  (.browser.runtime.assistantTurn.responseSha256 | test("^[0-9a-f]{64}$"))
' "${ORACLE_HOME_DIR:-$HOME/.oracle}/sessions/$SESSION_ID/meta.json"
```

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
