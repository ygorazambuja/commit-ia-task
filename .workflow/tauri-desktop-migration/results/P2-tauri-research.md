# P2 — Pesquisa oficial Tauri 2 + React/Vite

## Conclusão executável

A migração deve manter o frontend React/Vite na raiz e criar um projeto Cargo
em `src-tauri/`. Toda lógica privilegiada — Git, filesystem, configuração,
OpenAI, execução de `codex`/`az`, CSV e staging — deve ficar em comandos/serviços
Rust. O React deve importar apenas a bridge Tauri e renderizar estado.

Para seleção nativa de repositório e abertura/revelação do CSV, a superfície
mínima é:

- Rust: `tauri-plugin-dialog` e `tauri-plugin-opener`;
- frontend: `@tauri-apps/api`;
- sem `tauri-plugin-shell` e sem `tauri-plugin-fs` expostos ao WebView.

Recomendação para este projeto: chamar os dois plugins **por comandos Rust**,
validar os paths no backend e não instalar os bindings JavaScript dos plugins.
Isso evita conceder ao React `open_path` arbitrário e mantém a regra do plano de
que o backend Rust é a fonte única dos efeitos no sistema.

## Estrutura atual recomendada

A estrutura oficial do Tauri separa o projeto web do projeto Rust. O scaffold
`create-tauri-app 4.6.2` com `react-ts`, Bun e Tauri 2 gerou:

```text
.
├── package.json
├── bun.lock
├── index.html
├── vite.config.ts
├── tsconfig.json
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   └── ...
└── src-tauri/
    ├── Cargo.toml
    ├── Cargo.lock
    ├── build.rs
    ├── tauri.conf.json
    ├── capabilities/
    │   └── default.json
    ├── icons/
    └── src/
        ├── main.rs
        └── lib.rs
```

No projeto real, manter `src-tauri/src/main.rs` como entrada mínima e colocar a
aplicação em `lib.rs` e módulos de domínio/adapters. A documentação do Tauri
recomenda editar `lib.rs`, pois `main.rs` só chama a biblioteca também usada
pelos targets mobile. Fonte: [Project Structure][tauri-project-structure].

Configuração Vite/Tauri necessária:

```json
{
  "build": {
    "beforeDevCommand": "bun run dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "bun run build",
    "frontendDist": "../dist"
  }
}
```

```ts
// vite.config.ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
```

O port pode ser `1420` ou outro fixo; o requisito é ser igual ao `devUrl`,
usar `strictPort` e ignorar `src-tauri` no watcher. Fontes:
[Tauri + Vite][tauri-vite] e [Create a Project][tauri-create-project].

Não executar `create-tauri-app --force` sobre a raiz existente: ele pode
substituir arquivos da CLI. Para uma migração in-place, usar o scaffold apenas
em diretório temporário como referência ou inicializar `src-tauri` com
`bun tauri init` depois de preparar o frontend.

## Snapshot de versões em 2026-07-27

Versões consultadas nos registries oficiais com `npm view`, `cargo search` e
`cargo info`; as versões Cargo abaixo são as resolvidas por `version = "2"`.

| Componente | Versão atual observada |
|---|---:|
| `create-tauri-app` | `4.6.2` |
| `@tauri-apps/cli` | `2.11.4` |
| `@tauri-apps/api` | `2.11.1` |
| crate `tauri` | `2.11.5` |
| crate `tauri-build` | `2.6.3` |
| plugin dialog Rust/JS | `2.7.2` |
| plugin opener Rust/JS | `2.5.4` |
| Vite | `8.1.5` |
| `@vitejs/plugin-react` | `6.0.4` |
| React / React DOM | `19.2.8` |
| Vitest | `4.1.10` |

O Tauri e os plugins exigem Rust `>=1.77.2`; o ambiente local usa `1.95.0`.
Links dos artefatos:

- [`tauri 2.11.5`][crate-tauri] e
  [`tauri-build 2.6.3`][crate-tauri-build];
