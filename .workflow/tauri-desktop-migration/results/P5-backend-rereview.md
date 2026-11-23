# P5 — Rerevisão final do backend e da integração Tauri

## Parecer

**Nenhum blocker P0/P1 restante para o goal.**

As correções posteriores à primeira revisão fecharam os achados bloqueantes:

- resposta Azure sem `id` interrompe a criação, preserva IDs anteriores e não
  chama o item seguinte; o comportamento passa por um executável `az` falso;
- os adapters OpenAI, Codex e Azure são executados em testes sem rede, conta ou
  ação externa real;
- o núcleo do pipeline usa um repositório Git real para provar sucesso parcial,
  staging somente dos sucessos e preservação exata do index do arquivo falho;
- provider e credencial OpenAI em branco são rejeitados no backend antes dos
  efeitos do fluxo;
- erros de leitura/gravação da configuração chegam ao React como avisos;
- o reveal aceita somente CSV registrado pelo Rust na sessão atual;
- a chave OpenAI não é persistida e seu DTO não implementa `Debug`;
- Git cobre deleção, rename real, espaços/acentos e path iniciado por `-`;
- o CSV possui regressão parseável para os 16 headers, quoting e estimates;
- React e a bridge Tauri têm sete testes, incluindo submissão duplicada,
  bloqueio dos campos durante a geração, resultado parcial, warnings e nomes
  exatos dos comandos/argumentos IPC.

Não há um teste que instancie diretamente o `AppHandle` para chamar
`run_generation`, mas isso não permanece bloqueante: o comando agora é uma
composição linear, o núcleo foi extraído e testado, e todas as bordas com
efeitos (Git, HTTP OpenAI, processo Codex, CSV e processo Azure) são executadas
contra repositórios/servidores/executáveis falsos.

## Gates no snapshot final

```text
cargo fmt --manifest-path src-tauri/Cargo.toml --check             PASS
cargo clippy --manifest-path src-tauri/Cargo.toml \
  --all-targets --locked -- -D warnings                            PASS
cargo test --manifest-path src-tauri/Cargo.toml --locked           PASS (35)
bun run test                                                       PASS (7)
bun run typecheck                                                  PASS
bun run build                                                      PASS
bun run check                                                      PASS
git diff --check                                                   PASS
bun run tauri build --no-bundle                                   PASS
```

O build Tauri produziu o binário release em
`src-tauri/target/release/commit-ia-task`. Uma prova adicional com
`bun run tauri build` também gerou o pacote `.app`; somente a etapa opcional de
montagem do DMG ficou aguardando `osascript` no ambiente automatizado e foi
interrompida. Isso não altera o parecer, pois compilação, `.app` e o gate
formal `--no-bundle` foram comprovados.

O runner frontend suportado e documentado é `bun run test` (Vitest).
`bun test` chama o runner nativo diferente do Bun e não é um gate anunciado
pelo projeto.
