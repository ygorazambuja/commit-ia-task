# Packet P5 — Independent final review

**Objective:** audit the integrated migration for functional, security and
test blockers before goal completion.

**Context:** review must be independent of implementation and may request
regressions for concrete findings.

**Files / sources:** final diff, P1–P4 artifacts, Rust/React tests and build
configuration.

**Ownership:** test-matrix; read-only review.

**Do:** run fmt, Clippy, Rust tests, frontend tests/typecheck/build/Biome and
Tauri build; inspect paths, secrets, partial failure and external adapters.

**Do not:** edit production/tests, call real services or accept green tests
without checking their coverage of high-risk effects.

**Expected output:** `results/P5-backend-review.md` followed by
`results/P5-backend-rereview.md` after fixes.

**Verification:** final report explicitly states whether any P0/P1 blocker
remains.