- [`tauri-plugin-dialog 2.7.2`][crate-dialog] e
  [`tauri-plugin-opener 2.5.4`][crate-opener];
- [`@tauri-apps/cli`][npm-tauri-cli],
  [`@tauri-apps/api`][npm-tauri-api], [`vite`][npm-vite].

Detalhe importante: o scaffold atual declara `vite = "^7.0.4"` e
`@vitejs/plugin-react = "^4.6.0"`, resolvendo localmente Vite `7.3.6` e plugin
React `4.7.0`. O Vite informa que `8.1` é a linha com patches regulares e `7.3`
recebe apenas correções importantes/de segurança. A atualização explícita para
Vite `8.1.5` + plugin React `6.0.4` compilou com sucesso neste ambiente.
Fonte: [política oficial de releases do Vite][vite-releases].

Usar ranges major compatíveis nos manifests Tauri (`"2"`) e **versionar
`bun.lock` e `src-tauri/Cargo.lock`**. O primeiro `cargo test --locked` do
scaffold falhou corretamente porque ainda não havia `Cargo.lock`; depois de
gerar e versionar o lock, passou. Em CI, instalar/testar com
`bun install --frozen-lockfile` e `cargo ... --locked`.

## Dependências mínimas

### Frontend

```json
{
  "dependencies": {
    "@tauri-apps/api": "2.11.1",
    "react": "19.2.8",
    "react-dom": "19.2.8"
  },
  "devDependencies": {
    "@tauri-apps/cli": "2.11.4",
    "@vitejs/plugin-react": "6.0.4",
    "vite": "8.1.5",
    "vitest": "4.1.10"
  }
}
```

Manter também TypeScript e os tipos React. Adicionar um ambiente DOM de testes
somente se os testes de componentes o exigirem. Não é necessário adicionar
bindings `@tauri-apps/plugin-dialog` ou `@tauri-apps/plugin-opener` quando os
plugins são chamados por wrappers Rust.

### Rust

```toml
[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-dialog = "2"
tauri-plugin-opener = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

As dependências de domínio/HTTP/CSV entram separadamente conforme a
implementação. Para acesso nativo feito em Rust:

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .invoke_handler(tauri::generate_handler![
        choose_repository,
        reveal_generated_csv,
    ]);
```

O picker Rust oferece `blocking_pick_folder()` e `pick_folder()`; o primeiro
não deve rodar na main thread. A documentação mostra seu uso dentro de comando
`async`. Fonte: [`FileDialogBuilder`][rust-dialog-builder].

O opener Rust oferece `open_path()` e `reveal_item_in_dir()`. Para este produto,
preferir um comando estreito como `reveal_generated_csv`, que usa no backend o
path realmente retornado pela geração. Não aceitar um path arbitrário do
frontend sem canonicalizar e conferir que ele é um artefato válido.
Fonte: [`Opener`][rust-opener].

### O que não adicionar

- `tauri-plugin-shell`: os processos `git`, `codex` e `az` são filhos iniciados
  pelo Rust; não devem ser executáveis pelo JavaScript.
- `tauri-plugin-fs`: `std::fs`/APIs Rust cobrem a lógica interna; o WebView não
  precisa de leitura/escrita global.
- WebDriver no gate inicial: Rust + testes de bridge/componentes cobrem os
  contratos; picker e Finder ficam em um smoke desktop. O Tauri oferece
  WebDriverIO no macOS, mas ele adiciona plugin e infraestrutura desnecessários
  para esta primeira entrega.

## Capabilities e permissões

Capabilities controlam apenas a exposição ao frontend. Chamadas feitas pelo
próprio Rust não precisam de permissões dos plugins. Para o desenho recomendado:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Permissões da janela principal",
  "windows": ["main"],
  "permissions": ["core:default"]
}
```

Comandos registrados por `invoke_handler` são permitidos a todas as
janelas/webviews da aplicação por padrão. Como haverá uma única janela local,
os comandos devem ser estreitos e validar toda entrada. Se surgirem novas
janelas ou conteúdo remoto, declarar um `AppManifest::commands` e permissões
próprias antes de ampliar a superfície. Fonte:
[Capabilities, especialmente comandos da aplicação][tauri-capabilities].

Alternativa, caso o React chame os plugins diretamente:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "dialog:allow-open",
    "opener:allow-reveal-item-in-dir"
  ]
}
```

