# Tauri desktop migration

## Goal

Transformar a CLI Bun/TypeScript em uma aplicação desktop Tauri 2, com backend
Rust e frontend React, preservando os fluxos de análise de Git, geração por
OpenAI/Codex, exportação CSV, persistência de configuração e criação opcional
de tarefas no Azure DevOps.

## Success Criteria

- O usuário escolhe um repositório e configura provedor, sprint, área,
  responsável, contrato e Azure DevOps pela interface.
- O backend Rust detecta arquivos alterados, prepara conteúdo/diffs, gera e
  normaliza tarefas, exporta o CSV e, quando solicitado, cria os work items.
- Arquivos só são adicionados ao stage depois de processados com sucesso.
- Erros por arquivo não cancelam os demais arquivos e aparecem na interface.
- Segredos não são persistidos pela aplicação; a chave OpenAI pode ser
  informada somente para a execução atual ou vir de `OPENAI_API_KEY`.
- Testes Rust e React cobrem os contratos principais.
- `cargo test`, testes do frontend, typecheck e build de produção passam.
- O bundle Tauri compila no ambiente local ou qualquer dependência externa
  ausente fica comprovada por uma verificação equivalente e documentada.

## Current Context

- Repositório limpo em `main`.
- Implementação atual: Bun/TypeScript, sem Tauri, React ou Rust.
- Contratos existentes estão em `src/` e `tests/`.

## Constraints

- Tauri 2, Rust no backend e React no frontend.
- Textos visíveis em português brasileiro.
- Preservar os cabeçalhos/valores do CSV e a normalização atual.
- Preferir APIs nativas e poucas dependências.
- Não executar criação real no Azure DevOps nem chamadas pagas em testes.

## Risks

- Diferenças entre o SDK Codex TypeScript e a CLI `codex exec`.
- Parsing robusto de caminhos Git e combinação de staged/unstaged.
- Credenciais e disponibilidade de CLIs externas (`git`, `codex`, `az`).
- Toolchain de empacotamento Tauri no macOS.

## Approval Required

O pedido do usuário autoriza a migração local e substituição da CLI. Não há
autorização para deploy, publicação, chamadas pagas ou criação real de work
items; essas ações serão somente simuladas nos testes.

## Work Packets

- P1: inventário do comportamento e contratos atuais (somente leitura).
- P2: pesquisa oficial da estrutura Tauri 2/React e requisitos de build.
- P3: matriz independente de testes e riscos de regressão.
- P4: implementação e integração (agente principal).
- P5: auditoria final independente após a integração.

## Integration Policy

O backend Rust é a fonte única da lógica de negócio. O frontend apenas coleta
entrada, invoca comandos Tauri e apresenta resultados. Resultados de pesquisa
serão aceitos somente quando compatíveis com os contratos existentes e fontes
oficiais.

## Verification

- Testes unitários Rust com executores/HTTP simulados.
- Testes React com DOM simulado e bridge Tauri mockada.
- Typecheck e build Vite.
- `cargo test`, `cargo fmt --check` e `cargo clippy`.
- `tauri build --no-bundle` como prova de integração desktop.
- Auditoria do status/diff final.

## Reusable Artifacts

O próprio plano e o relatório final em `.workflow/tauri-desktop-migration/`.
