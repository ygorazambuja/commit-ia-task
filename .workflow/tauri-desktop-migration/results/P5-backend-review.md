# P5 — Revisão independente do backend Rust/Tauri

## Resultado dos gates

Estado revisado após as correções concorrentes do agente principal:

```text
cargo fmt --manifest-path src-tauri/Cargo.toml --check          PASS
cargo clippy --manifest-path src-tauri/Cargo.toml \
  --all-targets -- -D warnings                                 PASS
cargo test --manifest-path src-tauri/Cargo.toml                PASS (25/25)
```

A revisão não executou OpenAI, Codex ou Azure reais e não alterou arquivos de
produção/teste.

## Achados acionáveis

### [P1] A chave OpenAI atravessa o WebView, contrariando o goal e P1/P3

- Arquivos/linhas:
  - `src-tauri/src/models.rs:59-70`
  - `src-tauri/src/commands.rs:131-137`
  - `src-tauri/src/ai.rs:112-122`
- Evidência: `GenerationInput` aceita `apiKey`, o React a envia por IPC e o
  backend prioriza esse valor sobre `OPENAI_API_KEY`.
- Impacto: o critério aprovado diz que a chave vem do ambiente, e P1/P3
  explicitam que o React não lê segredo. A implementação não persiste a chave,
  mas mudou silenciosamente a fronteira de confiança e ainda deriva `Debug`
  para o DTO que a contém.
- Correção: remover `api_key` do DTO/comando e ler somente
  `OPENAI_API_KEY`; alternativamente, se a chave em memória for uma decisão
  deliberada para contornar o ambiente do Finder, atualizar formalmente
  goal/P1/P3 antes de aceitar a mudança e adicionar teste de redaction/ausência
  em config, eventos, erros e bundle.

### [P1] Resposta Azure sem `id` é tratada como sucesso

- Arquivo/linha: `src-tauri/src/export.rs:192-215`.
- Evidência: JSON válido como `{}` entra em `Ok(item)`, não adiciona ID e o
  loop continua; ao final retorna `(ids, None)`.
- Impacto: a UI pode declarar conclusão sem saber se o work item foi criado.
  Isso é especialmente perigoso porque repetir a operação pode duplicar uma
  ação externa irreversível.
- Correção: tratar `id: None` como resposta inválida, parar no item atual e
  retornar `ids` já criados mais `azure_error` com o título que falhou.
  Cobrir sucesso → ausência de ID → terceiro item não chamado.

### [P1] A suíte não prova os adapters externos nem a orquestração

- Arquivos/linhas:
  - `src-tauri/src/ai.rs:112-145,215-257`
  - `src-tauri/src/export.rs:170-215`
  - `src-tauri/src/commands.rs:92-195`
  - `src-tauri/src/process.rs:7-57`
- Evidência: URL OpenAI e `run_process` são hardcoded; os testes exercitam
  builders/parsers, mas nenhum teste executa `run_generation`, um HTTP local
  falso, Codex falso ou Azure falso. Logo não há prova automatizada de
  Authorization, status HTTP, exit code, IDs parciais, falha por arquivo ou da
  ordem `stage → CSV → Azure`.
- Impacto: 25 testes verdes ainda permitem que todos os transportes falhem em
  produção. Isso não atende “tudo funcionando e com testes” nem R-AI-02,
  R-AZ-02 e R-PIPE-01 do P3.
- Correção mínima: injetar um runner de processos e endpoint/cliente HTTP no
  serviço de domínio; manter os comandos Tauri finos. Adicionar um teste de
  pipeline com repo Git real e providers/Azure falsos, sem rede.

### [P2] Erros de configuração são descartados sem warning observável

- Arquivos/linhas:
  - `src-tauri/src/commands.rs:17-21`
  - `src-tauri/src/commands.rs:104-107`
- Evidência: erro de leitura vira default via `unwrap_or(None)` e erro de
  gravação é descartado com `let _ =`.
- Impacto: JSON corrompido apaga os valores visíveis na inicialização; falta de
  permissão aparenta salvar a configuração, mas ela some no próximo start.
  A CLI anterior ao menos emitia warning e P3 exige fallback com warning.
- Correção: manter o fluxo tolerante, mas transportar `configWarning` no
  estado/resultado ou emitir evento seguro em português.

### [P2] `reveal_generated_csv` valida formato, não proveniência

- Arquivo/linha: `src-tauri/src/commands.rs:63-90`.
- Evidência: o caller controla simultaneamente `repositoryPath` e `csvPath`;
  qualquer arquivo existente `tasks-*.csv` dentro do diretório informado passa
  como “gerado”.
