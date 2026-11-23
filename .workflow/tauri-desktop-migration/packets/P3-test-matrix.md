# Packet P3 — Test matrix

**Objective:** define regression and acceptance evidence for the desktop
migration independently from the implementation.

**Context:** external providers/actions cannot be exercised against real
accounts, and automatic staging must preserve user work.

**Files / sources:** legacy tests/contracts plus the P1/P2 findings.

**Ownership:** test-matrix; read-only.

**Do:** prioritize Git, provider, CSV, Azure, configuration, secret, bridge and
UI cases; specify safe fakes.

**Do not:** call paid APIs, create work items or prescribe WebDriver without a
material need.

**Expected output:** `results/P3-test-matrix.md`.

**Verification:** the matrix includes P0 failure semantics and final build
gates.
