# Final Report: Tauri desktop migration

## Outcome

O Commit IA Task foi convertido de uma CLI Bun/TypeScript em uma aplicação
desktop Tauri 2. O backend Rust é a única camada com acesso a Git, filesystem,
OpenAI, Codex CLI, Azure CLI, configuração e CSV. O frontend React/Vite coleta
as entradas, acompanha progresso e apresenta resultados completos ou parciais.

O bundle macOS `Commit IA Task.app` foi compilado sem assinatura, aberto em um
smoke test e permaneceu ativo até o encerramento intencional.

## Accepted Results

- P1: contratos reais da CLI anterior, inclusive SPF/UST, cabeçalhos, payloads
  Git, staging e tolerância a falhas por arquivo.
- P2: estrutura Tauri 2 oficial, frontend Vite na raiz, backend em
  `src-tauri/`, capabilities mínimas e plugins nativos acessados por comandos
  Rust estreitos.
- P3: matriz de regressão usada para priorizar testes de Git real, adapters
  falsos/locais, segredo, CSV, Azure parcial e UI.
- P4: implementação Rust/React integrada, configuração legada compatível,
  ícones nativos e documentação atualizada.
- P5: auditoria independente; foram corrigidos corrida de stage, escrita CSV
  por symlink/TOCTOU, Azure sem ID, avisos de configuração e proveniência do
  CSV revelado.

## Rejected Results

- Manter a CLI TypeScript como segunda implementação de produção.
- Expor shell ou filesystem arbitrário ao WebView.
- Executar chamadas pagas à OpenAI, gerar com uma conta Codex real ou criar
  work items reais durante a verificação.
- Conceder capabilities JavaScript dos plugins dialog/opener; o React usa
  wrappers Rust validados.

## Conflicts Resolved

- A documentação antiga divergia do código nos valores SPF/UST e nos campos
  enviados diretamente ao Azure; prevaleceram os contratos executáveis.
- A chave OpenAI pode vir do ambiente ou ser informada apenas para a execução
  atual. Essa decisão foi formalizada no plano; o valor não é persistido, não
  deriva `Debug` no DTO Rust e é apagado da UI assim que a execução começa.
- `reveal_generated_csv` não confia mais em repositório/caminho fornecidos em
  conjunto pelo React: aceita apenas caminhos canonicalizados registrados pelo
  backend na sessão atual.

## Verification Evidence

- Rust: `cargo fmt --check`, Clippy com `-D warnings` e 35 testes.
- React/bridge: 7 testes Vitest em 2 arquivos.
- Frontend: Biome, TypeScript e build Vite.
- Desktop: build release e bundle macOS via
  `tauri build --bundles app --ci --no-sign`.
- Smoke: executável release iniciou e permaneceu ativo.
- Segredos: sentinelas dos testes ausentes de `dist/` e do bundle.
- Adapters externos: OpenAI em HTTP loopback; Codex e Azure com executáveis
  falsos em Unix. Nenhum serviço externo real foi chamado.

## Remaining Risks

- O bundle local não está assinado nem notarizado; distribuição pública exige
  identidade de assinatura e pipeline de release.
- A geração real depende de credenciais/instalações externas válidas no
  ambiente do usuário. O transporte foi testado localmente, mas nenhuma conta
  real foi usada nesta entrega.
- A geração de IA por arquivo é serial. Isso preserva resultados e isolamento
  de falhas, mas pode ser mais lenta que a antiga execução paralela em
  repositórios com muitos arquivos.

## Reusable Follow-up

- Assinar/notarizar bundles e adicionar CI multiplataforma.
- Se o volume de arquivos justificar, introduzir concorrência limitada somente
  para chamadas de IA, mantendo o staging ordenado e os testes de corrida.
- Adicionar telemetria local opt-in para tempos por provider sem registrar
  diffs, prompts ou credenciais.
