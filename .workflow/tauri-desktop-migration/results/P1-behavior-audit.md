# P1 — Auditoria de comportamento da CLI

## Escopo e fonte de verdade

Auditoria somente leitura da implementação em `src/`, dos testes em `tests/`,
do `README.md`, do `AGENTS.md` e dos scripts de instalação. Quando documentação
e implementação divergem, este relatório considera como contrato atual:

1. comportamento executado pelo código;
2. comportamento comprovado pelos testes;
3. documentação apenas quando não contradiz os dois itens anteriores.

Baseline verificada em 2026-07-27:

- `bun test`: **30 testes, 30 passaram, 0 falharam, 71 assertions**;
- `bun run typecheck`: **passou**;
- Bun reportado pelo runner: `1.3.14`;
- a auditoria não executou chamadas reais de IA nem criou work items.

## Limite obrigatório da migração

O backend Rust deve ser a fonte única das regras e de todo acesso ao sistema:
Git, arquivos, configuração, ambiente, processos `codex`/`az`, requisições de
IA, geração de CSV e staging. O React deve apenas:

- escolher o repositório e coletar os campos;
- invocar comandos Tauri tipados;
- mostrar progresso, tarefas, falhas por arquivo, caminho do CSV e IDs Azure;
- nunca executar shell, ler segredos ou duplicar normalização/mapeamentos.

### Mapa de módulos

| Implementação atual | Responsabilidade observável | Destino |
| --- | --- | --- |
| `src/index.ts` | parsing, precedência de configuração e orquestração | comando/orquestrador Rust + formulário React |
| `src/git.ts` | descoberta, payload por estado Git, tolerância por arquivo e `git add` | serviço Rust com executor injetável |
| `src/ai-provider.ts` | seleção e pré-requisitos do provedor | enum/validação Rust; seleção no React |
| `src/ai.ts` | roteamento OpenAI/Codex, duração, sanitização | serviço Rust |
| `src/ai-codex.ts` | execução Codex e parsing do JSON estruturado | adaptador Rust para Codex |
| `src/ai-prompt.ts` | prompt brasileiro comum | constante/função Rust testada |
| `src/ai-schema.ts` | contrato e normalização das tarefas | tipos/validação Rust |
| `src/csv.ts` | records, sanitização, mappings e escrita | serviço Rust |
| `src/azure-devops.ts` | defaults e criação sequencial via `az` | adaptador Rust com executor injetável |
| `src/config.ts` | path, schema e persistência tolerante a falhas | store Rust no app config |
| `src/logger.ts` | mensagens e redução de payload para terminal | eventos/progresso Rust apresentados no React |

## Fluxo público atual, na ordem real

1. `parseArgs` aceita as flags conhecidas e posicionais; uma flag desconhecida
   falha antes do bloco principal de tratamento de erros. Não há `--help`.
2. `aiProvider` é resolvido; vazio/ausente vira `openai`, e valor inválido
   encerra com código `1`.
3. O pré-requisito do provedor é validado:
   - OpenAI exige `OPENAI_API_KEY`;
   - Codex exige apenas que `codex --version` funcione. Login válido só é
     descoberto na chamada posterior.
4. A configuração persistida é carregada. JSON ausente ou inválido vira
   `null`, com warning para erro.
5. `az devops configure -l` é tentado em **toda execução**, mesmo quando o
   usuário não solicitou criação Azure e mesmo quando flags/config já possuem
   os campos. Qualquer falha é convertida em defaults vazios.
6. A configuração efetiva é montada.
7. Em TTY, todos os seis campos são perguntados em toda execução. Enter mantém
   o valor anterior; campos Azure são opcionais e os demais são obrigatórios.
8. Fora de TTY, apenas `sprintId` e `areaPathId` são validados como obrigatórios.
9. A configuração é salva **antes** da análise Git. Erro de escrita só gera
   warning e não interrompe o fluxo.
10. O diretório de trabalho atual (`pwd`) é usado como repositório.
11. Arquivos são descobertos e enviados à IA em paralelo.
12. Arquivos processados com sucesso são adicionados ao stage, um por vez.
13. Um CSV é sempre escrito, inclusive quando não há alterações/tarefas.
14. Com `createAzureTasks`, os records são reconstruídos e os work items são
   criados sequencialmente.
15. Falhas dentro do fluxo principal encerram com código `1`; sucesso termina
   após o log final.

