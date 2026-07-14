# Upstream Sync Policy

This document governs how `AriMKatz/oracle` incorporates changes from
`steipete/oracle`.

It is repository-maintenance policy only. It must not be copied into
`skills/oracle/SKILL.md`, injected into Oracle prompts, or treated as part of
Oracle's review semantics.

## Fork philosophy

This fork is a thin, selectively synchronized downstream—not an independent
rewrite and not a blindly synchronized mirror.

- `steipete/oracle` is the authority for Oracle's general product behavior and
  meta-prompt semantics.
- `AriMKatz/oracle/main` is the authority for the runnable version used on this
  Mac.
- The fork should contain only the smallest operational delta required for a
  reliable macOS browser path.
- Upstream fixes are actively welcomed. When an upstream implementation
  provides an equivalent or stronger fix, it should replace the corresponding
  local patch rather than accumulate beside it.
- Every integration is evidence-gated. Convenience is not a substitute for
  inspecting the actual diff and proving the resulting behavior.

In one sentence:

> Accept upstream meaning exactly, accept compatible improvements, replace
> local patches with proven upstream fixes, and adapt or reject anything that
> weakens the local execution contract.

## Authority boundaries

### Upstream semantic authority

Upstream owns the meaning of an Oracle request, including:

- task and question construction;
- project briefing and context-selection guidance;
- attachment semantics;
- review, research, and output instructions;
- prompt structure and one-shot behavior.

Intentional upstream changes to those semantics should be reviewed as an
actual diff and, once accepted for synchronization, carried exactly. The fork
must not paraphrase them, add a generic wrapper, force an output style, move the
substantive question into a different channel, or add locally invented policy.

At minimum, every synchronization must compare the complete `Attaching files`
and `Prompt template` sections against the selected upstream commit. Matching
is relative to that selected upstream commit; hashes are evidence for a
specific integration, not permanent constants.

### Fork operational authority

The fork owns the local execution contract:

- browser mode is the documented installed-skill path;
- Stable Chrome uses an explicit copied `Profile 1` by default;
- `gpt-5-pro` selects the visible Pro target;
- the exact returned assistant turn must report `gpt-5-6-pro`;
- returned-turn identity, index, and response hash are persisted;
- the saved transcript is the post-run answer source;
- authentication and model-evidence failures stop the run;
- no silent model, engine, manual-login, or private-profile fallback is used;
- no Keychain mutation, mandatory preliminary request, or hidden machine
  configuration is required;
- compatible controls such as attachments, attach-running Chrome, remote
  Chrome, follow-ups, replay, research, and archiving remain available as
  explicit choices rather than automatic fallbacks.

The underlying upstream program may retain capabilities such as API mode. The
local browser-only rule governs the installed skill's default procedure; it
does not require deleting unrelated upstream capabilities from the codebase.

### Deployment authority

`AriMKatz/oracle/main` is the single canonical downstream state. The local
checkout and `~/.codex/skills/oracle/` are deployments of it, not independent
sources of truth.

After every accepted synchronization:

- the repository must be clean;
- the installed skill directory must match `skills/oracle/` with no extra
  active files;
- no required behavior may live only in `~/.oracle/config.json`, an untracked
  helper, or another machine-only location.

## Change classification

Classify changes by their effect, not merely by commit title or filename.

### Accept exactly

Accept upstream-authored semantic changes exactly after reviewing the actual
diff. Examples include changes to prompt construction, attachment/context
semantics, or general review instructions.

Material semantic changes should be called out explicitly in the sync review
so they are understood rather than silently inherited.

### Accept after compatibility proof

Accept general upstream improvements when they do not weaken the local
execution contract. This includes:

- bug and security fixes;
- dependency, build, test, and documentation improvements;
- optional capabilities that remain optional;
- unrelated product changes that leave the protected browser path intact.

Passing tests alone is not sufficient when a change touches browser identity,
authentication, profile copying, model selection, answer capture, or session
evidence.

### Prefer upstream fixes that supersede local patches

Upstream changes that fix the original problem or a protected execution
surface are presumptively desirable. Relevant surfaces include:

- Chrome profile-copy consistency and transient copy failures;
- explicit profile selection;
- cookie or Keychain authentication detection;
- stale or foreign DevTools-port detection;
- logged-out fail-fast behavior;
- Pro selection and exact returned-model evidence;
- final-turn identity and saved-transcript correctness;
- temporary-profile cleanup.

When upstream supplies an equivalent or stronger fix:

1. Test it against the original failure and the current operational contract.
2. Prefer the upstream implementation.
3. Remove the redundant local implementation and tests that no longer add a
   distinct guarantee.