Uso React correspondente:

```ts
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

const repository = await open({ directory: true, multiple: false });
await revealItemInDir(csvPath);
```

`bun tauri add dialog` funciona, mas adicionou automaticamente
`dialog:default`, que habilita open, save e message. Trocar por
`dialog:allow-open` se somente o picker for usado.

`opener:default` **não** permite `openPath`; ele permite URLs padrão e revelar
itens no explorador. `openPath` exige `opener:allow-open-path`; a forma com
scope usa globs, por exemplo:

```json
{
  "identifier": "opener:allow-open-path",
  "allow": [{ "path": "$HOME/**" }]
}
```

Como o usuário pode escolher repositórios fora de `$HOME`, liberar
`allow-open-path` sem scope seria amplo demais. Esse é o motivo para preferir o
wrapper Rust validado. Fontes: [Dialog e permissões][tauri-dialog],
[Opener e scopes][tauri-opener] e [Permissions][tauri-permissions].

Não configurar capabilities remotas. O conteúdo deve ser exclusivamente o
bundle local.

## Testes recomendados

O backend deve manter a regra de negócio fora das funções `#[tauri::command]`;
assim `cargo test` cobre domínio, Git, providers, CSV, configuração e Azure sem
abrir WebView.

Para o frontend, Vitest deve testar a bridge única e os componentes. O módulo
`@tauri-apps/api/mocks` oferece `mockIPC()` e `clearMocks()`; limpar mocks após
cada teste é obrigatório para evitar estado vazando entre casos. Fonte:
[Mock Tauri APIs][tauri-mocking].

Scripts mínimos:

```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "tauri": "tauri"
  }
}
```

Gate local/CI a partir da raiz:

```bash
bun install --frozen-lockfile
bun run test
bun run typecheck
bun run build

cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked

bun run tauri build --no-bundle --ci --no-sign
```

`cargo test` compila e executa testes unitários, de integração e doctests.
Fonte: [Cargo test][cargo-test].

Smoke de bundle nativo macOS:

```bash
bun run tauri build --bundles app --ci --no-sign
```

`--no-sign` serve somente para validação local. Distribuição exige assinatura e
notarização adequadas. Fonte:
[macOS Application Bundle][tauri-macos-bundle].

Para desenvolvimento:

```bash
bun run tauri dev
```

## Evidência do ambiente macOS

Toolchain inspecionado:

```text
macOS 26.5.2 (25F84), arm64
Xcode 26.6 em /Applications/Xcode.app/Contents/Developer
Apple clang 21.0.0
rustc 1.95.0
cargo 1.95.0
stable-aarch64-apple-darwin
Bun 1.3.14
Node 22.22.3
```

Isso excede os requisitos oficiais: macOS Catalina 10.15+ e Xcode ou Command
Line Tools, além de Rust. Fonte: [Prerequisites][tauri-prerequisites].

Validações executadas em scaffold temporário, sem alterar a produção:

| Verificação | Resultado |
|---|---|
| `bun install` | passou |
| `bun install --frozen-lockfile` | passou |
| React/Vite scaffold `bun run build` | passou |
| upgrade Vite `8.1.5` + React plugin `6.0.4` | passou |
| `cargo check --locked` | passou |
| `cargo test --locked` | passou; scaffold tinha 0 testes |
| `tauri build --no-bundle --ci --no-sign` com Vite 8 | passou |
| `tauri build --bundles app --ci --no-sign` | passou; gerou `app.app` |

O bundle usou `tauri 2.11.5`, `tauri-build 2.6.3`,
`tauri-plugin-dialog 2.7.2` e `tauri-plugin-opener 2.5.4`.

## Risco macOS que bloqueia “funciona pelo Finder”

