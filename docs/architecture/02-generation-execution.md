# Pacote de trabalho 02 — Aprofundar a execução ponta a ponta da geração

## Prioridade

**P1 — aprofundamento arquitetural com alto impacto em testabilidade.** Deve preservar o comportamento observável enquanto concentra a orquestração em uma única **Module Deep**.

## Objetivo

Concentrar o ciclo completo de geração atrás de uma **Interface** pequena: validação, inspeção Git, persistência não fatal da configuração, geração por arquivo, stage seguro, tratamento de falhas parciais, escrita e registro do CSV, criação opcional no Azure e agregação do resultado.

O comando Tauri deve permanecer como **Adapter** fino entre `AppHandle`/`State`, eventos e a **Module** de geração. A mudança deve aumentar a **Locality** das invariantes de ordem e falha e dar aos testes **Leverage** sobre o mesmo fluxo usado em produção. Não criar traits Rust ou factories para dependências que só têm um adaptador concreto.

## Contexto e evidências

- [`src-tauri/src/commands.rs:312`](../../src-tauri/src/commands.rs#L312) inicia `run_generation`, que hoje reúne validação, infraestrutura Tauri e toda a orquestração do caso de uso.
- [`src-tauri/src/commands.rs:334`](../../src-tauri/src/commands.rs#L334) transforma falha de persistência da configuração em warning não fatal.
- [`src-tauri/src/commands.rs:345`](../../src-tauri/src/commands.rs#L345) conhece a política de concorrência específica por provedor.
- [`src-tauri/src/commands.rs:381`](../../src-tauri/src/commands.rs#L381) implementa a regra de falha total que impede a criação do CSV.
- [`src-tauri/src/commands.rs:392`](../../src-tauri/src/commands.rs#L392) inicia a projeção e escrita do CSV; [`src-tauri/src/commands.rs:400`](../../src-tauri/src/commands.rs#L400) registra o caminho na sessão; [`src-tauri/src/commands.rs:402`](../../src-tauri/src/commands.rs#L402) só depois inicia o Azure.
- [`src-tauri/src/commands.rs:427`](../../src-tauri/src/commands.rs#L427) define `process_files` com uma **Interface** genérica que exige mudanças, repositório, concorrência, função de IA e callback de progresso, embora exista um único chamador de produção.
- [`src-tauri/src/commands.rs:1064`](../../src-tauri/src/commands.rs#L1064) testa falhas parciais e stage por meio do helper privado; [`src-tauri/src/commands.rs:1125`](../../src-tauri/src/commands.rs#L1125) testa concorrência e ordem pelo mesmo helper, mas não atravessa a execução completa.
- [`src-tauri/src/models.rs:91`](../../src-tauri/src/models.rs#L91) define a entrada serializada e [`src-tauri/src/models.rs:225`](../../src-tauri/src/models.rs#L225) define o resultado que precisa permanecer compatível com o React.
- [`AGENTS.md:177`](../../AGENTS.md#L177) descreve a ordem do fluxo desktop; [`AGENTS.md:192`](../../AGENTS.md#L192) atribui ao comando revalidação, progresso, persistência, processamento, CSV e Azure.
- [`AGENTS.md:218`](../../AGENTS.md#L218) a [`AGENTS.md:222`](../../AGENTS.md#L222) estabelecem falhas por arquivo, stage seguro, falha total sem CSV e repositório limpo com CSV de cabeçalho.
- [`AGENTS.md:255`](../../AGENTS.md#L255) e [`AGENTS.md:259`](../../AGENTS.md#L259) estabelecem CSV antes do Azure e preservação de resultados parciais.

Pelo **deletion test**, remover `process_files` apenas espalharia sua **Implementation** de volta por `run_generation`; ele não concentra o caso de uso inteiro. A oportunidade é aprofundar a **Module** do fluxo, não simplesmente mover o helper para outro arquivo.

## Escopo

- Definir uma única **Module** responsável pela execução ponta a ponta da geração no backend Rust.
- Manter `run_generation` como a **Interface** Tauri já registrada, delegando a execução e traduzindo apenas tipos/estado/eventos específicos do Tauri quando necessário.
- Colocar as regras de ordem, falha parcial, falha total e agregação do resultado na mesma **Implementation**.
- Tornar o processamento concorrente por arquivo um detalhe interno da **Module**, em vez de ser a principal superfície de teste.
- Preservar a política atual de concorrência por provedor e a ordem original dos arquivos no resultado.
- Preservar o registro seguro do CSV na sessão nativa e sua relação com `reveal_generated_csv`.
- Migrar testes para atravessar a **Interface** da geração sempre que o cenário envolver coordenação entre duas ou mais etapas.
- Usar os adaptadores concretos existentes (`git`, `ai`, `config`, `export`) diretamente onde isso mantiver a **Interface** menor. Uma seam interna de teste pode reutilizar closures/fakes já necessários para impedir chamadas externas, sem virar abstração pública.

## Fora de escopo

- Alterar os DTOs serializados de `GenerationInput`, `GenerationResult`, `GeneratedFile` ou `FileFailure`.
- Alterar a superfície de comandos Tauri ou mover acesso privilegiado para React.
- Redesenhar payload e stage do Git; isso pertence ao pacote específico do Git.
- Redesenhar catálogo, prontidão ou configuração dos provedores de IA.
- Redesenhar o ciclo de vida da configuração ou da credencial do Time Log.
- Definir quais campos pertencem ao CSV e ao Azure; isso pertence ao pacote 01.
- Alterar textos de progresso sem necessidade funcional.
- Criar trait Rust, factory ou contêiner de dependências para cada função importada.
- Dividir a orquestração em vários wrappers pass-through ou arquivos pequenos sem ganho de **Depth**.

## Invariantes

### Entrada, validação e configuração

- Rust continua revalidando repositório, Sprint, Área, item de contrato, responsável corporativo e provedor, independentemente das validações do React.
- OpenAI continua exigindo chave da execução ou `OPENAI_API_KEY`; Codex continua sendo verificado novamente quanto a executável e autenticação no momento da geração.
- O caminho selecionado continua sendo resolvido para a raiz Git canônica pela inspeção.
- A configuração não secreta continua sendo salva antes do processamento. Uma falha de gravação não interrompe a geração e aparece em `GenerationResult.warnings`.
- A chave OpenAI e a opção de criação direta no Azure não podem ser persistidas.

### Processamento por arquivo

- Cada arquivo é independente: falha de payload ou IA vira `FileFailure` e não interrompe os demais.
- OpenAI mantém concorrência 1; Codex mantém o limite atual de concorrência 2, salvo decisão separada e documentada.
- Conclusão fora de ordem não altera a ordem original dos arquivos em `files` e `failures`.
- Após sucesso da IA, o arquivo inteiro só é staged se o payload permanecer inalterado.
- Falha de stage mantém as tarefas, define `staged: false` e preenche `stage_error`.
- Conteúdo staged anterior nunca é sobrescrito silenciosamente após uma edição concorrente.
- Se há arquivos alterados e nenhum produz tarefas por falha de processamento, a execução falha antes de criar CSV.
- Repositório sem alterações pode produzir CSV somente com cabeçalho.

### Saídas e efeitos

- O CSV é escrito e registrado antes de qualquer tentativa de criação no Azure.
- O registro continua aceitando somente um caminho canônico, existente, `tasks-*.csv` gerado na sessão atual; não enfraquecer `reveal_generated_csv`.
- Criação Azure só ocorre quando `createAzureTasks` é verdadeiro.
- Organização e projeto permanecem opcionais para permitir padrões do Azure CLI.
- Azure permanece sequencial. Na primeira falha, o resultado preserva CSV, stage e IDs já criados e retorna `azure_error`.
- `GenerationResult` preserva `repositoryPath`, `files`, `failures`, `csvPath`, `azureTaskIds`, `azureError` e `warnings` com a serialização atual.
- Os eventos `generation-progress` continuam cobrindo validação do repositório, início de cada arquivo, CSV, Azure quando habilitado e conclusão.
- Nenhum teste realiza chamadas reais a OpenAI, Codex ou Azure.

## Plano de implementação em passos

1. Caracterizar o fluxo atual com testes dos caminhos mais importantes antes da movimentação: sucesso, falha parcial, falha total, repositório limpo, stage recusado, ordem concorrente e Azure parcial.
2. Escolher a menor localização coerente para a **Module** de geração. Um arquivo dedicado é aceitável se concentrar comportamento; manter uma seção coesa no módulo existente também é aceitável. Não criar um arquivo apenas para encaminhar chamadas.
3. Delimitar a **Interface** externa da execução pelo que o comando realmente fornece e pelo resultado que precisa devolver. Evitar expor ao chamador detalhes como `JoinSet`, mapa de jobs, payload original ou política de ordenação.
4. Mover em conjunto as decisões de sequência hoje espalhadas em `run_generation`: validações, inspeção, warning de configuração, escolha da concorrência, processamento, regra de falha total, CSV, registro, Azure e resultado.
5. Tornar `process_files` uma função interna da **Implementation** ou absorvê-la nela. Manter seus detalhes concorrentes testáveis por uma seam interna mínima, sem promover uma assinatura genérica grande a contrato do restante do backend.
6. Adaptar progresso e registro do CSV no ponto mais estreito possível. Tipos Tauri podem ficar no adaptador se isso reduzir acoplamento, mas não deslocar para o comando as regras de quando emitir progresso ou quando registrar o arquivo.
7. Reduzir `run_generation` à adaptação Tauri e ao mapeamento final de erros, preservando seu nome, argumentos serializados e registro em `lib.rs`.
8. Migrar testes de coordenação para a nova **Interface**. Manter testes internos apenas para algoritmos concorrentes difíceis de observar sem fragilizar o teste ponta a ponta.
9. Remover imports, helpers e estados que se tornarem pass-through. Aplicar novamente o **deletion test**: apagar a nova **Module** deve fazer a complexidade do fluxo reaparecer no comando, não desaparecer.
10. Integrar a forma final do adaptador de exportação entregue pelo pacote 01 e executar todas as validações Rust.

## Estratégia de testes

- Usar repositórios Git temporários e geração de tarefas controlada localmente, como os testes atuais, para atravessar a **Interface** da execução sem chamar IA real.
- Cobrir no mínimo:
  - sucesso de um arquivo, stage seguro, CSV registrado e resultado agregado;
  - um arquivo com sucesso e outro com falha, preservando ambos os resultados apropriados;
  - todos os arquivos falhando, com erro e ausência de novo CSV;
  - repositório limpo, com CSV de cabeçalho;
  - alteração concorrente, com tarefas preservadas e `staged: false`;
  - conclusão concorrente fora de ordem, com resultado na ordem da inspeção e limite por provedor respeitado;
  - falha de configuração como warning não fatal;
  - criação Azure desabilitada, garantindo que o adaptador não seja acionado;
  - falha Azure após uma ou mais criações, preservando CSV, stage, IDs e `azure_error`.
- Reutilizar os executáveis locais falsos já empregados nos testes dos adaptadores. Não introduzir mock framework ou trait público só para testes.
- Manter um teste específico para `GeneratedCsvRegistry` e `reveal_generated_csv`, inclusive rejeição de arquivo não registrado ou de sessão anterior.
- Verificar que o comando Tauri continua registrado e que a forma serializada do resultado não muda.
- Executar:

  ```bash
  cargo fmt --manifest-path src-tauri/Cargo.toml --check
  cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
  cargo test --manifest-path src-tauri/Cargo.toml --locked
  ```

## Critérios de aceite

- `run_generation` é um **Adapter** fino; a ordem completa da geração está concentrada em uma **Module** com **Interface** menor que a implementação anterior espalhada.
- Um teste que atravessa essa **Interface** cobre o fluxo desde inspeção até CSV/resultado sem depender do helper privado `process_files` como unidade principal.
- Validação, warning de configuração, concorrência, falhas por arquivo, stage seguro, falha total, CSV, registro e Azure preservam o comportamento descrito nas invariantes.
- O resultado de arquivos mantém a ordem da inspeção mesmo quando jobs terminam fora de ordem.
- Nenhuma chamada real a OpenAI, Codex ou Azure ocorre nos testes.
- A superfície Tauri e os DTOs enviados ao React permanecem compatíveis.
- `reveal_generated_csv` não perde nenhuma validação de nome, existência, canonicalização ou registro da sessão.
- Não foi criado trait/factory para um único adaptador nem um pacote de wrappers pass-through.
- Formatação, Clippy com warnings como erro e suíte Rust completa passam.

## Coordenação entre agentes

### Arquivos que este agente pretende possuir

- `src-tauri/src/commands.rs`, inclusive os testes de geração atualmente co-localizados.
- Um eventual módulo Rust dedicado à execução da geração, somente se a extração realmente aumentar **Locality**.
- `src-tauri/src/lib.rs`, apenas para declarar/registrar o módulo se necessário; a lista pública de comandos não deve mudar.

### Conflitos e dependências

- O pacote 01 possui `src-tauri/src/export.rs`, `src-tauri/src/models.rs` quando necessário e o trecho CSV/Azure do `README.md`.
- Os pacotes 03, 04, 05 e 06 também integram mudanças em `commands.rs`. Este pacote é o integrador final desse arquivo e não deve ser implementado em paralelo com essas integrações.
- Este agente não deve editar `export.rs`, `git.rs`, `ai.rs`, `time_log.rs` ou `config.rs` para “limpar” suas **Implementations**. Deve consumir as **Interfaces** estabilizadas pelos pacotes correspondentes.
- Se outro pacote mudar funções chamadas por `commands.rs`, seu agente deve comunicar a forma final. Este agente possui a adaptação definitiva dos pontos de chamada em `commands.rs`.
- Alterações em `models.rs` e nos DTOs pertencem aos respectivos pacotes de domínio durante as ondas anteriores. Solicitar coordenação antes de qualquer mudança inevitável nesses arquivos.

### Ordem sugerida

1. Antes da implementação deste pacote, integrar 01 e 03 e estabilizar as partes Rust de 04 e 05.
2. Integrar 06 depois de 05, resolvendo sua região compartilhada de `save_app_settings`.
3. Rebasear este pacote sobre todas essas mudanças e então concentrar o fluxo de geração em `commands.rs` ou na **Module** escolhida.
4. Adaptar todos os pontos de chamada uma única vez, sem reabrir as **Implementations** dos outros pacotes.
5. Um único agente executa os gates Rust e frontend depois da integração completa.

## Riscos

- Apenas mover `process_files` para outro arquivo e continuar com uma **Module Shallow**, sem concentrar as invariantes do fluxo.
- Criar uma **Interface** maior que o problema, com um trait ou callback para cada função, reduzindo **Depth** e tornando os testes acoplados à implementação.
- Alterar silenciosamente a ordem dos efeitos: configuração, stage, CSV, registro e Azure.
- Perder warning não fatal de configuração ou converter falhas por arquivo em falha global.
- Emitir progresso com índices ou totais diferentes e causar regressão visual no React.
- Deixar um CSV criado porém não registrado após reorganizar a etapa de registro, ou registrar antes de a escrita terminar.
- Duplicar validação entre o comando e a nova **Module**, fazendo as duas cópias divergirem com o tempo.
- Conflitar com os pacotes 01, 03, 04, 05 ou 06 ao alterar `commands.rs` antes de suas **Interfaces** estarem estabilizadas.