4. Retain only the smallest remaining local delta.
5. Document which local patch was superseded and the evidence that justified
   removing it.

Do not retain local code merely because it arrived first. Do not remove a local
guarantee merely because upstream touched the same file.

### Adapt before accepting

Adapt an upstream change when its useful part can be preserved but its direct
application would weaken the local contract. Typical examples include:

- a new profile-selection implementation that would reintroduce ambiguity;
- model-selection changes that do not prove the returned GPT-5.6 Pro turn;
- recovery changes that assume a deleted throwaway profile can be reattached;
- defaults that silently select API mode or another model;
- changes that combine copied-profile mode with incompatible browser options.

The adaptation must remain generic and upstream-faithful. It must not be a
fixture-specific exception created only to make a test pass.

### Reject

Reject an upstream effect—or omit that part of a mixed change—when it would:

- introduce a local semantic rewrite rather than carry upstream semantics;
- add a generic prompt wrapper or forced review style;
- make profile or browser identity ambiguous;
- add silent model, engine, authentication, or transport fallback;
- accept a picker label without exact returned-turn evidence;
- discard final-turn identity, response hash, or saved-answer evidence;
- continue after authentication or evidence verification fails;
- require invasive Keychain changes or hidden machine-only state;
- remove compatible optional controls only because they are not the default;
- create important behavior that is absent from the canonical fork.

Security fixes must not be rejected merely because they touch protected code.
Adapt them without weakening either the security fix or the local guarantee.

## Mixed commits

An upstream commit is not an indivisible policy unit. If one commit contains
both desired and incompatible changes:

- carry upstream semantic hunks exactly;
- carry compatible implementation hunks;
- adapt protected operational hunks;
- omit unrelated or conflicting policy changes;
- record the resulting actual diff and rationale.

Never classify a mixed commit only as "accepted" or "rejected" without
explaining which effects were retained.

## Synchronization workflow

The `upstream` remote must remain fetch-only with pushing disabled. Do not use
GitHub's one-click **Sync fork** action and do not merge upstream directly into
`main`.

1. Fetch without modifying the working branch:

   ```bash
   git fetch upstream
   ```

2. Create a temporary candidate from the canonical fork:

   ```bash
   git switch -c sync/upstream-YYYYMMDD origin/main
   ```

3. Inspect the incoming history and actual diff before applying anything:

   ```bash
   git log --left-right --cherry-pick --oneline origin/main...upstream/main
   git diff --stat origin/main...upstream/main
   git diff origin/main...upstream/main
   ```

4. Classify each effect using this policy. Apply selected commits or hunks to
   the candidate branch. Do not perform a blind merge merely to make the branch
   appear synchronized.

5. Review the complete candidate diff against both `origin/main` and the exact
   upstream commit being incorporated.

6. Run the required verification gates.

7. Open a pull request from the temporary branch into
   `AriMKatz/oracle:main`. This is an internal fork-maintenance PR, not a PR to
   `steipete/oracle`.

8. Merge only after the diff and evidence are accepted. Do not force-push
   `main` during normal synchronization.

9. Install `skills/oracle/` from the accepted `main`, verify directory and byte
   identity, then delete the temporary branch.

An upstream PR must be opened only when explicitly requested as a separate
action.

## Required verification gates

Every candidate must pass:

- `git diff --check`;
- `pnpm run check`;
- `pnpm test`;
- `pnpm run build`;
- inspection of the actual complete diff;
- semantic comparison against the selected upstream commit;
- verification that the installed skill is a byte-identical deployment of the
  repository skill after merge.

If browser identity, authentication, profile copying, model selection, answer
capture, or session evidence changes, also require a blinded end-to-end smoke
test that proves:

- copied Stable Chrome `Profile 1` authentication;
- verified Pro selection;
- exact returned model `gpt-5-6-pro`;
- final-turn identity and response hash;
- answer recovery from the saved transcript;
- no fallback;
- cleanup of the disposable browser profile.

The smoke-test agent must receive the task and current skill, but no prior
debugging conversation or expected implementation details.

## Completion record

Each synchronization should record:

- previous fork commit;
- selected upstream commit;
- accepted, adapted, rejected, and superseded changes;
- the actual final diff;
- verification results;
- final `main` commit;
- repository-skill and installed-skill hashes.

The goal is not to maximize the number of upstream commits absorbed. The goal
is to keep the fork semantically upstream-faithful, operationally reliable,
minimal, inspectable, and easy to collapse back toward upstream whenever
upstream adopts equivalent fixes.