Aplicações GUI no macOS não herdam o `$PATH` configurado em `.zshrc`,
`.bash_profile` etc. Logo, um app que funciona com `tauri dev` pode não achar
`git`, `codex` ou `az` quando aberto pelo Finder. A documentação do Tauri chama
isso explicitamente e aponta o crate oficial `fix-path-env-rs`.
Fontes: [macOS Application Bundle][tauri-macos-bundle] e
[`fix-path-env-rs`][fix-path-env].

Decisão recomendada:

1. no startup Rust, normalizar o PATH antes de procurar executáveis;
2. validar separadamente `git`, `codex` e `az` e retornar erro em português;
3. não usar `tauri-plugin-shell` como atalho;
4. testar o `.app` aberto pelo Finder, não só `tauri dev`.

O `fix-path-env-rs` atualmente é uma dependência Git, não um crate publicado no
registry; se adotado, fixar um commit/tag no `Cargo.toml`. Ele corrige `PATH`,
mas não torna `OPENAI_API_KEY` definida apenas em uma sessão de terminal
disponível ao Finder. A aplicação precisa documentar como disponibilizar essa
variável ao processo GUI ou aceitar a chave somente em memória, sem persistir.

## Fontes oficiais

- [Tauri — Create a Project][tauri-create-project]
- [Tauri — Project Structure][tauri-project-structure]
- [Tauri — Vite][tauri-vite]
- [Tauri — Calling Rust from the Frontend][tauri-calling-rust]
- [Tauri — Capabilities][tauri-capabilities]
- [Tauri — Permissions][tauri-permissions]
- [Tauri — Dialog][tauri-dialog]
- [Tauri — Opener][tauri-opener]
- [Tauri — Mock Tauri APIs][tauri-mocking]
- [Tauri — macOS Application Bundle][tauri-macos-bundle]
- [Tauri — Prerequisites][tauri-prerequisites]
- [Vite — Releases][vite-releases]
- [Vite — Getting Started][vite-guide]
- [Rust Cargo — `cargo test`][cargo-test]

[tauri-create-project]: https://v2.tauri.app/start/create-project/
[tauri-project-structure]: https://v2.tauri.app/start/project-structure/
[tauri-vite]: https://v2.tauri.app/start/frontend/vite/
[tauri-calling-rust]: https://v2.tauri.app/develop/calling-rust/
[tauri-capabilities]: https://v2.tauri.app/security/capabilities/
[tauri-permissions]: https://v2.tauri.app/security/permissions/
[tauri-dialog]: https://v2.tauri.app/plugin/dialog/
[tauri-opener]: https://v2.tauri.app/plugin/opener/
[tauri-mocking]: https://v2.tauri.app/develop/tests/mocking/
[tauri-macos-bundle]: https://v2.tauri.app/distribute/macos-application-bundle/
[tauri-prerequisites]: https://v2.tauri.app/start/prerequisites/
[rust-dialog-builder]: https://docs.rs/tauri-plugin-dialog/2.7.2/tauri_plugin_dialog/struct.FileDialogBuilder.html
[rust-opener]: https://docs.rs/tauri-plugin-opener/2.5.4/tauri_plugin_opener/struct.Opener.html
[crate-tauri]: https://crates.io/crates/tauri/2.11.5
[crate-tauri-build]: https://crates.io/crates/tauri-build/2.6.3
[crate-dialog]: https://crates.io/crates/tauri-plugin-dialog/2.7.2
[crate-opener]: https://crates.io/crates/tauri-plugin-opener/2.5.4
[npm-tauri-cli]: https://www.npmjs.com/package/@tauri-apps/cli
[npm-tauri-api]: https://www.npmjs.com/package/@tauri-apps/api
[npm-vite]: https://www.npmjs.com/package/vite
[vite-releases]: https://vite.dev/releases
[vite-guide]: https://vite.dev/guide/
[cargo-test]: https://doc.rust-lang.org/cargo/commands/cargo-test.html
[fix-path-env]: https://github.com/tauri-apps/fix-path-env-rs
