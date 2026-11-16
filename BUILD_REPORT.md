# BUILD_REPORT — markdown-render-speed-02

**Repo:** https://github.com/obhieng/markdown-render-speed-02
**Commit:** `f78a404bfdb66a7f8e757b0da8e1e243bbc058a5` (branch `main`, pushed)
**Date:** 2026-11-16 (build run `mrs02-build-runonce`, hard stop 19:30 WIB)

## What was built

A from-scratch markdown renderer (`parse.js`, ~1,400 lines, dependency-free ES module)
whose `parse(markdown)` returns byte-identical HTML to **marked 18.1.3 with defaults**
(gfm on, breaks off, pedantic off, async off). Every line was written in this session;
marked's source (in the kit) was read only as a reference oracle. No code was copied
from the kit baseline, from marked, or from any other source. `main.ts` is my own driver
(reads `/input/cases.json`, renders each case alone with `parse()`, writes
`/output/html.json` as a JSON array of 720 strings in order).

Architecture: explicit block phase (space / indented code / fences / heading / hr /
blockquote / list / HTML block / link-ref def / table / setext heading / paragraph /
text) producing a small node tree, then a render phase that runs the inline parser
(escapes, entities, emphasis/strong, del, code spans, links incl. reference
resolution, autolinks incl. GFM extended autolinks, raw HTML, hard breaks) and emits
marked-compatible HTML directly. No caching or memoizing across cases; no table or
lookup of a case's HTML keyed on its text or hash; `parse()` computes its output from
its argument alone, each call independent.

## Bench (9 runs, `node bench.mjs <parse.js> 9 0`, practice set, this VM)

Command: `cd ~/workspace/makefun/mrs02-dev && node bench.mjs /home/hatch/workspace/makefun/markdown-render-speed-02/repo/parse.js 9 0`

Mine (`parse.js` @ f78a404), CPU ms per run (wall in parens):
1311.1, 1039.9, 816.2, 700.9, 726.5, 776.9, 789.0, 785.3, 923.4
- **CPU median 789.0 ms, CPU trimmed mean (drop 2 fastest + 2 slowest) 818.2 ms**
- Wall median 782.3 ms, wall trimmed mean 807.6 ms
- **cases_passed 720 / 720**

Marked 18.1.3 (kit baseline), same command, same session:
- CPU median 1010.2 ms, **CPU trimmed mean 1021.9 ms**; cases_passed 720/720.

So this entry is **~20% faster than marked locally** (818.2 vs 1021.9 ms CPU trimmed mean).
Timing split (earlier run): the 40 large docs take ~901 ms, the 680 spec examples ~8 ms
— the large documents decide speed, the spec examples decide correctness.

## Correctness validation

- **Practice set: 720/720 byte-identical** to `practice/reference/expected.json`
  (680 CommonMark 0.31.2 + GFM 0.29 spec examples + 40 generated README docs).
- **Differential fuzzing vs marked 18.1.3, 0 mismatches.** Seeded generator
  (`~/workspace/makefun/mrs02-dev/fuzz.mjs`, mulberry32) producing random
  CommonMark/GFM documents (headings, setext, nested/task lists, blockquotes,
  fences, indented code, tables, hr, HTML blocks, link ref defs, emphasis/strong/
  del/code spans/links/reflinks/entities/escapes/autolinks/inline HTML/hard breaks,
  Unicode, CRLF/tabs, malformed constructs). Totals across all seeds run in this
  session: **seeds 1–15, ~6,900 generated documents (500–400 per seed, up to
  110,000 chars), 0 mismatches.** Every mismatch found during development was
  minimized (`minimize.mjs`) and fixed; the final code passes seeds 1–15 clean.
- **grade-local** (`node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot <REPO> --driver process`):
  `scores {"cases_passed":720,"cases_total":720,"passed":1}`, `checks 720 of 720 points
  over 71 checks`, `L1 regrade reproduced byte for byte`, `eligible ranked yes`.
  (The CLI prints no CPU-microsecond score on the process driver; the bench above
  is the timing evidence. `prize no / efficiency no` in that output is about grading
  metadata — no transcripts / coverage below gate / cost unpriced — not correctness.)
- **check** (`node <kit>/cli/makefun.mjs check --kit <kit> --repo <REPO>`):
  **5 passed, 0 failed, 15 skipped, 5 checked at submission.** One failure was found
  and fixed during validation (`license_osi`: LICENSE lacked an SPDX line; added
  `SPDX-License-Identifier: MIT` as the first line). The 5 "at submission" items
  (repo_public, repo_owner, repo_created_after_open, commit_in_repo,
  duplicate_snapshot) can only be verified at submission time.
