# Infortech Automation

Aplicação desktop para transformar alterações de um repositório Git em tarefas estruturadas em português brasileiro. O aplicativo usa Tauri 2 no backend nativo, React no frontend e permite:

- analisar arquivos novos, modificados, staged ou com mudanças mistas;
- gerar tarefas com OpenAI ou com uma sessão local do Codex;
- exportar um CSV compatível com Azure DevOps;
- criar os work items diretamente no Azure DevOps, de forma opcional;
- distribuir as estimativas geradas no Time Log Free do item pai, também de forma opcional;
- registrar horas na extensão Time Log Free pelo aplicativo ou pelo terminal;
- acompanhar o processamento e as falhas parciais pela interface.

## Requisitos

- [Bun](https://bun.sh/) para instalar, testar e compilar o frontend;
- [Rust estável](https://www.rust-lang.org/tools/install) com Cargo para o backend Tauri;
- Git disponível no `PATH`;
- dependências nativas do Tauri para o sistema operacional, conforme o [guia oficial de pré-requisitos do Tauri 2](https://v2.tauri.app/start/prerequisites/):
  - macOS: Xcode ou Xcode Command Line Tools;
  - Windows: Microsoft C++ Build Tools e WebView2;
  - Linux: WebKitGTK e as demais bibliotecas indicadas para a distribuição.

O frontend requer o WebView equivalente a Safari 16.4 ou Chrome 111. Os
pacotes oficiais, portanto, têm como mínimo macOS 13.3; no Windows, o
instalador solicita WebView2 `111.0.1661.15` ou mais recente e pode precisar de
internet para baixá-lo ou atualizá-lo.

Dependências opcionais:

- provedor Codex: Codex CLI instalado e autenticado com `codex login`;
- criação direta no Azure: Azure CLI com a extensão Azure DevOps:

```bash
az extension add --name azure-devops
```

O Azure CLI não é necessário para gerar somente o CSV. A criação direta exige
um ID válido de PBI, User Story ou Requirement como item pai; a opção combinada
de Time Log fica disponível dentro desse fluxo.

O registro de horas usa a API da extensão Time Log Free e exige `ADO_PAT`
(escopo **Extension Data: read & write**) ou `ADO_TOKEN`. O PAT informado em
**Configurações** é salvo localmente na store do app. O formulário de registro
usa a organização e o PAT configurados, sem exibir novamente esses campos.

## Instalação e execução

```bash
bun install
bun run tauri:dev
```

O Bun é usado como gerenciador de pacotes e ferramenta de frontend. O processo nativo e todas as operações de sistema — Git, IA, arquivos e Azure — são executados pelo backend Rust.

### Build e instalação local no macOS

Com os pré-requisitos instalados, feche o aplicativo e execute:

```bash
bun run macos:install
```

O script instala as dependências com o lockfile, compila o `.app` em release
para a arquitetura do Mac (Apple Silicon ou Intel) e instala em
`~/Applications`, sem precisar de `sudo`. O build local usa
`CARGO_PROFILE_RELEASE_STRIP=none` para contornar uma
[falha de alinhamento de bibliotecas no macOS 27](https://github.com/rust-lang/rust/issues/157750)
que pode impedir o carregamento de macros como `thiserror_impl`. O aplicativo
continua compilado em release com otimizações. Uma versão anterior é substituída
somente depois da cópia do novo aplicativo; se a substituição falhar, o script
restaura a anterior. As configurações salvas do aplicativo são preservadas.

Para escolher outro diretório de instalação com permissão de escrita:

```bash
bun run macos:install /Applications
```

Após instalar com sucesso, o script remove os diretórios `debug` e `release`
de `src-tauri/target` e do target da arquitetura compilada, incluindo os bundles.
Se o build ou a instalação falhar, os artefatos dessa tentativa são mantidos. O próximo
build precisará recompilar os artefatos removidos. Esse comando instala somente
o aplicativo desktop; as CLIs continuam com seus comandos de instalação abaixo.

Valide o script sem compilar ou instalar, com builds e falhas simulados:

```bash
bash scripts/install-macos.test.sh
```

### Geração de tarefas pelo terminal e por agentes

A CLI `infortech` funciona sem abrir a interface e reutiliza o fluxo Rust da
aplicação: validação, geração por arquivo, stage seguro, CSV e criação opcional
no Azure. O escopo é gerar tarefas a partir das alterações locais do Git.

Execute neste projeto ou instale o binário para chamá-lo em qualquer repositório:

```bash
bun run tasks --help
bun run tasks:install
infortech --help
```

Inspecione as alterações sem gerar tarefas, gravar configuração ou fazer stage:

```bash
infortech inspect --repository /caminho/do/repositorio
```

Gere o CSV com o provedor Codex:

```bash
infortech generate \
  --repository /caminho/do/repositorio \
  --provider codex \
  --sprint "Projeto\\Sprint 1" \
  --area "Projeto\\Area" \
  --contract "Item 1"
```

Para criar também as Tasks no board e vinculá-las ao item pai:

```bash
infortech generate \
  --repository /caminho/do/repositorio \
  --provider codex \
  --create-azure-tasks \
  --parent 201878 \
  --organization https://dev.azure.com/empresa \
  --project Projeto
```

Sprint, Área, Responsável, Item de contrato, provedor, modelos e dados do Azure
usam a configuração salva na interface quando omitidos. No segundo exemplo de
geração, Sprint e Área precisam estar salvos. `--repository` omitido usa o
diretório atual. `--assigned-to "Nome <email@infortechms.com.br>"`, `--model`
e `--reasoning-effort` permitem sobrescrever os valores da execução.
`--save-config` persiste os parâmetros não secretos; por padrão, a CLI apenas
lê a configuração. Os prompts vêm do mesmo `prompts.json` da interface.
`COMMIT_IA_TASK_CONFIG_DIR` também é respeitada.

OpenAI usa `--provider openai` e `OPENAI_API_KEY`; Codex usa a sessão de
`codex login`. A CLI não aceita chaves ou PATs como argumentos. Um `.env`
no diretório de execução pode fornecer variáveis de ambiente. A criação direta
exige Azure CLI autenticado, a extensão Azure DevOps e `--parent` positivo.

Para agentes, o contrato é não interativo: stdout contém um único JSON e o
progresso vai para stderr. `inspect` retorna `repositoryPath` e `files`.
`generate` retorna tarefas por arquivo, estado do stage, `csvPath`,
`azureTaskIds`, falhas e avisos. Erros de execução retornam
`{"error":"mensagem"}`. Códigos de saída:

- `0`: operação concluída;
- `1`: erro que impediu a conclusão;
- `2`: geração parcial (arquivos, stage ou Azure) ou argumentos inválidos.

Ajuda e erros de argumentos seguem o formato textual do Clap. O resultado
parcial mantém o CSV e os IDs já criados. Confira esse JSON antes de repetir
uma criação no Azure, pois uma nova execução pode criar Tasks duplicadas.
A geração faz stage automático dos arquivos processados com segurança, como
na interface. O registro de horas pelo terminal continua em `timelog-bot`.

## Primeira configuração

Na primeira abertura, ou quando o `config.json` estiver ausente, incompleto ou
corrompido, o aplicativo mostra uma tela de configuração com estes valores
iniciais:

- nome: `Ygor Azambuja`;
- e-mail: `ygor.azambuja@infortechms.com.br`;
- organização: `https://dev.azure.com/InfortechMS`;
- projeto: `SPF-SIAFIC`.

O responsável é salvo como `Nome <email>`. Nome e projeto são obrigatórios, o
e-mail deve ser válido e terminar em `@infortechms.com.br`, e a organização
aceita um slug ou uma URL `https://dev.azure.com/<organização>`. Uma configuração
válida já salva sempre vence esses valores fixos; o aplicativo não importa nem
sobrescreve organização e projeto com `az devops configure` durante a abertura.

O Codex é selecionado primeiro quando o executável existe e `codex login status`
confirma a autenticação. Caso contrário, OpenAI é selecionado quando
`OPENAI_API_KEY` está disponível. Se nenhum provedor estiver pronto, OpenAI
permanece selecionado e a pendência é exibida sem impedir que os demais dados
sejam salvos.

O PAT do Time Log é opcional. A ação **Verificar PAT** consulta explicitamente o
`connectionData` do Azure e sugere nome e e-mail quando a identidade fornece um
e-mail corporativo. Nome e e-mail retornados preenchem somente campos vazios ou
inválidos, preservando valores manuais válidos; a confirmação manual continua
obrigatória quando o e-mail não estiver disponível. A identidade pública
`Anonymous`, devolvida pelo Azure para uma credencial inválida, é tratada como
erro. Um PAT salvo aparece apenas como configurado e pode ser
substituído ou removido, mas seu valor nunca é retornado à interface.

**Pular por agora** não grava a configuração: o workspace abre com um lembrete e
a tela volta na próxima inicialização, salvo se uma geração posterior gravar uma
configuração válida. A ação **Configurações** no cabeçalho reabre a mesma tela sem
descartar os campos em edição no workspace.

## Fluxo na interface

1. Conclua ou pule a primeira configuração quando ela for exibida.
2. Escolha a pasta do repositório. Uma subpasta também pode ser selecionada; o aplicativo resolve automaticamente a raiz Git.
3. Revise a lista de arquivos alterados e o estado de cada um.
4. Selecione o provedor:
   - **OpenAI**: use uma chave opcional informada somente para a execução ou `OPENAI_API_KEY`;
   - **Codex**: use a sessão autenticada pelo `codex login`.
5. Preencha Sprint, Área e Item de contrato. O Responsável vem da configuração salva e pode ser alterado em **Configurações**.
6. Se desejar criar work items diretamente, habilite a opção do Azure, revise organização e projeto e informe obrigatoriamente o ID do PBI, User Story ou Requirement que será o pai das tarefas. Organização e projeto podem ficar vazios quando já existem defaults no Azure CLI.
7. Para registrar também as estimativas geradas no Time Log Free, habilite a opção combinada e informe as datas inicial e final do período.
8. Inicie a geração e acompanhe o progresso.
9. Ao final, confira tarefas, falhas, arquivos staged, caminho do CSV, IDs criados no Azure e o plano/resultado do Time Log, quando aplicável.
10. Na aba **Registrar horas**, também é possível fazer um lançamento independente informando work item, duração, período, tipo e comentário. Organização e PAT vêm de **Configurações**.

### Minhas tarefas

A aba **Minhas tarefas** consulta os cards atribuídos à identidade autenticada
pelo PAT no projeto configurado. O monitor roda no Rust ao abrir o aplicativo
e a cada dois minutos, mesmo em outra aba. Usa o PAT salvo em Configurações ou,
na ausência dele, `ADO_PAT`. Além do acesso ao projeto, o PAT precisa de
**Work Items — Read**; a permissão de Extension Data do Time Log não a substitui.
O responsável preenchido manualmente nas Configurações não define essa consulta.

A primeira consulta estabelece uma referência sem gerar avisos para todo o
backlog. Novas atribuições e revisões geram avisos internos e um contador de não
lidos. **Atualizar** consulta manualmente e **Marcar como lidas** reconhece os
avisos. A lista inclui os cards mais recentes, com limite de 1.000 e aviso quando
houver mais resultados. Os estados são interpretados pelos metadados do projeto.
Falhas de rede/permissão aparecem no painel; novas tentativas automáticas usam
espera progressiva e respeitam `Retry-After`. Ao encerrar o processo ou suspender
o computador, não há consultas. Esta versão não envia notificações do sistema.

**Fazer** abre o seletor nativo para escolher o repositório Git e gera uma
análise/plano com o Codex: entendimento, critérios de aceite, arquivos relevantes,
passos, testes propostos, riscos e dúvidas. O card é consultado novamente,
incluindo descrição, comentários e contexto relacionado. É necessário ter o
Codex CLI atualizado e autenticado por `codex login`; são usados o modelo e o
esforço configurados para Codex, inclusive quando o provedor de geração é OpenAI.
O Codex executa em modo somente leitura, com integrações e hooks desabilitados.
O plano aparece no aplicativo e não executa implementação, stage, CSV, criação
de branch ou atualização do card. O editor de Prompts continua exclusivo da
geração de tarefas a partir de alterações Git.

Na aba **Prompts**, edite as **Instruções de geração** e clique em **Salvar**.
Elas valem para OpenAI e Codex em todos os repositórios e permanecem após
reiniciar. O arquivo e o diff continuam sendo enviados automaticamente.
**Descartar alterações** recupera o texto salvo; **Restaurar padrão** coloca as
instruções originais no editor e exige salvar para aplicar. Alternar abas ou
abrir Configurações preserva o rascunho. Alterações salvas durante uma geração
valem somente para a próxima execução.

O botão para revelar o CSV só aceita um arquivo `tasks-*.csv` existente que o backend Rust tenha gerado e registrado em memória na sessão atual do aplicativo. Um caminho arbitrário, um CSV de uma sessão anterior ou um arquivo apenas renomeado para esse padrão é rejeitado.

### Comandos e gates da interface

A ponte desktop expõe `get_initial_state`, `list_ai_models`, `identify_azure_user`,
`save_app_settings`, `save_prompt_settings`, `choose_repository`, `inspect_repository`, `run_generation`,
`reveal_generated_csv`, `create_time_log`, `get_azure_tasks`, `refresh_azure_tasks`,
`mark_azure_notifications_read` e `analyze_azure_task`, além dos eventos
`generation-progress` e `azure-tasks-updated`. O estado inicial inclui `requiresOnboarding`,
`profile: { displayName, email }`, `timeLogPatConfigured` e
`codexAuthenticated`, `promptSettings` e `defaultSystemPrompt`; os comandos de configuração identificam a conta do Azure
e mesclam somente os dados estáveis no arquivo existente.

A geração fica indisponível enquanto a aplicação carrega, inspeciona ou já está gerando, e até que um repositório seja selecionado. No envio, a interface exige repositório, Sprint, Área e Item de contrato; o Responsável é lido da configuração salva, no formato `Nome <email>` com e-mail corporativo. Para OpenAI, é necessário haver uma chave na execução ou em `OPENAI_API_KEY`; para Codex, o executável precisa estar disponível e autenticado. O backend Rust repete essas validações antes de acessar o repositório ou o provedor.

A criação direta no Azure só acontece quando sua opção está habilitada. O item
pai é obrigatório; organização e projeto continuam sendo argumentos opcionais
porque o próprio Azure CLI pode fornecer seus defaults.

### Time Log combinado à geração

A opção **Registrar também no Time Log** depende da criação direta no Azure. As
Tasks são criadas como filhas do item pai e, somente quando toda essa etapa
termina sem erro, cada estimativa gerada é convertida em minutos e planejada no
próprio item pai. Os títulos das Tasks formam os comentários, e os tipos são
mapeados para **Backend**, **Frontend** e **Teste**.

O período informado é inclusivo e não pode conter datas futuras. A distribuição
usa somente segunda a sexta-feira e não consulta calendário de feriados; assim,
um feriado em dia útil é tratado como dia disponível. O teto é global para o
usuário autenticado pelo PAT: no máximo 420 minutos por dia, somando todos os
work items e tipos e descontando os lançamentos já existentes desse usuário.

Todas as estimativas precisam caber integralmente no intervalo. Não há
truncamento: se faltar capacidade, o aplicativo mostra o plano e os minutos
pendentes sem fazer nenhum POST. Se a criação das Tasks no Azure for parcial, o
Time Log é pulado. Os POSTs do Time Log são sequenciais; a primeira falha
interrompe o lote, preserva o que já foi criado e não envia as entradas
restantes. Falhas parciais ou de resultado indeterminado nunca são repetidas
automaticamente.

### Registro de horas pelo terminal

O mesmo núcleo Rust usado pela interface também está disponível no binário
`timelog-bot`; não há uma segunda implementação da integração.

Execute no repositório:

```bash
bun run timelog 201878 \
  --hours 2 \
  --minutes 30 \
  --date 2026-08-12 \
  --end-date 2026-08-14 \
  --type Frontend \
  --comment "Implementei os indexadores financeiros" \
  --org https://dev.azure.com/empresa
```

Ou instale o comando globalmente para o usuário atual:

```bash
bun run timelog:install
timelog-bot --help
```

Credenciais são aceitas somente por `ADO_PAT` ou `ADO_TOKEN`, nunca por
argumento. `--date` continua obrigatório e define o início; `--end-date` define
o fim inclusivo e, quando omitido, usa a mesma data de `--date`. Os tipos aceitos
são `Backend`, `Frontend`, `Teste`, `Análise` e `Reunião`. Para Análise e
Reunião, a CLI também aceita os nomes sem acento, sem diferenciar maiúsculas de
minúsculas. As mesmas regras de dias úteis, teto diário e capacidade integral se
aplicam ao terminal.

`--dry-run` autentica, consulta os lançamentos existentes para calcular o saldo
global e mostra o plano completo sem gravá-lo. Os pares `--user-name` e
`--user-id` permitem selecionar uma identidade explícita e devem ser usados
juntos.

O lançamento grava minutos somente na coleção `TimeLogData` da extensão. Ele
não altera `CompletedWork`, `RemainingWork` ou outros campos do work item. O
POST não possui chave de idempotência: se uma falha de rede tornar o resultado
indeterminado, confira a aba Time Log Free antes de repetir.

## Provedores de IA e credenciais

Os modelos são descobertos automaticamente em Rust, na abertura do aplicativo e de Configurações. A atualização acontece em segundo plano, sem botão ou ação manual. Editar a chave temporária consulta a OpenAI após 800 ms sem edição. O catálogo é mantido apenas na sessão. Falhas preservam a última lista consultada ou a reserva local e mostram um aviso. Uma consulta bem-sucedida substitui a lista pelas opções retornadas pelo provedor.

`gpt-6-luna` continua como padrão inicial. A reserva local inclui `gpt-6.1-sol` nos dois provedores e GPT-5.6 Luna/Terra/Sol na API e no Codex. Codex Spark foi retirado da reserva; seu ID permanece legível em configurações antigas. Atualizar não troca nem sobrescreve o modelo escolhido: se ausente, ele aparece como indisponível e exige uma nova escolha antes de gerar. IDs descobertos e esforços de raciocínio são preservados ao reiniciar.

A geração do desktop e da CLI reconsulta o catálogo para a credencial atual e verifica modelo e esforço antes de processar arquivos. Se a descoberta falhar, essa validação usa a reserva local e retorna um aviso; modelos presentes apenas numa consulta anterior não são presumidos disponíveis.

### OpenAI

O backend usa o modelo selecionado nas Configurações, com `gpt-6-luna` como padrão. A chave informada no campo da interface:

- existe somente em memória;
- tem prioridade sobre `OPENAI_API_KEY`;
- nunca é escrita no arquivo de configuração;
- é apagada da interface ao iniciar a geração.

Se o campo estiver vazio, o aplicativo usa `OPENAI_API_KEY`, quando definida.

A descoberta usa [`GET /v1/models`](https://developers.openai.com/api/reference/resources/models/methods/list), com timeout de 10 segundos. Inclui candidatos textuais `gpt-` da geração 5 em diante e exclui modelos de imagem, áudio, realtime, transcrição, busca, chat-latest e especializados. Ordena por criação decrescente e ID; snapshots datados ficam ocultos quando existe o alias, exceto o snapshot salvo. A API não confirma suporte à saída estruturada: candidatos novos mostram **Compatibilidade ainda não verificada**, e falhas na geração identificam o modelo sem trocá-lo automaticamente. A lista local segue o [catálogo oficial](https://developers.openai.com/api/docs/models).

### Codex

O provedor Codex executa o Codex CLI local em modo efêmero e somente leitura. Antes de usar:

```bash
codex login
```

O Codex usa o modelo salvo nas Configurações, com `gpt-6-luna` como padrão. `CODEX_MODEL` pode sobrescrever essa escolha com outro modelo do catálogo Codex.

A descoberta inicia `codex app-server`, faz o handshake e percorre as páginas de [`model/list`](https://learn.chatgpt.com/docs/app-server#list-models-modellist). Usa os modelos visíveis e os esforços/padrões retornados por modelo, com timeout total de 15 segundos e encerramento do processo após a consulta. A interface preserva o esforço quando suportado; caso contrário, aplica o padrão retornado e informa a alteração. A geração continua em `codex exec`, efêmera, read-only e never-approve.

## Configuração persistida

O aplicativo reaproveita automaticamente o `config.json` da versão anterior. Campos novos recebem valores padrão, portanto não é necessária uma migração manual.

Local padrão:

| Sistema | Caminho |
| --- | --- |
| macOS | `~/Library/Application Support/commit-ia-task/config.json` |
| Windows | `%APPDATA%\commit-ia-task\config.json` |
| Linux | `$XDG_CONFIG_HOME/commit-ia-task/config.json` ou `~/.config/commit-ia-task/config.json` |

`COMMIT_IA_TASK_CONFIG_DIR` substitui o diretório padrão; o arquivo continua se chamando `config.json`.

São persistidos o repositório, Sprint, Área, Responsável, Item de contrato, provedor e dados de organização/projeto do Azure. Ao salvar a tela de configuração, os dados estáveis são mesclados sem apagar os campos operacionais já existentes. A chave da OpenAI, as opções de criação direta e Time Log, o período e o ID do item pai não são persistidos.

As instruções personalizadas ficam em `prompts.json`, no mesmo diretório, e não
são sobrescritas ao gerar tarefas ou salvar Configurações. Se esse arquivo
estiver ausente, o app usa o padrão; se estiver inválido ou não puder ser lido,
usa o padrão e mostra um aviso, sem exigir uma nova configuração inicial.

O PAT do Time Log Free é mantido separadamente em `time-log.json`, no mesmo
diretório de configuração. O registro de horas usa o PAT salvo e depois
`ADO_PAT`/`ADO_TOKEN` do ambiente. O PAT pode ser substituído ou removido pela
tela de configuração, nunca entra em `config.json` e não é exposto em respostas
ou logs. Essa store é um arquivo JSON local, não um cofre criptografado do
sistema; em sistemas Unix, o arquivo é restringido ao usuário atual com
permissão `0600`.

`azure-tasks.json`, no mesmo diretório, guarda o último retrato dos cards e até
100 avisos, identificados por organização, projeto e usuário autenticado. Não
contém PAT nem outros tokens. O histórico é reutilizado apenas quando essa
identidade corresponde à consulta atual. Falhas ao ler ou salvar o histórico
são visíveis e não impedem a consulta dos cards.

Se o arquivo salvo não puder ser lido ou desserializado, a aplicação usa os
valores iniciais, mostra o aviso na interface e abre a configuração para reparo.
Se a gravação falhar durante uma geração, o processamento continua e o resultado
exibe um aviso de configuração.

## Processamento Git

Arquivos `pnpm-lock.yaml`, `bun.lockb` e `package-lock.json` são ignorados. Para cada outro arquivo alterado, o backend escolhe o payload apropriado:

- arquivo novo: conteúdo completo;
- apenas staged: diff staged;
- apenas unstaged: diff unstaged;
- mudanças mistas: seções separadas para staged e unstaged;
- diff vazio: conteúdo completo como fallback.

Cada arquivo é processado de forma independente. Uma falha de leitura ou de IA não interrompe os demais e aparece no resultado final. Se todos os arquivos falharem antes de gerar tarefas, a operação termina sem criar o CSV.

Depois que a IA processa um arquivo, o backend confirma que seu conteúdo não mudou durante a geração. Se estiver intacto, executa o stage automático do arquivo completo. Se houver alteração concorrente ou falha no stage, as tarefas continuam no CSV, mas o arquivo é marcado como não staged e a falha é exibida. Conteúdo staged anterior nunca é sobrescrito silenciosamente por uma versão que mudou durante o processamento.

## CSV e Azure DevOps

O CSV é sempre escrito primeiro na raiz do repositório, com nome `tasks-dia-mês-hora-minuto.csv`. Sufixos `-1`, `-2` e assim por diante evitam sobrescrever um arquivo existente.

Campos fixos:

- `Work Item Type`: `Task`;
- `State`: `To Do`;
- `Activity`: `Development`;
- `Estimate Made`, `Remaining Work` e `Original Estimate`: a estimativa normalizada entre 1 e 8; valores inválidos viram 1.

Mapeamento de tipo para SPF:

| Tipo | ID SPF |
| --- | ---: |
| Backend | 17 |
| Frontend | 19 |
| Testes | 22 |

Mapeamento de complexidade para UST:

| Complexidade | UST |
| --- | ---: |
| BAIXA | 8 |
| MEDIA | 24 |
| ALTA | 40 |
| ÚNICA | 8 |

O CSV contém estas 16 colunas:

```text
ID, Work Item Type, Title, Assigned To, State, Area ID, Iteration ID,
Item Contrato, ID SPF, UST, Complexidade, Activity, Description,
Estimate Made, Remaining Work, Original Estimate
```

Na criação direta, o Azure recebe título, descrição, responsável, estado, área,
iteração, atividade, estimativa original e trabalho restante. `Item Contrato`,
`ID SPF`, `UST`, `Complexidade` e `Estimate Made` permanecem exclusivos do CSV.
IDs numéricos de Área e Iteração são resolvidos para os caminhos exigidos pelo
Azure antes da primeira criação.

O item pai é obrigatório na criação direta, é validado antes da primeira
criação e recebe cada Task como filha imediatamente após ela ser criada. Uma
Task não pode ser usada como pai. Os work items são criados sequencialmente; se
o Azure falhar, o CSV e o stage já realizados são preservados, os IDs criados
até aquele ponto são retornados e a falha é mostrada na interface. Nesse caso,
o Time Log combinado não é executado.

## Variáveis de ambiente

| Variável | Uso |
| --- | --- |
| `OPENAI_API_KEY` | Chave OpenAI usada quando a interface não recebe uma chave da sessão |
| `CODEX_MODEL` | Modelo opcional para o Codex CLI |
| `COMMIT_IA_TASK_CONFIG_DIR` | Diretório alternativo do `config.json` |
| `ADO_ORG` | Organização padrão do `timelog-bot` (slug ou URL do Azure DevOps) |
| `ADO_PAT` | PAT usado no Time Log Free; exclusivo com `ADO_TOKEN` |
| `ADO_TOKEN` | Token Microsoft Entra usado no Time Log Free; exclusivo com `ADO_PAT` |
| `ADO_USER_NAME` / `ADO_USER_ID` | Identidade explícita opcional; devem existir juntos |
| `ADO_EXTENSION_API_VERSION` | Versão da API da extensão; padrão `7.1-preview.1` |
| `ADO_TIMEOUT` | Timeout de cada requisição de Time Log, em segundos; padrão `30` |

## Desenvolvimento e testes

Execute `bun run validate` para conferir frontend, Rust e build local em sequência.
O CI usa os mesmos gates `validate:frontend` e `validate:rust` antes de gerar
os instaladores. Em trabalho paralelo, cada agente executa testes focados;
o responsável pela integração executa a validação completa ao final.

Para conferir **Minhas tarefas** e o plano em resoluções desktop e compacta,
use `bun run test:visual`. O roteiro usa dados simulados e salva capturas e
um relatório local; veja [preparação e execução](docs/testing/visual.md).

Frontend:

```bash
bun run test
bun run typecheck
bun run build
bun run check
bun run format
```

Backend Rust:

```bash
bun run check:rust         # Checagem rápida de todos os targets, sem gerar binários
bun run format:rust        # Aplica rustfmt
bun run format:rust:check  # Confere a formatação sem alterar arquivos
bun run lint:rust          # Clippy em todos os targets; avisos são erros
bun run test:rust          # Testes unitários, de integração e de documentação
bun run validate:rust      # Formatação, Clippy e testes; mesmo gate do CI
bun run bench:rust         # Benchmark local do planejador de horas em release
```

Execute esses atalhos na raiz do projeto. Eles usam o manifest em `src-tauri/`
e preservam o `Cargo.lock` com `--locked` nas operações de compilação e teste.
Para filtrar testes, use `bun run test:rust nome_do_teste`.

O `rust-toolchain.toml` seleciona o canal estável e declara rustfmt, Clippy e
rust-src para instalação pelo rustup. O canal acompanha o stable instalado,
sem fixar uma versão específica; atualize com `rustup update stable`.
No VS Code, instale a extensão `rust-lang.rust-analyzer`: o workspace já aponta
para `src-tauri/Cargo.toml`, formata Rust ao salvar e usa Clippy nos diagnósticos.

O benchmark usa somente dados em memória, sem acessar Git, IA ou Azure. Mede
cenários de uma semana, um ano e uma década, com 20, 1.000 e 10.000 trabalhos,
respectivamente, e informa a mediana de sete amostras por cenário. Cada trabalho
solicita 420 minutos; os cenários também exercitam a falta de capacidade.
Compare as medições na mesma máquina. Esses tempos representam o planejamento
local; a latência das integrações externas deve ser medida separadamente.

Os testes não fazem chamadas reais à OpenAI, ao Codex ou ao Azure. O adapter OpenAI usa um servidor HTTP local; em Unix, os adapters Codex e Azure usam executáveis falsos locais. Os testes de Git usam repositórios temporários locais, e os testes do frontend simulam a ponte Tauri.

Para gerar o aplicativo instalável:

```bash
bun run tauri build
```

O build local gera apenas os pacotes do sistema em uso. O workflow
`.github/workflows/build-desktop.yml` executa a matriz completa no GitHub
Actions e publica artefatos para:

- macOS Apple Silicon e Intel: `.app` e `.dmg`;
- Windows x64: `.msi` e instalador NSIS `.exe`.

No macOS, os artefatos usam assinatura ad-hoc e não são notarizados; no Windows,
eles não são assinados. Para distribuição pública sem avisos do sistema
operacional, configure os certificados Apple e Windows como segredos do
repositório. O instalador padrão do Windows baixa ou atualiza o WebView2 quando
necessário e, portanto, precisa de internet nesse cenário.

## Arquitetura

### Backend Rust

- `src-tauri/src/lib.rs`: inicialização do Tauri, plugins e registro de comandos;
- `src-tauri/src/commands.rs`: comandos expostos à interface e orquestração;
- `src-tauri/src/git.rs`: descoberta, diffs, validação e stage seguro;
- `src-tauri/src/ai.rs`: prompt, OpenAI e execução local do Codex;
- `src-tauri/src/export.rs`: CSV e criação de work items no Azure;
- `src-tauri/src/time_log.rs`: núcleo compartilhado da integração Time Log Free;
- `src-tauri/src/time_log/batch.rs`: planejamento puro do teto e da distribuição por período;
- `src-tauri/src/bin/timelog-bot.rs`: adaptador de terminal do registro de horas;
- `src-tauri/src/cli.rs` e `src-tauri/src/bin/infortech.rs`: adaptador de terminal para inspeção e geração de tarefas;
- `src-tauri/src/config.rs`: leitura e gravação da configuração;
- `src-tauri/src/process.rs`: execução segura de processos externos;
- `src-tauri/src/models.rs`: modelos serializados entre backend e frontend.

### Frontend React

- `src/App.tsx`: fluxo principal da interface;
- `src/TimeLogPanel.tsx`: formulário visual do registro de horas;
- `src/desktop.ts`: única ponte de comandos e eventos Tauri;
- `src/types.ts`: tipos compartilhados no lado React;
- `src/styles.css`: apresentação da aplicação;
- `src/App.test.tsx`: testes de comportamento da interface.

O frontend não executa comandos do sistema diretamente. Toda operação privilegiada atravessa a ponte tipada em `src/desktop.ts` e é validada novamente no backend Rust.
