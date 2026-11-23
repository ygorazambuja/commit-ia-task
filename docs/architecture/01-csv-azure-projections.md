# Pacote de trabalho 01 — Separar as projeções de CSV e Azure

## Prioridade

**P0 — correção funcional e aprofundamento arquitetural.** O adaptador Azure envia atualmente campos que a especificação reserva ao CSV.

## Objetivo

Fazer com que a tarefa gerada seja o dado comum do domínio e que cada **Adapter** produza sua própria projeção no ponto de uso. A **Module** de exportação deve oferecer uma **Interface** que esconda as diferenças entre CSV e Azure, aumentando a **Locality** das regras de cada destino e a **Leverage** para os chamadores.

O resultado precisa corrigir a criação direta no Azure sem alterar o conteúdo contratual do CSV. Não há necessidade de criar trait Rust, factory ou uma hierarquia de tipos; duas projeções internas e explícitas no código existente são suficientes se entregarem essa separação.

## Contexto e evidências

- [`src-tauri/src/models.rs:348`](../../src-tauri/src/models.rs#L348) define `TaskRecord` com praticamente toda a linha do CSV, incluindo `item_contrato`, `spf_id`, `ust`, `complexidade` e `estimate_made`.
- [`src-tauri/src/export.rs:30`](../../src-tauri/src/export.rs#L30) constrói uma única representação intermediária para todos os destinos.
- [`src-tauri/src/export.rs:63`](../../src-tauri/src/export.rs#L63) usa essa representação para escrever o CSV, onde todos esses campos são válidos.
- [`src-tauri/src/export.rs:156`](../../src-tauri/src/export.rs#L156) usa a mesma representação para a criação direta no Azure.
- [`src-tauri/src/export.rs:551`](../../src-tauri/src/export.rs#L551) monta os argumentos do Azure, e [`src-tauri/src/export.rs:576`](../../src-tauri/src/export.rs#L576) começa a enviar os campos customizados exclusivos do CSV.
- [`src-tauri/src/export.rs:745`](../../src-tauri/src/export.rs#L745) possui um teste que hoje exige esses campos no Azure e, portanto, consolida o comportamento incorreto.
- [`AGENTS.md:225`](../../AGENTS.md#L225) estabelece o contrato completo do CSV; [`AGENTS.md:257`](../../AGENTS.md#L257) estabelece que o Azure recebe somente título, descrição, responsável, estado, área, iteração, atividade, estimativa original e trabalho restante.
- [`README.md:255`](../../README.md#L255) contradiz `AGENTS.md` ao afirmar que os campos exclusivos do CSV também são enviados ao Azure. Para este trabalho, `AGENTS.md` é a fonte normativa.

Pelo **deletion test**, a representação compartilhada atual é **Shallow**: removê-la não elimina complexidade; apenas permite que cada destino expresse a sua regra onde ela realmente pertence. CSV e Azure são dois **Adapters** reais, então a **Seam** entre o dado comum e as projeções é justificada.

## Escopo

- Identificar o menor conjunto de dados comum necessário para representar uma tarefa pronta para entrega.
- Manter a projeção das 16 colunas do CSV dentro do adaptador CSV.
- Manter a projeção dos campos aceitos pela criação direta dentro do adaptador Azure.
- Impedir que campos exclusivos do CSV cheguem aos argumentos de `az boards work-item create`.
- Preservar sanitização de textos, normalização da estimativa e mapeamentos de SPF/UST.
- Ajustar os testes existentes para verificar separadamente cada projeção.
- Corrigir a descrição da criação direta no Azure em `README.md` para refletir `AGENTS.md`.
- Fazer apenas os ajustes mínimos de chamada necessários para compilar, caso a representação intermediária mude.

## Fora de escopo

- Reorganizar a execução ponta a ponta de `run_generation`; isso pertence ao pacote 02.
- Alterar o fluxo de inspeção ou stage do Git.
- Alterar modelos, prompt, schema ou política de concorrência dos provedores de IA.
- Alterar as colunas do CSV, seus nomes, sua ordem ou seus valores fixos.
- Enviar campos novos ao Azure ou alterar a vinculação com item pai.
- Alterar Time Log Free, autenticação ou configuração persistida.
- Criar trait Rust, factory, registro de destinos ou abstração extensível para destinos hipotéticos.

## Invariantes

### CSV

- O cabeçalho permanece exatamente, nesta ordem: `ID`, `Work Item Type`, `Title`, `Assigned To`, `State`, `Area ID`, `Iteration ID`, `Item Contrato`, `ID SPF`, `UST`, `Complexidade`, `Activity`, `Description`, `Estimate Made`, `Remaining Work`, `Original Estimate`.
- `Work Item Type` permanece `Task`, `State` permanece `To Do` e `Activity` permanece `Development`.
- A estimativa normalizada permanece um inteiro de 1 a 8, com fallback 1, reutilizado em `Estimate Made`, `Remaining Work` e `Original Estimate`.
- O SPF permanece Backend → 17, Frontend → 19 e Testes → 22.
- A UST permanece BAIXA → 8, MEDIA → 24, ALTA → 40 e ÚNICA/fallback → 8.
- O arquivo continua collision-safe, sem sobrescrever arquivo ou link simbólico existente, e usa `tasks-{dia}-{mês}-{hora}-{minuto}.csv` com sufixo numérico quando necessário.
- Um repositório limpo ainda pode gerar um CSV contendo somente o cabeçalho.

### Azure

- A criação direta envia título, descrição, responsável, estado, área, iteração, atividade, `Original Estimate` e `Remaining Work`.
- A criação direta **não** envia `Item Contrato`, `ID SPF`, `UST`, `Complexidade` nem um campo separado de `Estimate Made`.
- Organização e projeto continuam opcionais nos argumentos, pois os padrões do Azure CLI podem suprir os valores.
- IDs numéricos de Área e Iteração continuam resolvidos para caminhos antes da primeira criação.
- Itens continuam sendo criados sequencialmente; a primeira falha encerra novas criações e preserva os IDs já obtidos.
- A validação e a vinculação opcional do item pai permanecem como estão, inclusive a preservação do ID quando a vinculação falha.
- Toda execução externa continua usando programa e argumentos separados; não construir comandos de shell nem interpolar entrada do usuário em uma string executável.

### Fluxo compartilhado

- O CSV continua sendo escrito antes de qualquer tentativa de criação no Azure.
- Falha do Azure não remove o CSV nem resultados de stage já produzidos.
- A **Interface** serializada entregue ao React permanece compatível.

## Plano de implementação em passos

1. Registrar o comportamento atual do CSV com os testes existentes antes de alterar a representação, para detectar qualquer mudança involuntária nas 16 colunas.
2. Delimitar, dentro da **Module** de exportação, quais dados são comuns e quais existem apenas para uma projeção. Escolher nomes orientados ao domínio já usado no repositório; não criar uma taxonomia genérica de destinos.
3. Fazer o adaptador CSV construir ou consumir sua projeção completa no ponto mais próximo de `write_csv`, mantendo cabeçalho, sanitização, mapeamentos e estimativas.
4. Fazer o adaptador Azure construir somente os argumentos permitidos no ponto mais próximo de `build_azure_args`.
5. Remover dos argumentos Azure `Custom.ItemContrato`, `Custom.IDSPF`, `Custom.UST`, `Custom.Complexidade` e `Custom.EstimateMade`, sem remover `Microsoft.VSTS.Scheduling.OriginalEstimate` ou `Microsoft.VSTS.Scheduling.RemainingWork`.
6. Simplificar ou substituir `TaskRecord` somente até o ponto necessário para que ele deixe de impor o formato CSV ao adaptador Azure. Não extrair traits, factories ou arquivos adicionais sem ganho concreto de **Depth**.
7. Atualizar os testes co-localizados em `export.rs`: o teste do CSV deve afirmar a projeção CSV, e o teste do Azure deve afirmar inclusões e exclusões do Azure.
8. Corrigir `README.md` para deixar explícito quais campos são exclusivos do CSV.
9. Executar formatação e todas as validações Rust. Se algum chamador precisar mudar, limitar a alteração à adaptação da nova **Interface** e coordená-la com o pacote 02.

## Estratégia de testes

- Manter ou reforçar o teste golden que valida o cabeçalho, as 16 colunas, escaping de vírgulas/aspas e as três cópias da estimativa no CSV.
- Cobrir os mapeamentos Backend/Frontend/Testes e BAIXA/MEDIA/ALTA/ÚNICA na projeção CSV.
- Substituir o teste que hoje exige campos customizados no Azure por um teste de conjunto de argumentos que:
  - exige título, descrição, responsável, estado, área, iteração, atividade, estimativa original e trabalho restante;
  - rejeita explicitamente `Item Contrato`, `ID SPF`, `UST`, `Complexidade` e `Estimate Made`;
  - preserva `--org`, `--project` e `--output json` quando informados.
- Manter os testes com executável `az` falso para ordem sequencial, destinos numéricos, item pai, erro parcial e segurança dos argumentos. Nunca chamar Azure real.
- Executar:

  ```bash
  cargo fmt --manifest-path src-tauri/Cargo.toml --check
  cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
  cargo test --manifest-path src-tauri/Cargo.toml --locked
  ```

## Critérios de aceite

- O CSV gerado continua byte-a-byte compatível nos valores e na ordem das 16 colunas para a mesma entrada, desconsiderando o nome temporal do arquivo.
- Os argumentos de criação no Azure contêm todos e somente os campos autorizados por `AGENTS.md`.
- Nenhum argumento Azure começa com `Custom.ItemContrato=`, `Custom.IDSPF=`, `Custom.UST=`, `Custom.Complexidade=` ou `Custom.EstimateMade=`.
- `Original Estimate` e `Remaining Work` continuam com a estimativa normalizada.
- Os testes não tratam mais a forma completa da linha CSV como contrato do adaptador Azure.
- `README.md` e `AGENTS.md` deixam de divergir sobre os campos enviados ao Azure.
- Não foi adicionada abstração para um destino inexistente.
- Formatação, Clippy com warnings como erro e suíte Rust completa passam.

## Coordenação entre agentes

### Arquivos que este agente pretende possuir

- `src-tauri/src/export.rs`, incluindo seus testes co-localizados.
- `src-tauri/src/models.rs`, somente se for necessário ajustar a representação compartilhada.
- `README.md`, somente no trecho de CSV/Azure.

### Conflitos e dependências

- O pacote 02 possui `src-tauri/src/commands.rs` e pode mover os call sites de `build_task_records`, `write_csv` e `create_azure_tasks`. Este agente deve evitar editar `commands.rs`; se uma alteração for indispensável, combinar primeiro a pequena janela de integração com o agente do pacote 02.
- O pacote 04 também pode precisar de `models.rs`; este pacote deve evitar alterá-lo se a separação puder permanecer interna a `export.rs` e coordenar qualquer mudança inevitável.
- O pacote 02 será o integrador final de `commands.rs`. Antes de remover ou renomear uma função usada por ele, comunicar a forma final do ponto de chamada.
- Não incorporar mudanças dos pacotes de Git, IA ou configuração neste trabalho.

### Ordem sugerida

1. Este pacote fixa o contrato dos dois destinos e informa ao agente do pacote 02 qualquer mudança de chamada.
2. Os pacotes 03, 04 e 05 podem avançar em suas **Implementations** sem editar `export.rs`.
3. O pacote 06 é integrado depois do 05.
4. O pacote 02 adapta a orquestração para todas as **Interfaces** finais.
5. Um único agente executa os gates completos após a integração.

## Riscos

- Remover por engano `Original Estimate` ou `Remaining Work` junto com os cinco campos proibidos.
- Alterar escaping, sanitização, ordem ou número de colunas ao mudar a representação do CSV.
- Manter um tipo supostamente comum que ainda obrigue o Azure a conhecer detalhes exclusivos do CSV, produzindo apenas uma renomeação sem mais **Locality**.
- Criar vários tipos pass-through e reduzir a **Depth** da **Module** em vez de aprofundá-la.
- Testar apenas presença de argumentos e deixar uma futura regressão reintroduzir campos proibidos; as exclusões precisam ser explícitas.
- Conflitar com o pacote 04 em `models.rs` ou com o pacote 02 no ponto de chamada de exportação.