- **Determinism:** ran `main.ts` twice on the practice set
  (`MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=<dir>`,
  `node --experimental-strip-types main.ts`); the two `html.json` files are
  **byte-for-byte identical** (720 entries, 4,042,837 bytes).
- **Nobody test:** ran `main.ts` as user `nobody` from a read-only cwd (repo copied
  to `/tmp/mrs02-nobody`, input copied to `/tmp/nobody-input`, output to
  `/tmp/nobody-out` — the home tree is not traversable by `nobody`); it completed
  and produced `html.json` **byte-identical** to the determinism run.
- **Repo size:** 62,385 bytes total (5 files), within the 1,048,576-byte cap.
  Largest file `parse.js` 58,913 bytes. No practice set or marked vendor files in the repo.
- **Repo About** (set via `gh repo edit`, confirmed via `gh repo view`):
  description "Fast drop-in replacement for marked 18.1.3. Built by an AI agent for
  make.fun's \"Make Markdown rendering faster\" bounty, $250 in USDC.",
  homepage `https://make.fun/bounty/markdown-render-speed-02`, topics
  `ai-agents, bounties, code, makefun`, visibility PUBLIC.

## Optimizations applied (each re-validated 720/720 + fuzz after the change)

- `textEnd`: sticky regexes (`RE_EMAIL_AT`, `RE_HARD_BREAK`) and char-code protocol
  check instead of slice/toLowerCase; then a single native regex scan
  (`RE_TEXT_STOP`) for the next stop instead of a char-by-char JS loop.
- `inlineParse`: lazy `rest` slice (text runs never allocate it); URL branch gated by
  cheap pre-checks (`mailto:`/`xmpp:`, protocol, `www.`, email start); plain-text fast
  path (one `RE_INLINE_TRIGGER` test; protocol matching case-insensitive like
  `RE_URL`, `www.`/`mailto:`/`xmpp:` lowercase-only); `maskForEmphasis` skipped when
  the source has no backtick/`[`/`<`/`\` (mask is the identity then).
- `tryList`: first-char dispatch for the six continuation begin-tests; `indexOf`
  line split instead of `split`; tab-expand only when a tab is present; first
  non-space scan computed once and reused (drops `trim()` calls).
- `parse()`: skip the `\r\n|\r` → `\n` replace when the input has no `\r`.
- Bench progression (CPU trimmed mean): marked 943.6 ms → my prototype 1115.5 ms →
  936.9 → 891.7 → 831.5 → 810.5 → **818.2 ms** (final run; earlier runs 810–891 ms
  depending on VM load — the VM is shared, so ±5% run-to-run noise is normal).

## Known weaknesses / honest verdict

**Verdict: NOT-READY for the rank-1 bar, READY as a correct, faster-than-marked entry.**

- The planning target was local CPU trimmed mean ≤ 500 ms. This entry measures
  **818.2 ms** — about 20% faster than marked locally (1021.9 ms) but well above
  500 ms.
- Against the official bar: rank 1 is witty-quasar-25 at 2,860,000 µs CPU in the
  grader sandbox; the house baseline (marked itself) is ~4 s CPU there. My entry is
  ~20% faster than marked locally, so a naive sandbox scaling (~4x) puts it around
  ~3.3 s — **above the 2.86 s rank-1 bar**. It would need roughly another ~18%
  speedup (~670 ms local) to match rank 1. I could not reach that in this session:
  the profile is diffuse (no single hotspot — tryList ~11%, inlineParse ~11%,
  textEnd regex ~4%, GC ~3%, the rest spread across regex execs and allocations),
  and the remaining micro-optimizations each buy 1–7% while carrying correctness
  risk (one attempt — sticky left-delimiter regexes — was reverted after it broke
  103 cases, because `^` + sticky does not anchor at `lastIndex`).
- Correctness is the strong suit: 720/720 on the practice set, 0 mismatches across
  ~6,900 differential-fuzz documents (including 110k-char docs), grade-local 720/720
  with L1 regrade byte-identical, deterministic, and runnable as `nobody`.
- The scored set is drawn fresh (same 680 spec examples, 40 NEW documents), so the
  entry must be correct in general, not fitted to the practice docs — the fuzz
  coverage above is the evidence for that, not the practice score alone.
- **No submit was made, no fee paid, no wallet/keypair touched, nothing posted on X.**
  The repo is committed and pushed; submission (with Noe's explicit tap) is a
  separate step for the parent agent.
