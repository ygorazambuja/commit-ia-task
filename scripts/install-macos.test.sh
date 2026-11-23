#!/bin/bash
set -euo pipefail

# Executa o instalador em um projeto temporário, sem compilar ou instalar no Mac.
fixture_dir="$(mktemp -d)"
trap 'rm -rf "$fixture_dir"' EXIT
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repository_dir="$fixture_dir/projeto com espaços"
mkdir -p "$repository_dir/scripts" "$fixture_dir/bin"
cp "$script_dir/install-macos.sh" "$repository_dir/scripts/"
export TEST_INSTALL_DIR="$fixture_dir/Aplicativos locais"
export PATH="$fixture_dir/bin:$PATH"

cat > "$fixture_dir/bin/uname" <<'SH'
#!/bin/bash
if [[ "$1" == "-s" ]]; then
	printf '%s\n' "${TEST_PLATFORM:-Darwin}"
else
	printf 'arm64\n'
fi
SH
cat > "$fixture_dir/bin/bun" <<'SH'
#!/bin/bash
set -eu
if [[ "$*" == "install --frozen-lockfile" ]]; then
	exit 0
fi
[[ "$*" == "run tauri:build --ci --bundles app --target aarch64-apple-darwin -- --locked" ]]
[[ "${CARGO_PROFILE_RELEASE_STRIP:-}" == "none" ]] || {
	printf "error[E0463]: can't find crate for thiserror_impl\n" >&2
	exit 1
}
mkdir -p "$CARGO_TARGET_DIR/aarch64-apple-darwin/release/bundle/macos/Infortech Automation.app/Contents"
printf 'nova\n' > "$CARGO_TARGET_DIR/aarch64-apple-darwin/release/bundle/macos/Infortech Automation.app/Contents/version"
[[ "${TEST_FAILURE:-}" != "build" ]]
SH
cat > "$fixture_dir/bin/ditto" <<'SH'
#!/bin/bash
[[ "${TEST_FAILURE:-}" != "copy" ]] || exit 1
cp -R "$1" "$2"
SH
cat > "$fixture_dir/bin/mv" <<'SH'
#!/bin/bash
if [[ "${TEST_FAILURE:-}" == "install" && "$1" == *"/.infortech-install."*"/Infortech Automation.app" ]]; then
	exit 1
fi
/bin/mv "$@"
SH
for tool in cargo xcode-select; do
	printf '#!/bin/bash\nexit 0\n' > "$fixture_dir/bin/$tool"
done
chmod +x "$fixture_dir/bin/"*

for failure in build copy install success; do
	export TEST_FAILURE="$failure"
	build_dir="$repository_dir/src-tauri/target"
	installed_app="$TEST_INSTALL_DIR/Infortech Automation.app"
	rm -rf "$build_dir" "$TEST_INSTALL_DIR"
	mkdir -p "$installed_app/Contents"
	printf 'anterior\n' > "$installed_app/Contents/version"
	printf 'obsoleto\n' > "$installed_app/Contents/stale"
	for directory in debug release aarch64-apple-darwin/debug aarch64-apple-darwin/release; do
		mkdir -p "$build_dir/$directory"
		printf 'artefato\n' > "$build_dir/$directory/artifact"
	done
	if bash "$repository_dir/scripts/install-macos.sh" "$TEST_INSTALL_DIR" > "$fixture_dir/output" 2>&1; then
		[[ "$failure" == "success" ]] || { cat "$fixture_dir/output"; exit 1; }
		[[ "$(cat "$installed_app/Contents/version")" == "nova" ]]
		[[ ! -e "$installed_app/Contents/stale" ]]
		for directory in debug release aarch64-apple-darwin/debug aarch64-apple-darwin/release; do
			[[ ! -e "$build_dir/$directory" ]]
		done
	else
		[[ "$failure" != "success" ]] || { cat "$fixture_dir/output"; exit 1; }
		[[ "$(cat "$installed_app/Contents/version")" == "anterior" ]]
		for directory in debug release aarch64-apple-darwin/debug aarch64-apple-darwin/release; do
			[[ -f "$build_dir/$directory/artifact" ]]
		done
	fi
	for leftover in "$TEST_INSTALL_DIR"/.infortech-install.*; do
		[[ ! -e "$leftover" ]]
	done
	printf 'OK: %s\n' "$failure"
done

if TEST_PLATFORM=Linux bash "$repository_dir/scripts/install-macos.sh" "$TEST_INSTALL_DIR" > "$fixture_dir/output" 2>&1; then
	exit 1
fi
printf 'OK: rejeita outros sistemas\n'

if bash "$repository_dir/scripts/install-macos.sh" "$build_dir/release/apps" > "$fixture_dir/output" 2>&1; then
	exit 1
fi
[[ "$(cat "$installed_app/Contents/version")" == "nova" ]]
printf 'OK: rejeita instalação nas pastas que serão removidas\n'
