# Packet P4 — Implementation and integration

**Objective:** replace the CLI with one production implementation: a Rust
Tauri backend and React frontend.

**Context:** P1 contracts, P2 architecture and P3 risks are authoritative
inputs. User-facing text remains Brazilian Portuguese.

**Files / sources:** repository root, `src/`, `src-tauri/`, manifests, docs and
tests.

**Ownership:** root, with a disjoint frontend slice delegated to
behavior-audit and documentation to tauri-research.

**Do:** implement typed commands, safe Git staging, local provider adapters,
CSV/Azure, compatible config, React states and automated tests.

**Do not:** keep the old runtime in production, expose arbitrary commands to
the WebView, persist secrets or perform real external actions.

**Expected output:** integrated source plus `final-report.md`.

**Verification:** Rust/frontend gates, native bundle and desktop smoke.