O desktop precisa substituir `process.exit` por erros tipados retornados ao
React, sem mudar a ordem dos efeitos colaterais inadvertidamente.

## Entradas, defaults e precedência

### Seleção de provedor

- valores aceitos: `openai` e `codex`, sem distinção de maiúsculas/minúsculas e
  com trim;
- default: `openai`;
- o provedor **não é persistido**;
- `createAzureTasks` também não é persistido;
- `CODEX_MODEL` é lido do ambiente apenas pelo adaptador Codex.

### Configuração persistida

Contrato JSON atual:

```json
{
  "sprintId": "string",
  "areaPathId": "string",
  "assignedTo": "string",
  "itemContrato": "string",
  "azureOrganization": "string",
  "azureProject": "string"
}
```

`azureOrganization` e `azureProject` podem faltar em arquivos legados e então
recebem `""`. Qualquer tipo inválido em qualquer campo invalida o arquivo
inteiro. Campos desconhecidos são descartados pelo schema Zod.

Precedência real:

| Campo | Precedência |
| --- | --- |
| `sprintId` | flag → salvo → `""` |
| `areaPathId` | flag → salvo → `""` |
| `assignedTo` | flag → salvo → `Ygor Azambuja <ygor.azambuja@infortechms.com.br>` |
| `itemContrato` | flag → salvo → `Item 1` |
| `azureOrganization` | flag → salvo → default do `az` |
| `azureProject` | flag → salvo → default do `az` |

Essa precedência usa `||`: string vazia não limpa um valor salvo. No prompt,
resposta vazia também mantém o valor atual, portanto campos opcionais Azure não
podem ser apagados interativamente. O desktop deve decidir explicitamente se
preserva essa limitação ou oferece “limpar”; não deve limpar silenciosamente.

Validação:

- no modo não interativo, whitespace em `sprintId`/`areaPathId` passa porque a
  verificação não usa trim;
- `assignedTo` e `itemContrato` só são efetivamente obrigatórios no prompt TTY;
- o schema persistido aceita strings vazias e whitespace.

### Local do arquivo legado

- macOS: `~/Library/Application Support/commit-ia-task/config.json`;
- Windows: `%APPDATA%\commit-ia-task\config.json`, com fallback
  `~/.config/commit-ia-task/config.json`;
- Linux/outros: `$XDG_CONFIG_HOME/commit-ia-task/config.json` ou
  `~/.config/commit-ia-task/config.json`;
- `COMMIT_IA_TASK_CONFIG_DIR` substitui o diretório.

Como o diretório padrão do Tauri pode ser diferente, a migração precisa
reutilizar esse path ou importar o JSON legado uma vez para não perder
configuração existente. Nenhum segredo é persistido hoje.

## Contratos de IA

### Tarefa

```text
Task {
  title: string
  description: string
  tipo: BACKEND | FRONTEND | TESTES
  complexidade: string -> ALTA | MEDIA | BAIXA | ÚNICA
  estimateMade: number -> inteiro 1..8
}
```

Envelope exigido dos provedores:

```text
GeneratedTasks {
  fullFilePath: string
  tasks: Task[]
}
```

Regras exatas:

- `tasks` pode estar vazio;
- `title`, `description` e `fullFilePath` podem ser strings vazias;
- `tipo` inválido rejeita a resposta inteira;
- `complexidade` aceita qualquer string no parsing e depois:
  - trim + uppercase;
  - valor fora de `ALTA`, `MEDIA`, `BAIXA`, `ÚNICA` vira `ÚNICA`;
- `estimateMade` passa pelo schema somente se for número; número fracionário,
  menor que `1` ou maior que `8` vira `1`;
- a função pública de normalização também aceita string numérica (`"5"`), mas
  essa string é rejeitada antes pelo schema dos provedores;
- campos extras do JSON são descartados pelo Zod;
- o `fullFilePath` retornado pela IA não é confiado: `getDiff` sempre o
  sobrescreve com o path absoluto descoberto pelo Git.

O prompt:

- exige poucas tarefas e agrupamento por contexto;
- exige português brasileiro, texto puro e descrição didática;
- proíbe enquadramentos sobre o processo de análise;
- classifica `tipo`, `complexidade` e estimativa;
- evita “Inutil” e “Refatoração”.