- Impacto: a bridge é mais ampla que o wrapper estreito definido em P2. A
  operação atual apenas revela no Finder, portanto o impacto é limitado, mas a
  garantia expressa pela mensagem de erro não é verdadeira.
- Correção: guardar no estado Rust o último path realmente retornado por
  `write_csv` (ou um conjunto pequeno da sessão) e aceitar apenas esse path.
  Não confiar em um segundo path fornecido pelo React.

### [P2] Geração por arquivo deixou de ser paralela

- Arquivo/linha: `src-tauri/src/commands.rs:109-158`.
- Evidência: o `for` aguarda `ai::generate_tasks` antes de iniciar o próximo
  arquivo. A CLI original iniciava todos e colhia com `allSettled`.
- Impacto: com timeout de 180 s por chamada, N arquivos podem levar N vezes o
  tempo anterior. É uma regressão observável de paridade, embora não altere o
  conteúdo final.
- Correção: usar concorrência limitada e preservar a ordem de descoberta,
  erros por arquivo e staging seguro. Se a serialização for intencional,
  documentar a mudança em vez de tratá-la como paridade.

### [P2] Pré-requisitos do provider dependem apenas da UI

- Arquivos/linhas:
  - `src-tauri/src/ai.rs:117-122`
  - `src-tauri/src/commands.rs:92-101,198-210`
- Evidência:
  - `OPENAI_API_KEY="   "` é marcado como ausente no estado inicial, mas o
    adapter aceita a string do ambiente sem trim/filtro final e tenta HTTP;
  - `run_generation` não valida Codex/OpenAI uma vez no backend. Codex ausente
    é tentado novamente para cada arquivo.
- Impacto: IPC direto, estado obsoleto ou UI futura produz várias falhas tardias
  em vez de um erro acionável antes dos efeitos do fluxo.
- Correção: validar o provider no comando/serviço antes de salvar config ou
  analisar arquivos; aplicar trim + `filter(!is_empty)` também ao valor vindo
  do ambiente.

## Pontos verificados sem achado

- **Git status/rename/deletion:** parser NUL e ordem do par de rename estão
  coerentes; deleção usa diff e `git add -- path`. Ainda falta teste Git real
  para rename/deletion — hoje rename é apenas string sintética.
- **Stage race:** `stage_if_unchanged` agora reinspeciona status/flags e payload
  antes do add; há regressão para staged-only que ganha conteúdo unstaged.
- **Symlinks de entrada:** conteúdo completo canonicaliza e rejeita target fora
  do repo; há teste Unix.
- **CSV:** 16 headers, SPF `17/19/22`, UST `8/24/40/8`, estimates e sanitização
  estão corretos. A criação usa `create_new`; symlink quebrado previsível não
  consegue escrever fora do repo e há regressão dedicada.
- **Responses API:** `text.format = json_schema`, `strict`, `schema`, `store:
  false`, `instructions` e o parsing de `output_text`/`refusal` correspondem à
  [documentação oficial de Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
  e ao OpenAPI atual de `POST /v1/responses`.
- **Codex:** argumentos conferem com `codex-cli 0.145.0`: `exec`,
  `--ephemeral`, sandbox read-only, approval never, output schema, cwd, model
  opcional e prompt por stdin; há teste do vetor.
- **Azure:** argumentos são vetorizados, sem shell; org/projeto são opcionais;
  erros de processo/JSON preservam IDs anteriores. O caso sem ID é o achado
  acima.
- **Config legado:** `config_dir()/commit-ia-task/config.json` e
  `COMMIT_IA_TASK_CONFIG_DIR/config.json` preservam o path anterior; defaults
  Serde carregam JSON legado.
- **Picker:** pasta escolhida é resolvida para o top-level Git e
  canonicalizada.
- **macOS PATH:** `fix-path-env` está pinado e executado antes do builder. O
  retorno é ignorado; uma falha só aparece indiretamente como CLI indisponível,
  mas Git/Codex retornam mensagens acionáveis na execução.
- **Tauri security:** capability contém apenas `core:default`, CSP é local e
  não há plugin shell/fs exposto ao WebView.

## Lacunas de teste remanescentes do P3

Além do adapter/pipeline apontado como P1:

- não há repo real para staged rename, deletion, path iniciado por `-` ou
  preservação do index em sucesso parcial;
- o teste CSV usa `contains`, não fixa os 16 headers/quoting como golden
  parseável;
- não há teste de config corrompida/save failure chegando à UI;
- não há teste de segredo sentinela em erros/bundle;
- não há teste backend contra duas execuções simultâneas, relevante se Azure
  estiver habilitado.

Essas lacunas não invalidam os 25 testes existentes, mas impedem afirmar que
toda a matriz P3 foi cumprida.
