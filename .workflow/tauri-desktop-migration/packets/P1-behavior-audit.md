# Packet P1 — Behavior audit

**Objective:** inventory the executable contracts of the Bun/TypeScript CLI
before replacing it.

**Context:** the migration must preserve Git payload selection, AI
normalization, CSV/Azure mappings, persistence, staging and partial failures.

**Files / sources:** legacy `src/`, `tests/`, `package.json` and project docs.

**Ownership:** behavior-audit; read-only.

**Do:** run the legacy tests, distinguish code contracts from stale docs and
record edge cases.

**Do not:** edit production files or invoke real providers/Azure.

**Expected output:** `results/P1-behavior-audit.md`.

**Verification:** every legacy module and public CLI option is mapped.