Quirk atual: na OpenAI, o texto de sistema é enviado como mensagem `system` e
também repetido no começo da mensagem `user`. Codex recebe uma única string que
contém esse texto. A migração deve preservar as instruções sem precisar
preservar essa duplicação acidental.

### OpenAI

- modelo fixo: `gpt-5-nano`;
- credencial: `OPENAI_API_KEY` do ambiente;
- usa resposta estruturada pelo schema;
- falha do provedor falha apenas o arquivo correspondente durante a análise.

### Codex

- usa a sessão local do Codex, não API key;
- modelo opcional: `CODEX_MODEL`;
- thread atual usa sandbox `read-only` e aprovação `never`;
- resposta final deve ser JSON puro; code fence ou texto ao redor falha;
- erro de JSON inclui no máximo os primeiros 500 caracteres da resposta;
- a equivalência via Rust/`codex exec` precisa manter leitura apenas,
  aprovação desabilitada e schema estruturado.

## Semântica Git a preservar

Todos os comandos usam argumentos em array, `--` antes do path e formatos
delimitados por NUL; isso preserva espaços, acentos e a maioria dos nomes
especiais.

| Estado | Conteúdo enviado à IA |
| --- | --- |
| untracked (`??`) | conteúdo completo atual |
| adicionado ao stage (`A`, inclusive `AM`) | conteúdo completo atual |
| somente unstaged | `git diff -- <path>` |
| somente staged | `git diff --cached -- <path>` |
| staged + unstaged | dois diffs com marcadores `=== STAGED CHANGES ===` e `=== UNSTAGED CHANGES ===` |
| conteúdo calculado vazio | tenta conteúdo completo como fallback |

Detalhes e limites:

- fontes de nomes: diff unstaged, diff staged e porcelain status;
- renames/copies consomem a segunda entrada NUL do status e processam o path
  novo; rename staged com acento é coberto;
- deletados usam o diff; se esse diff vier vazio, o fallback tenta ler um path
  inexistente e o arquivo falha;
- arquivo novo vazio falha após o fallback;
- arquivos de lock ignorados por **basename**, em qualquer subdiretório:
  `pnpm-lock.yaml`, `bun.lockb`, `package-lock.json`;
- `yarn.lock`, `Cargo.lock` e o formato atual `bun.lock` não são ignorados;
- não há tratamento específico para binários, symlinks, submodules ou arquivos
  muito grandes;
- a ordem de resultados segue a ordem de descoberta, embora a IA rode em
  paralelo;
- uma falha de IA não cancela os demais arquivos (`Promise.allSettled`);
- somente sucessos são retornados e tentados no `git add`;
- erro no `git add` é logado e engolido: o arquivo ainda aparece como sucesso e
  ainda gera CSV;
- se havia arquivos e todos falham, retorna
  `Nenhum arquivo alterado pôde ser processado`;
- se não havia arquivos, não falha: retorna lista vazia e o fluxo gera CSV só
  com header;
- em sucesso parcial, falhas ficam apenas nos logs; o retorno não informa
  path/erro ao chamador.

O desktop adiciona uma entrada pública nova: diretório escolhido pelo usuário.
Antes de montar paths absolutos, Rust deve resolver o root/prefixo Git de forma
consistente. A implementação atual só foi testada quando `gitFolder` é a raiz
do repositório; iniciar em um subdiretório é comportamento não comprovado.

## Contrato do CSV

Ordem exata de headers:

```text
ID,Work Item Type,Title,Assigned To,State,Area ID,Iteration ID,
Item Contrato,ID SPF,UST,Complexidade,Activity,Description,
Estimate Made,Remaining Work,Original Estimate
```

Cada tarefa vira um record:

| Campo | Valor/regra atual |
| --- | --- |
| `ID` | `""` |
| `Work Item Type` | `Task` |
| `Title` | título sanitizado |
| `Assigned To` | responsável sanitizado |
| `State` | `To Do` |
| `Area ID` | `areaPathId`, sem sanitização prévia |
| `Iteration ID` | `sprintId`, sem sanitização prévia |
| `Item Contrato` | contrato sanitizado |
| `ID SPF` | `BACKEND=17`, `FRONTEND=19`, `TESTES=22` |
| `UST` | `BAIXA=8`, `MEDIA=24`, `ALTA=40`, `ÚNICA=8` |
| `Complexidade` | valor já normalizado pela pipeline |
| `Activity` | `Development` |
| `Description` | descrição sanitizada |
| `Estimate Made` | `estimateMade` |
| `Remaining Work` | `estimateMade` |
| `Original Estimate` | `estimateMade` |

