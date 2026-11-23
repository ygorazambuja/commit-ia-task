# Pacote de trabalho 03 — Alteração Git analisada e stage seguro

## Prioridade

P1 — segurança do código local e simplificação da geração.

## Objetivo

Aprofundar a **Module** Git para que uma alteração analisada carregue, de forma coesa, o estado observado, o payload enviado à IA e o comportamento de stage seguro. O chamador deve obter **Leverage** sem precisar reproduzir a ordem “descobrir → montar payload → guardar payload → revalidar → adicionar ao stage”.

O resultado esperado é mais **Locality** para as invariantes Git: a **Implementation** pode continuar usando o executável `git`, mas detalhes como `is_new`, `has_staged` e `has_unstaged` não devem vazar pela **Seam** apenas para que outro módulo consiga devolver esses dados depois.

## Contexto e evidências

- O produto transforma alterações Git locais em tarefas e deve preservar o controle do desenvolvedor sobre o código ([PRODUCT.md:9](../../PRODUCT.md#L9), [PRODUCT.md:25](../../PRODUCT.md#L25)).
- A arquitetura atribui ao Rust toda operação Git e ao `git.rs` a descoberta, a montagem do payload e a revalidação anterior ao stage ([AGENTS.md:14](../../AGENTS.md#L14), [AGENTS.md:117](../../AGENTS.md#L117)).
- `FileChange` expõe caminho, `FileKind` e três booleanos correlacionados; o chamador precisa conhecer a representação interna do estado observado ([src-tauri/src/git.rs:29](../../src-tauri/src/git.rs#L29)).
- `altered_files` deriva esses campos a partir de três comandos Git e mantém estados parcialmente redundantes ([src-tauri/src/git.rs:80](../../src-tauri/src/git.rs#L80), [src-tauri/src/git.rs:103](../../src-tauri/src/git.rs#L103)).
- `payload_for` escolhe entre arquivo completo, diff cached, diff da árvore de trabalho, seções mistas e fallback ([src-tauri/src/git.rs:137](../../src-tauri/src/git.rs#L137)).
- `stage_if_unchanged` exige novamente `FileChange`, raiz e o payload que o chamador guardou; depois redescobre e remonta a alteração para compará-la ([src-tauri/src/git.rs:186](../../src-tauri/src/git.rs#L186)).
- `process_files` conhece essa sequência e transporta `String` ao lado do resultado da IA apenas para devolver o payload ao Git ([src-tauri/src/commands.rs:427](../../src-tauri/src/commands.rs#L427), [src-tauri/src/commands.rs:457](../../src-tauri/src/commands.rs#L457), [src-tauri/src/commands.rs:498](../../src-tauri/src/commands.rs#L498)).
- Os testes já demonstram as invariantes mais arriscadas: preservar conteúdo previamente staged durante uma corrida, não incluir conteúdo unstaged novo, rejeitar symlink externo e aceitar nomes hostis após `--` ([src-tauri/src/git.rs:353](../../src-tauri/src/git.rs#L353), [src-tauri/src/git.rs:374](../../src-tauri/src/git.rs#L374), [src-tauri/src/git.rs:394](../../src-tauri/src/git.rs#L394), [src-tauri/src/git.rs:444](../../src-tauri/src/git.rs#L444)).

Pelo **deletion test**, remover `payload_for` e `stage_if_unchanged` apenas faria
o protocolo reaparecer em `commands.rs`. A oportunidade é aprofundar a
**Module**, não repartir a mesma regra em mais arquivos.

Não há `CONTEXT.md` nem ADRs no estado atual do repositório. Este pacote usa o
vocabulário de `PRODUCT.md`, `README.md` e `AGENTS.md` e não altera decisões já
documentadas.

## Escopo

- Redesenhar os tipos internos de `git.rs` para representar uma alteração
  descoberta e uma alteração efetivamente analisada sem estado público
  redundante.
- Fazer a alteração analisada possuir ou encapsular tudo que o Git precisa para
  revalidar exatamente o payload usado na geração.
- Reduzir o conhecimento Git em `process_files` ao necessário para obter caminho
  de exibição, fornecer o payload à IA e solicitar o stage seguro.
- Manter a inspeção serializada para a interface com `path` e `kind`.
- Migrar e completar testes Rust nos repositórios temporários locais.
- Atualizar comentários ou documentação apenas se a Interface final exigir.

## Fora de escopo

- Alterar prompt, provedores de IA, concorrência ou tratamento de falhas da IA.
- Mudar o stage automático para opt-in, stage parcial ou stage por hunk.
- Substituir o executável Git por uma dependência Rust.
- Criar trait ou factory para o único **Adapter** atual, o executável `git`.
- Mudar DTOs da interface sem necessidade; `RepositoryInspection` deve continuar
  compatível.
- Implementar a **Module** de execução ponta a ponta descrita no pacote 02.

## Invariantes

- Ignorar por basename `pnpm-lock.yaml`, `bun.lockb` e `package-lock.json`.
- Arquivo novo usa conteúdo completo; staged-only usa diff cached;
  unstaged-only usa diff da árvore de trabalho; alteração mista usa seções
  staged e unstaged separadas; diff vazio pode usar o arquivo completo.
- Symlink cujo destino canônico está fora da raiz do repositório é rejeitado.
- Argumentos de subprocesso continuam como arrays e todo pathspec vem após `--`.
- Uma falha de leitura/payload permanece isolada por arquivo.
- O stage só ocorre depois de a IA gerar tarefas com sucesso.
- O arquivo completo só é adicionado se estado e payload ainda correspondem ao
  que foi analisado; mudança concorrente nunca entra silenciosamente no index.
- Conteúdo que já estava staged é preservado se surgir alteração concorrente.
- Falha de stage não descarta tarefas: o resultado continua com `staged: false`
  e erro contextual.
- Deleções, renomes, espaços, Unicode e caminhos iniciados por hífen continuam
  funcionando.
- Repositório limpo continua podendo produzir CSV somente com cabeçalho.

Estas regras são normativas em
[AGENTS.md:209](../../AGENTS.md#L209) e descritas para o usuário em
[README.md:205](../../README.md#L205).

## Plano de implementação em passos

1. Registrar em comentário de implementação quais dados formam a identidade da
   alteração observada e quais são apenas apresentação. Não decidir o nome ou a
   assinatura pública antes de comparar as opções abaixo.
2. Escolher a menor **Interface** que preserve o protocolo. Opções aceitáveis
   incluem materializar um valor de alteração analisada a partir da descoberta,
   ou fazer a própria descoberta produzir valores prontos para análise. A
   decisão deve considerar custo de leitura, clareza e uso concorrente.
3. Tornar privados os detalhes de estado que só a **Implementation** usa para
   selecionar e revalidar o payload. Expor apenas capacidades necessárias ao
   chamador, não uma nova coleção equivalente de getters.
4. Associar payload e snapshot no mesmo valor. A operação de stage deve receber
   esse valor, ou ser comportamento dele, para tornar difícil revalidar um
   payload pertencente a outra alteração.
5. Manter dentro de `git.rs` a redescoberta do estado atual, a reconstrução do
   payload e a comparação anterior a `git add -- <path>`.
6. Adaptar `inspect` e `process_files` à nova **Interface**, removendo o transporte
   manual do par `(payload, FileChange)` quando ele deixar de ser necessário.
7. Aplicar o **deletion test** aos helpers antigos: excluir pass-throughs que só
   renomeiem chamadas; manter funções privadas quando aumentarem **Locality**.
8. Não criar novos arquivos, traits ou factories salvo evidência concreta de um
   segundo **Adapter** Git.
9. Executar testes focados, formatação e todos os gates Rust.

Decisão de **Interface** deixada aberta: se raiz e payload ficam armazenados no
valor, atrás de métodos, ou em uma pequena sessão do repositório. O critério é a
menor superfície que impeça combinações inválidas, não um formato predeterminado.

## Estratégia de testes

- Preservar os testes atuais para novo, modified, staged e mixed.
- Exercitar a **Interface** escolhida de ponta a ponta: descobrir/materializar,
  ler o payload usado pela IA e pedir stage ao mesmo valor analisado.
- Manter casos de corrida para alteração de conteúdo e mudança de estado entre
  análise e stage, verificando o conteúdo exato do index.
- Cobrir stage bem-sucedido de arquivo novo, modificado, deleção e rename.
- Cobrir fallback de diff vazio e rejeição de arquivo vazio quando aplicável.
- Cobrir symlink externo, Unicode, espaços e path iniciado por hífen.
- Atualizar o teste da pipeline para comprovar que sucesso gera stage e que
  falha da IA não gera stage nem altera conteúdo preexistente
  ([src-tauri/src/commands.rs:1063](../../src-tauri/src/commands.rs#L1063)).
- Não executar chamadas externas de IA ou Azure; usar somente Git local e
  diretórios temporários.
- Gates: `cargo fmt --manifest-path src-tauri/Cargo.toml --check`,
  `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings`
  e `cargo test --manifest-path src-tauri/Cargo.toml --locked`.

## Critérios de aceite

- `commands.rs` não compara nem transporta flags de estado Git para garantir o
  stage e não devolve um payload solto a uma função Git separada.
- A **Module** Git é a única dona da identidade observada e da revalidação.
- A inspeção da interface mantém os mesmos `path` e `kind` serializados.
- Todas as invariantes acima possuem teste por meio da Interface relevante.
- Nenhuma mudança concorrente substitui conteúdo já staged.
- Erro de stage continua contextual, não remove tarefas e não aborta outros
  arquivos.
- Não foi introduzida abstração para um único **Adapter**.
- Todos os gates Rust passam sem warnings.

## Coordenação entre agentes

- **Arquivos possuídos:** `src-tauri/src/git.rs` e seus testes; mudanças mínimas
  de integração em `src-tauri/src/commands.rs` e nos testes desse arquivo.
- **Não possuir:** `src-tauri/src/ai.rs`, `src-tauri/src/export.rs`, configuração,
  frontend ou DTOs sem acordo explícito.
- **Conflito principal:** o pacote 02 também altera `process_files` em
  `commands.rs`. Não implementar os dois em paralelo no mesmo worktree.
- **Ordem recomendada:** concluir este pacote primeiro; depois o agente do pacote
  02 aprofunda a execução usando a Interface Git já estabilizada.
- O pacote 04 pode avançar no núcleo de `ai.rs`, mas sua integração em
  `commands.rs` deve ocorrer depois deste pacote ou em commit coordenado.
- Antes de editar `commands.rs`, confirmar que outro agente não possui o arquivo;
  entregar a alteração Git e a adaptação do chamador no mesmo commit compilável.

## Riscos

- Um snapshot incompleto pode considerar duas alterações diferentes como iguais
  e incluir conteúdo não analisado no stage.
- Recalcular somente o payload, sem comparar a composição staged/unstaged, pode
  mascarar transições de estado relevantes.
- Armazenar dados demais no valor pode aumentar clones durante concorrência; medir
  antes de adicionar compartilhamento ou sincronização.
- Tornar o tipo excessivamente opaco pode prejudicar mensagens de progresso;
  preservar acesso simples ao caminho relativo de apresentação.
- Misturar esta mudança com a nova orquestração dificulta provar qual **Seam**
  protege a corrida. Manter commits pequenos e testes verdes a cada etapa.
