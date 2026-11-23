#!/bin/bash
set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
	printf 'Uso: %s [diretório de instalação]\nPadrão: ~/Applications\n' "$0"
	exit 0
fi

fail() {
	printf 'Erro: %s\n' "$*" >&2
	exit 1
}

[[ $# -le 1 ]] || fail "Informe somente o diretório de instalação."
[[ "$(uname -s)" == "Darwin" ]] || fail "Este script requer macOS."
case "$(uname -m)" in
	arm64) target="aarch64-apple-darwin" ;;
	x86_64) target="x86_64-apple-darwin" ;;
	*) fail "Arquitetura macOS não suportada." ;;
esac

for tool in bun cargo xcode-select ditto; do
	command -v "$tool" >/dev/null || fail "Instale o pré-requisito: $tool."
done
xcode-select -p >/dev/null 2>&1 || fail "Instale as ferramentas com xcode-select --install."

repository_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
build_dir="$repository_dir/src-tauri/target"
app_name="Infortech Automation.app"
install_dir="${1:-"$HOME/Applications"}"
mkdir -p "$install_dir"
install_dir="$(cd "$install_dir" && pwd -P)"
[[ -w "$install_dir" ]] || fail "Sem permissão de escrita em $install_dir."
for directory in "$build_dir/debug" "$build_dir/release" "$build_dir/$target/debug" "$build_dir/$target/release"; do
	case "$install_dir/" in
		"$directory/"*) fail "O destino está dentro de um diretório de build que será removido." ;;
	esac
done
installed_app="$install_dir/$app_name"
[[ ! -L "$installed_app" ]] || fail "O destino não pode ser um link simbólico."
[[ ! -e "$installed_app" || -d "$installed_app" ]] || fail "O destino existente não é um diretório de aplicativo."

cd "$repository_dir"
printf 'Instalando dependências e compilando para %s…\n' "$target"
bun install --frozen-lockfile
# ponytail: evita dylibs desalinhadas no macOS 27; remover após atualizar para Rust com a correção de #157750.
# https://github.com/rust-lang/rust/issues/157750
CARGO_TARGET_DIR="$build_dir" CARGO_PROFILE_RELEASE_STRIP=none \
	bun run tauri:build --ci --bundles app --target "$target" -- --locked
built_app="$build_dir/$target/release/bundle/macos/$app_name"
[[ -d "$built_app/Contents" ]] || fail "O build não gerou $built_app."

# ponytail: cópia temporária no mesmo volume permite restaurar a versão anterior.
temporary_dir="$(mktemp -d "$install_dir/.infortech-install.XXXXXX")"
cleanup() {
	if [[ -d "$temporary_dir/previous.app" && ! -e "$installed_app" ]]; then
		mv "$temporary_dir/previous.app" "$installed_app" || {
			printf 'Erro: restaure a versão anterior de %s.\n' "$temporary_dir/previous.app" >&2
			return 1
		}
	fi
	rm -rf "$temporary_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf 'Instalando em %s…\n' "$installed_app"
ditto "$built_app" "$temporary_dir/$app_name"
if [[ -d "$installed_app" ]]; then
	mv "$installed_app" "$temporary_dir/previous.app"
fi
mv "$temporary_dir/$app_name" "$installed_app"

printf 'Removendo os builds de debug e release…\n'
rm -rf "$build_dir/debug" "$build_dir/release" \
	"$build_dir/$target/debug" "$build_dir/$target/release"
printf 'Instalação concluída: %s\n' "$installed_app"