Sanitização de `Title`, `Assigned To`, `Item Contrato` e `Description`:
CRLF/LF/CR viram espaço, todo whitespace consecutivo vira um espaço e as
pontas são removidas. Escaping CSV de vírgula/aspas fica a cargo de
`csv-writer`.

Arquivo:

- escrito no diretório de trabalho atual;
- nome `tasks-{dia}-{mês}-{hora}-{minuto}.csv`, sem zero padding e sem ano;
- colisão recebe `-1`, `-2`, ...;
- nenhuma tarefa ainda produz um CSV com apenas o header;
- `buildCsvFile` retorna `void`; o caminho existe apenas no log.

Para a UI, o comando Rust precisa retornar o path final. O default de paridade
mais próximo é salvar no repositório selecionado, mantendo nome e política de
colisão, embora a UI possa também oferecer um destino explícito.

## Contrato Azure DevOps

Defaults são extraídos de `az devops configure -l`, procurando linhas
`organization = ...` e `project = ...`. Falha, CLI ausente ou configuração
inválida viram strings vazias.

Criação:

- zero records retorna `[]` e não executa `az`;
- um processo `az boards work-item create` é executado por record,
  sequencialmente;
- `--org` e `--project` só são passados se não vazios; do contrário o Azure CLI
  usa seus próprios defaults;
- o JSON de saída contribui um ID somente quando `id` é número;
- JSON válido sem ID numérico é logado como sucesso e a execução continua;
- JSON inválido ou exit code não zero interrompe os records restantes.

Campos enviados:

```text
--type        Work Item Type
--title       Title
--description Description
--assigned-to Assigned To
--state       State
--area        Area ID
--iteration   Iteration ID
--fields      Microsoft.VSTS.Common.Activity
              Microsoft.VSTS.Scheduling.OriginalEstimate
              Microsoft.VSTS.Scheduling.RemainingWork
```

Não são enviados diretamente: `Item Contrato`, `ID SPF`, `UST`,
`Complexidade` e `Estimate Made`. Portanto, CSV e criação direta não são
equivalentes em todos os campos.

## Efeitos colaterais e estados parciais

Ordem material:

```text
salvar config
  -> chamadas de IA em paralelo
  -> git add dos sucessos
  -> escrever CSV
  -> criar work items Azure sequencialmente
```

Não há rollback. Consequências que o desktop deve comunicar:

- falha de IA parcial: sucessos são staged e exportados; falhas permanecem
  fora do resultado atual;
- falha de `git add`: CSV ainda inclui as tarefas desse arquivo;
- falha de CSV: config já foi salva e arquivos já podem estar staged;
- falha Azure: CSV já existe, arquivos já estão staged e work items anteriores
  já podem ter sido criados;
- cancelar a janela/processo durante execução pode deixar qualquer um desses
  estados parciais;
- uma nova execução pode analisar um estado diferente porque o run anterior
  moveu arquivos para staged.

O resultado Tauri mínimo para tornar isso observável deve carregar:

```text
RunResult {
  files: GeneratedTasks[]
  fileErrors: { path, message }[]
  csvPath: string
  createdAzureIds: number[]
}
```

Progresso deve distinguir análise, staging, CSV e Azure. Não basta transportar
os logs do terminal, porque o retorno atual perde falhas parciais.

## Logging observável

- níveis: `debug`, `info`, `warn`, `error`; default `info`;
- `LOG_LEVEL` inválido silencia todos os logs sem avisar;
- timestamp depende do locale;
- ANSI é emitido mesmo fora de TTY;
- mensagens e strings são reduzidas a uma linha e truncadas em 140 caracteres;
- arrays mostram no máximo 3 itens, objetos 6 entradas e profundidade 2;
- o formato real é texto `chave=valor`, não JSON.

No desktop, preservar mensagens brasileiras e informação útil, mas não há
necessidade de preservar ANSI, timestamp locale-dependent ou truncamento
interno. Erros completos devem continuar disponíveis em detalhe seguro.

## Lacunas entre documentação e código

### Contradições funcionais

1. **`AGENTS.md` diz `ID SPF=19` e `UST=4` fixos.** O código e os testes atuais
   comprovam mappings por tipo (`17/19/22`) e complexidade (`8/24/40/8`).
   A migração deve seguir código/testes.
