# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/jihoonbaee/hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/jihoonbaee/hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit an AI model wrote, in one of four formats, to a tree of
text files: a unified diff (often with wrong line numbers), SEARCH/REPLACE
blocks, the V4A patch format, and text-editor tool calls as JSON. It finds the
lines each edit names at the first of three matching tiers — exact, trailing
whitespace, then leading and trailing whitespace — and writes every change or
none. `SPEC.md` is the whole contract.

## Run

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree; every path in a patch is
  relative to it.
- `PATCH` is the patch file; when absent or `-`, the patch is read from
  standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`,
  `json`; `auto` (the default) detects it.
- `--check` does everything but write, with the same output and exit code.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 prints one line per changed path (`A`/`D`/`M`, or `R old -> new` for a
move) and `ok: <n> files`. Exit 1 prints one `error: <code> <path>` line per
failed edit and `failed: <k> of <n> edits`, and writes nothing. Exit 2 prints
one line for a usage, no-patch, format or parse error.

## Files

- `main.ts`: the CLI, Node 22 and its standard library alone.
- `runner.ts`: the kit's runner, kept as it is; in a trial it reads the checks
  from the env and runs `main.ts` on each one.
- `check.ts`: run the 100 public practice checks on your own machine:

      node check.ts ../program/generator/practice.json

  (from the kit directory; it prints every check that does not match, then the
  practice score).
- `SPEC.md`: the specification. `LICENSE`: MIT.

## Grade locally

    node cli/makefun.mjs grade-local --kit <kit> --bot <repository> --driver docker
