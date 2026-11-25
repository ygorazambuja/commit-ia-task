# Commit IA Task

CLI que lê as alterações pendentes de um repositório Git, usa IA para gerar tarefas por arquivo e exporta um CSV no formato de importação do Azure DevOps. Opcionalmente cria as tarefas direto no Azure DevOps.

## 🚀 Funcionalidades

- Análise dos arquivos alterados, staged, renomeados e novos (não rastreados) do repositório atual
- Geração de tarefas com OpenAI (API key), Codex (assinatura ChatGPT) ou Claude (assinatura Claude ou API key)
- Exportação para CSV compatível com importação do Azure DevOps
- Criação opcional das tarefas no Azure DevOps via Azure CLI
- Logging estruturado com níveis de verbosidade

## 📋 Requisitos

- Bun (runtime JavaScript)
- Git
- Azure CLI com extensão Azure DevOps (`az extension add --name azure-devops`), apenas para `--createAzureTasks`
- Provedor de IA escolhido via `--aiProvider`:
  - `openai` (padrão): conta na plataforma OpenAI com créditos e `OPENAI_API_KEY`
  - `codex`: Codex CLI no PATH e autenticado com `codex login` (assinatura ChatGPT)
  - `claude`: Claude Code instalado, com o comando `claude` no PATH (`claude --version` precisa funcionar no terminal), e autenticado com `claude login` (assinatura Claude) ou `ANTHROPIC_API_KEY`. O executável compilado não carrega o binário do Claude que vem com o SDK, então usa o `claude` do PATH. Só é necessário com `--aiProvider claude`
- Chave da TypeSafe em `JEV_API_KEY`: o modelo Jev classifica o serviço do catálogo (ID SPF) de cada tarefa. Opcional com `claude` e `codex`, que sem ela classificam com Haiku e Luna; obrigatória com `openai`

## 🛠 Instalação

```bash
bun install

# Verificar tipos e executar testes
bun run typecheck
bun test
```

### Instalar o executável `commit-ia-task`

O CLI é compilado com `bun build --compile` em um executável único.