2. **`README.md` chama os logs de dados estruturados em JSON.** O logger produz
   texto achatado `key=value`.
3. **`AGENTS.md` diz que a configuração é salva em todo “successful setup
   pass”.** A gravação ocorre antes do trabalho e permanece mesmo quando Git,
   IA, CSV ou Azure falham; além disso, falha de gravação é ignorada.
4. **A regra de textos visíveis em português não é total.** A mensagem de
   parâmetros obrigatórios está em inglês.
5. **`README.md` diz que valores atuais são exibidos em toda execução.** Em
   `LOG_LEVEL=warn` ou `error`, o log `info` correspondente não aparece.

### Documentação incompleta/desatualizada

- a lista de testes focados do `AGENTS.md` omite `tests/git.test.ts`;
- o mapa de arquitetura do README omite config, schema, prompt e Azure;
- o README não documenta staging automático, embora seja o efeito colateral
  mais importante;
- o README não documenta os mappings exatos de SPF/UST;
- o README não explica que Azure direto omite campos presentes no CSV;
- `deploy.bat` pressupõe um `.exe`, usa `rm` em batch e não há script de build
  correspondente no `package.json`;
- os scripts de deploy e toda instalação Bun/CLI ficarão obsoletos após Tauri.

## Cobertura existente e lacunas de teste

### O que já está comprovado

- normalização de complexidade e estimativa;
- sanitização de uma tarefa válida;
- resolução/global do provedor;
- parsing Codex válido, JSON inválido e schema inválido;
- presença de path/diff/instruções no prompt;
- Git executado no repositório solicitado;
- path untracked com espaço/acento, ignore de `bun.lockb` aninhado e staging;
- rename staged com acento;
- erro quando todos os arquivos falham;
- configuração válida, ausente, JSON inválido, tipo inválido e legado;
- CSV básico, mappings SPF/UST, header vazio e colisão no mesmo minuto;
- argumentos Azure de um record, zero records e leitura/falha de defaults;
- thresholds dos dois helpers de logger.

### Comportamento público sem prova atual

Prioridade alta para a migração:

1. orquestração completa/entry point: precedência, validação, modo sem TTY,
   persistência, ordem dos efeitos e erro final;
2. matriz Git: unstaged, staged, mixed com marcadores, add `AM`, deleted,
   fallback, arquivo vazio, parcial sucesso/erro, staging somente de sucesso,
   falha de staging, nenhum arquivo e todos os lockfiles;
3. payload real recebido pelo provedor em cada estado Git;
4. OpenAI/Codex com transportes simulados, inclusive schema, modelo, ambiente,
   resposta vazia e falhas;
5. CSV parseado exatamente (headers, ordem, escaping, records e path retornado),
   em vez de apenas substrings;
6. Azure sem org/project, vários records, falha parcial, JSON inválido e ID
   ausente;
7. seleção de repositório inválido/não Git e repositório escolhido por
   subdiretório;
8. contrato IPC Rust↔React e exibição de falhas por arquivo/estado parcial.

Prioridade secundária:

- paths de config por plataforma, falha de escrita e import do JSON legado;
- cancelamento/duplo clique enquanto um run está ativo;
- binário, symlink, submodule e payload grande;
- logger/progresso, acessibilidade e persistência do formulário React.

## Checklist de paridade para P4/P5

- [ ] React não contém shell nem mappings de negócio.
- [ ] O usuário seleciona explicitamente um repositório válido.
- [ ] Config legado é carregado/importado sem armazenar segredo.
- [ ] OpenAI continua usando `OPENAI_API_KEY`; Codex continua usando sessão
      local e `CODEX_MODEL` opcional.
- [ ] Prompt, enum de tipo e normalizações preservados.
- [ ] Estados Git produzem os mesmos payloads e paths especiais continuam
      seguros.
- [ ] Falha por arquivo não cancela sucessos e fica visível na UI.
- [ ] Somente arquivos processados com sucesso são tentados no stage.
- [ ] CSV preserva headers, mappings, sanitização, estimativas e colisão.
- [ ] O path final do CSV é retornado à UI.
- [ ] Azure usa os mesmos argumentos, não roda em testes e expõe IDs/falhas.
- [ ] Estados parciais são mostrados; nenhuma promessa de rollback inexistente.
- [ ] Testes Rust, React, typecheck e build cobrem o fluxo integrado.

