# Packet P2 — Tauri research

**Objective:** define the smallest official Tauri 2 + React/Vite architecture
that keeps privileged access in Rust.

**Context:** the desktop app needs a native picker, Git/process/filesystem
access, progress events and a safe way to reveal the generated CSV.

**Files / sources:** official Tauri/Vite/Cargo sources and a temporary
scaffold; repository files remain read-only.

**Ownership:** tauri-research.

**Do:** confirm versions, project layout, capabilities, plugin boundaries,
macOS PATH handling and build commands.

**Do not:** expose shell/filesystem capabilities to React or overwrite the
repository with a scaffold.

**Expected output:** `results/P2-tauri-research.md`.

**Verification:** recommendations cite official sources and compile in the
available toolchain.