**Windows:** execute `deploy.bat`. Ele compila `commit-ia-task.exe` e move para `C:\bin\`. A pasta `C:\bin\` precisa estar no PATH:

1. Pressione `Win + R`, digite `sysdm.cpl` e pressione Enter
2. Na aba "Avançado", clique em "Variáveis de Ambiente"
3. Em "Variáveis do sistema", selecione "Path" e clique em "Editar"
4. Clique em "Novo" e adicione: `C:\bin\`
5. Reinicie o terminal

**Linux/macOS:**

```bash
bun build --compile src/index.ts --outfile commit-ia-task
mv commit-ia-task ~/.local/bin/   # ou outra pasta do PATH
```

Sem compilar, também é possível rodar `bun run <caminho-deste-repo>/src/index.ts` de dentro do repositório alvo.

## 🎯 Uso

> **Execute sempre dentro do repositório cujas alterações devem virar tarefas.** O CLI analisa o diretório atual. Rodar `bun run src/index.ts` dentro deste repositório gera tarefas sobre o próprio Commit IA Task.

```bash
cd /caminho/do/repo-alvo
commit-ia-task [--sprintId "Projeto\\Sprint 1"] [--areaPathId "Projeto\\Area"] [--assignedTo "Nome <email>"] [--itemContrato "Item 1"] [--aiProvider openai|codex|claude] [--noJev] [--branch feature/x [--baseBranch main]] [--createAzureTasks [--pbi 12345] --azureOrganization https://dev.azure.com/org --azureProject "Projeto"]
```

Sem nenhuma flag nem config salva, o CLI gera o CSV com "Area ID" e "Iteration ID" vazios. `--sprintId` e `--areaPathId` só são obrigatórios com `--createAzureTasks`.

### Provedor de IA

```bash
# OpenAI via API key (padrão)
commit-ia-task --aiProvider openai

# Codex via assinatura (após codex login)
commit-ia-task --aiProvider codex

# Claude via assinatura (após claude login) ou ANTHROPIC_API_KEY; exige o claude no PATH
commit-ia-task --aiProvider claude
```

### Gerar tarefas de uma branch

Com `--branch`, em vez das alterações pendentes, o CLI usa os arquivos alterados na branch: do ponto em que ela saiu da base até o último commit dela. Funciona com branch ativa ou antiga, local ou remota (`origin/feature-x`), e não precisa fazer checkout.

```bash
commit-ia-task --branch feature/login

# Base diferente da padrão (branch ou commit)
commit-ia-task --branch feature/login --baseBranch develop
```

- A base padrão é a `develop` (sem diferenciar maiúscula, preferindo `origin/develop`); se não existir, `origin/HEAD`, depois `main`, depois `master`.
- Branch já mergeada com merge commit (ex.: PR no Azure DevOps): o CLI encontra o merge e usa só o que a branch trouxe.
- Branch mergeada por squash ou rebase: os commits da branch não estão na base, então o diff normal já funciona.
- Branch mergeada por fast-forward: não dá para saber onde ela começou. O CLI para com erro e pede `--baseBranch <commit de onde a branch saiu>`.
- Nesse modo o CLI **não** executa `git add` e ignora as alterações pendentes do diretório.

### Criar tarefas no Azure DevOps

```bash
commit-ia-task \
  --aiProvider codex \
  --sprintId "Projeto\\Sprint 1" \
  --areaPathId "Projeto\\Area" \
  --createAzureTasks \
  --azureOrganization "https://dev.azure.com/minha-org" \
  --azureProject "Meu Projeto"
```

O CSV continua sendo gerado. Com `--createAzureTasks`, o CLI também executa `az boards work-item create` para cada tarefa, uma por vez. Se uma criação falhar, o processo para e as tarefas já criadas permanecem no Azure DevOps.

Para criar as tarefas como filhas de um PBI, passe o ID dele com `--pbi`. Depois de criar cada tarefa, o CLI executa `az boards work-item relation add --relation-type parent`:

```bash
commit-ia-task --branch feature/login --createAzureTasks --pbi 12345 --sprintId "Projeto\\Sprint 1" --areaPathId "Projeto\\Area"
```

Se o vínculo falhar, o processo para e o erro informa o ID da tarefa que ficou criada sem pai.

Use `--noCsv` para criar as tarefas sem gerar o arquivo CSV.

Detalhes da criação via `az`:

- `--sprintId` e `--areaPathId` aceitam caminho (`Projeto\\Sprint 1`) ou ID numérico (`1513`). IDs numéricos são enviados como `System.IterationId` e `System.AreaId`.
- Os campos customizados vão como `Custom.ItemContrato`, `Custom.IDSPF`, `Custom.UST`, `Custom.Complexidade` e `Custom.EstimateMade`; o estado vai como `System.State`.
- No Windows, argumentos com acentos ou caracteres especiais do `cmd.exe` (`<`, `>`, `&`, `%`, `"`...) são passados ao `az` por arquivo temporário (`@arquivo`).

`--azureOrganization` e `--azureProject` são opcionais se já estiverem salvos na config do Commit IA Task ou configurados no Azure CLI com:

```bash
az devops configure --defaults organization=https://dev.azure.com/minha-org project="Meu Projeto"
```

### Parâmetros

| Flag                  | Descrição                                                                                      | Padrão                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `--sprintId`          | Iteration path ou ID usado no CSV e no `az`                                                    | valor salvo, senão vazio; obrigatório com `--createAzureTasks`        |
| `--areaPathId`        | Area path ou ID usado no CSV e no `az`                                                         | valor salvo, senão vazio; obrigatório com `--createAzureTasks`        |
| `--assignedTo`        | Responsável pelas tarefas                                                                      | valor salvo, senão `Ygor Azambuja <ygor.azambuja@infortechms.com.br>` |
| `--itemContrato`      | Item de contrato no CSV                                                                        | valor salvo, senão `Item 1`                                           |
| `--aiProvider`        | `openai`, `codex` ou `claude` (não é salvo)                                                    | `openai`                                                              |
| `--noJev`             | Classifica o serviço com Haiku (`claude`) ou Luna (`codex`) em vez do Jev (não é salvo)        | usa o Jev se houver `JEV_API_KEY`                                     |
| `--branch`            | Gera tarefas dos arquivos alterados nessa branch em vez das alterações pendentes (não é salvo) | desligado                                                             |
| `--baseBranch`        | Branch ou commit base para `--branch` (não é salvo)                                            | `develop`, senão `origin/HEAD`, `main` ou `master`                    |
| `--createAzureTasks`  | Cria as tarefas no Azure DevOps após gerar o CSV                                               | desligado                                                             |
| `--pbi`               | ID numérico do PBI pai; exige `--createAzureTasks` (não é salvo)                               | sem pai                                                               |
| `--noCsv`             | Não gera o CSV; exige `--createAzureTasks` (não é salvo)                                       | gera CSV                                                              |
| `--azureOrganization` | URL da organização, ex.: `https://dev.azure.com/minha-org`                                     | valor salvo, senão `az devops configure -l`                           |
| `--azureProject`      | Nome ou ID do projeto                                                                          | valor salvo, senão `az devops configure -l`                           |

Flags desconhecidas encerram o CLI com erro. Não existe `--help`.

### 💾 Persistência de configuração

- `sprintId`, `areaPathId`, `assignedTo`, `itemContrato`, `azureOrganization` e `azureProject` são salvos em `config.json` a cada execução:
  - Windows: `%APPDATA%\commit-ia-task\config.json`
  - macOS: `~/Library/Application Support/commit-ia-task/config.json`
  - Linux: `$XDG_CONFIG_HOME/commit-ia-task/config.json` ou `~/.config/commit-ia-task/config.json`
  - `COMMIT_IA_TASK_CONFIG_DIR` sobrescreve o diretório
- Prioridade: flag → valor salvo → padrão. **Flags passadas sobrescrevem a config salva** para as próximas execuções.
- Em terminal interativo (stdin e stdout são TTY), o CLI sempre pergunta cada campo: `Enter` mantém o valor atual, um novo valor atualiza e persiste.
- Fora de TTY (scripts, CI, agentes) não há perguntas: são usados flags e valores salvos.

## 🤖 Uso por agentes de código

Resumo do que um agente precisa saber antes de executar:

1. **Diretório:** rode dentro do repositório alvo. Sem `--branch`, o CLI analisa as alterações não commitadas do diretório atual (modificados, staged, renomeados e não rastreados). Com `--branch`, analisa os arquivos alterados naquela branch (veja "Gerar tarefas de uma branch"). Lock files (`pnpm-lock.yaml`, `bun.lockb`, `package-lock.json`) são ignorados.
2. **Sem prompts:** sem TTY, o CLI não pergunta nada. Sem `--sprintId` e `--areaPathId` (nem valores salvos), o CSV sai com esses campos vazios. Com `--createAzureTasks` eles são obrigatórios; se faltarem, sai com código `1`.
3. **Efeitos colaterais:**
   - Sem `--branch`, executa `git add` em cada arquivo processado com sucesso (altera o index do usuário).
   - Grava as flags passadas no `config.json`, substituindo os valores salvos.
   - Cria um arquivo `tasks-{dia}-{mês}-{hora}-{minuto}.csv` no diretório atual (com sufixo `-1`, `-2`... se já existir), exceto com `--noCsv`.
   - Com `--createAzureTasks`, cria work items reais no Azure DevOps. **Não é reversível pelo CLI: confirme com o usuário antes de usar.**
4. **Responsável padrão:** sem `--assignedTo` nem valor salvo, as tarefas são atribuídas a Ygor Azambuja. Passe `--assignedTo` quando o usuário for outra pessoa.
5. **Saída:** código `0` em sucesso, `1` em erro (provedor inválido, credencial ausente, parâmetros obrigatórios ausentes ou falha durante a execução). Falha de IA em um arquivo é registrada no log e não interrompe os demais. Use `LOG_LEVEL=error` para reduzir a saída.

## 🧩 Skills

Além do CLI principal, o repositório reúne scripts de rotina em `scripts/`, cada um chamado por uma skill em `.claude/skills/<nome>/SKILL.md`. Os scripts reaproveitam o `config.json` e a integração com o `az` do CLI. Para usar a skill, abra o Claude Code neste repositório e peça a tarefa (ex.: "lança a daily") ou digite `/<nome>`.

### Requisitos das skills

Não é preciso clonar outros repositórios (como o `timelog-bot`), mas cada pessoa precisa ter na máquina:

- **Bun**, com as dependências instaladas neste repositório (`bun install`). Os scripts rodam com `bun run`.
- **Azure CLI** com a extensão Azure DevOps (`az extension add --name azure-devops`), autenticado com `az devops login` usando um PAT próprio. Para o `timelog`, o PAT precisa do escopo **Extension Data (read & write)**.
- Organização e projeto do Azure DevOps salvos no `config.json` (rode o `commit-ia-task` uma vez) ou configurados com `az devops configure --defaults organization=https://dev.azure.com/minha-org project="Meu Projeto"`.

| Skill     | Script                                                                                                                            | O que faz                                                  |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `daily`   | `bun run scripts/daily.ts [--dryRun] [--sprintId X] [--pbi N]`                                                                    | Cria a task "Daily" de hoje na PBI Institucional da sprint |
| `timelog` | `bun run scripts/timelog.ts <id> --hours H [--minutes M] [--date YYYY-MM-DD] --type Backend\|Frontend --comment "..." [--dryRun]` | Registra horas na aba Time Log Free de um work item        |

### `daily`

- Acha a PBI da sprint (`sprintId` salvo ou `--sprintId`) cujo título contém "Institucional". Se houver zero ou mais de uma, para com erro; use `--pbi <id>` para escolher.
- Não duplica: se já existe uma task "Daily" criada hoje nessa PBI para o mesmo responsável, só informa o ID dela.
- Feito para rodar no fim do expediente: a descrição é `Reunião diária da SPxx.` seguida de "Atividades do dia", a lista das tasks atribuídas ao responsável alteradas hoje (link `#id`, título e estado; outras Dailies ficam de fora).
- Cria a task com título `Daily`, estado `Done`, estimativa 1h, ID SPF 17, UST 1 e complexidade BAIXA, vinculada à PBI.
- `--dryRun` faz só as consultas e imprime a descrição que seria usada.
- Precisa de `sprintId`, `areaPathId` e `assignedTo` salvos na config (rode o `commit-ia-task` uma vez) e do `az` autenticado.

### `timelog`

Port do CLI Rust `timelog-bot` (repositório irmão), sem PAT: usa a credencial do `az devops login`.

- Grava um documento na coleção `TimeLogData` da extensão [`TimeLog.time-logging-extension`](https://marketplace.visualstudio.com/items?itemName=TimeLog.time-logging-extension) via `az devops invoke`. Não altera `CompletedWork`, `RemainingWork` nem outros campos da task.
- Nome e ID gravados são os do usuário autenticado no `az`, obtidos com uma WIQL `@Me` (precisa ter algum work item atribuído nos últimos 90 dias).
- `--date` é opcional (padrão: hoje). `--type` aceita só `Backend` ou `Frontend`.
- Não é idempotente: cada execução cria uma linha. Depois de erro de rede no envio, confira a aba antes de repetir.
- Diferente do Rust, não suporta conta técnica (`--user-name`/`--user-id`), PAT/token por variável de ambiente nem `--timeout`/`--api-version`.

### Adicionar uma skill

1. Crie `scripts/<nome>.ts` exportando a lógica (testável com executor falso do `az`) e rodando só sob `import.meta.main`.
2. Crie `tests/<nome>.test.ts`.
3. Crie `.claude/skills/<nome>/SKILL.md` dizendo quando usar, o comando e como ler o resultado.
4. Adicione uma linha na tabela acima.

## 🔧 Variáveis de ambiente

- `LOG_LEVEL`: `debug`, `info` (padrão), `warn` ou `error`
- `OPENAI_API_KEY`: obrigatória com `--aiProvider openai`
- `JEV_API_KEY`: chave da TypeSafe usada para classificar o serviço de cada tarefa. Sem ela (ou com `--noJev`), `claude` classifica com `claude-haiku-5-5` e `codex` com `gpt-6-luna`; `openai` exige a chave. O CLI roda dentro do repositório alvo, então defina como variável de ambiente do usuário (um `.env` só é lido se estiver na pasta onde o comando roda)
- `CODEX_MODEL`: modelo opcional para o Codex (usa a config do usuário se omitido)
- `CLAUDE_MODEL`: modelo opcional para o Claude
- `ANTHROPIC_API_KEY`: alternativa ao `claude login` com `--aiProvider claude` (o `claude` continua precisando estar no PATH)
- `CLAUDE_CODE_PATH`: caminho do executável do Claude, para quando ele não está no PATH
- `COMMIT_IA_TASK_CONFIG_DIR`: diretório alternativo para o `config.json`

## 📄 Saída

O CSV tem as colunas:

- ID, Work Item Type, Title, Assigned To
- State, Area ID, Iteration ID, Item Contrato
- ID SPF, UST, Complexidade, Activity
- Description, Estimate Made, Remaining Work, Original Estimate

### Regras de preenchimento

- A IA gera por tarefa: título, descrição, `Complexidade` (`ALTA`, `MEDIA`, `BAIXA`) e `Estimate Made` (inteiro de `1` a `8`)
- `ID SPF` é decidido pelo Jev (TypeSafe), que recebe arquivo, se é novo ou modificado, título e descrição, e escolhe um dos serviços de código do catálogo SPF-SIAFIC em `src/catalogo.ts` (ex.: `17` componente novo, `21E` correção de erro, `22` testes unitários). Os títulos e descrições das tarefas são enviados para `api.typesafe.ai`
- `UST` é consultada no catálogo por serviço e complexidade (ex.: `17` = 8/24/40, `22` = 4/12/20, `21E` = 2). Serviço de nível único grava `Complexidade` `ÚNICA` e ignora a complexidade da IA
- Escolha do Jev com probabilidade abaixo de 0,7 é lançada mesmo assim e gera um aviso no log (`Serviço classificado com baixa confiança; revise`)
- Sem o Jev (`--noJev` ou sem `JEV_API_KEY`), o serviço é escolhido por Haiku (`claude`) ou Luna (`codex`) com o mesmo catálogo e as mesmas evidências. A confiança é declarada pelo próprio modelo, não é probabilidade medida: o Luna quase sempre declara acima de 0,9, então o aviso de baixa confiança raramente aparece
- `Remaining Work` e `Original Estimate` recebem o valor de `Estimate Made`; estimativa inválida vira `1`
- `Activity` é sempre `Development`

## 📊 Logging

Cada log tem timestamp, cor, emoji e dados estruturados. Exemplo de saída:

```
🚀 Iniciando aplicação Commit IA Task
📋 Configuração atual { sprintId: "123", areaPathId: "456", assignedTo: "...", itemContrato: "Item 1", configFile: "..." }
🔍 Iniciando análise de diferenças do Git...
📁 Arquivos encontrados { count: 3, files: ["src/index.ts", "src/api.ts", "README.md"] }
✅ Tasks geradas com sucesso { fileName: "src/index.ts", tasksCount: 2, tasks: [...] }
✅ Arquivo CSV gerado com sucesso { fileName: "tasks-15-12-14-30.csv", recordsWritten: 5 }
✅ Processo finalizado com sucesso!
```

## 🏗 Arquitetura

- `src/index.ts`: entrada do CLI, flags, config e orquestração
- `src/config.ts`: leitura e gravação do `config.json`
- `src/git.ts`: descoberta de arquivos alterados (pendentes ou de uma branch), diffs e `git add`
- `src/ai.ts`: roteamento entre provedores e integração OpenAI
- `src/ai-codex.ts`: integração com Codex SDK
- `src/ai-claude.ts`: integração com Claude Agent SDK
- `src/ai-provider.ts`: seleção e validação do provedor
- `src/ai-prompt.ts`: prompt enviado à IA
- `src/ai-schema.ts`: schema Zod das tarefas
- `src/csv.ts`: montagem dos registros e geração do CSV
- `src/azure-devops.ts`: criação de work items via `az boards`
- `src/logger.ts`: logging centralizado

## 🤝 Contribuição

1. Fork o projeto
2. Crie uma branch para sua feature
3. Commit suas mudanças
4. Push para a branch
5. Abra um Pull Request
