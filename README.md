# Commit IA Task

Sistema automatizado para geração de tarefas baseado em diferenças do Git usando Inteligência Artificial.

## 🚀 Funcionalidades

- Análise automática de arquivos alterados no Git
- Geração de tarefas usando OpenAI (API key) ou Codex (assinatura ChatGPT)
- Exportação para arquivo CSV compatível com ferramentas de gestão
- Sistema de logging avançado com diferentes níveis de verbosidade

## 📋 Requisitos

- Bun (runtime JavaScript)
- Git
- Azure CLI com extensão Azure DevOps (`az extension add --name azure-devops`) para criação direta de tarefas
- Provedor de IA escolhido via `--aiProvider`:
  - `openai` (padrão): conta na plataforma OpenAI com créditos e `OPENAI_API_KEY`
  - `codex`: Codex CLI instalado e autenticado com `codex login` (assinatura ChatGPT)

## 🛠 Instalação

```bash
bun install

# Verificar tipos e executar testes
bun run typecheck
bun test
```

### ⚙️ Configuração Específica do Windows

Se estiver usando Windows, é necessário configurar a pasta `C:\bin\` nas variáveis de ambiente para que o executável do Bun esteja no PATH do PowerShell/cmd.

**Primeiro, crie a pasta `C:\bin\` se ela não existir.**

1. Pressione `Win + R`, digite `sysdm.cpl` e pressione Enter
2. Na aba "Avançado", clique em "Variáveis de Ambiente"
3. Na seção "Variáveis do sistema", selecione "Path" e clique em "Editar"
4. Clique em "Novo" e adicione: `C:\bin\`
5. Clique em "OK" para salvar as alterações
6. Reinicie o terminal/PowerShell para aplicar as mudanças

## 🎯 Uso

```bash
commit-ia-task [--sprintId "Projeto\\Sprint 1" --areaPathId "Projeto\\Area" --assignedTo "Nome <email>" --itemContrato "Item 1" --aiProvider openai|codex] [--createAzureTasks --azureOrganization https://dev.azure.com/org --azureProject "Projeto"]
```

### Provedor de IA

```bash
# OpenAI via API key (padrão)
bun run src/index.ts --aiProvider openai --sprintId "123" --areaPathId "456"

# Codex via assinatura (após codex login)
bun run src/index.ts --aiProvider codex --sprintId "123" --areaPathId "456"
```

### Criar tarefas no Azure DevOps

```bash
bun run src/index.ts \
  --aiProvider codex \
  --sprintId "Projeto\\Sprint 1" \
  --areaPathId "Projeto\\Area" \
  --createAzureTasks \
  --azureOrganization "https://dev.azure.com/minha-org" \
  --azureProject "Meu Projeto"
```

O CSV continua sendo gerado. Com `--createAzureTasks`, o CLI também executa `az boards work-item create` para cada tarefa gerada. `--azureOrganization` e `--azureProject` são opcionais se já estiverem salvos na config do Commit IA Task ou configurados no Azure CLI com:

```bash
az devops configure --defaults organization=https://dev.azure.com/minha-org project="Meu Projeto"
```

### Parâmetros

- `--sprintId`: Sprint/iteration path usado no CSV e no `az boards work-item create --iteration` (opcional quando já estiver salvo)
- `--areaPathId`: Area path usado no CSV e no `az boards work-item create --area` (opcional quando já estiver salvo)
- `--assignedTo`: Pessoa responsável pelas tarefas (opcional, padrão: "Ygor Azambuja <ygor.azambuja@infortechms.com.br>")
- `--itemContrato`: Item de contrato para o CSV (opcional, padrão: "Item 1")
- `--aiProvider`: Provedor de IA (`openai` ou `codex`, padrão: `openai`)
- `--createAzureTasks`: Cria as tarefas diretamente no Azure DevOps após gerar o CSV
- `--azureOrganization`: URL da organização Azure DevOps, por exemplo `https://dev.azure.com/minha-org`
- `--azureProject`: Nome ou ID do projeto Azure DevOps

### 💾 Persistência de configuração

- O CLI salva `sprintId`, `areaPathId`, `assignedTo`, `itemContrato`, `azureOrganization` e `azureProject` em um arquivo de configuração persistente por sistema operacional.
- Quando não há valor salvo para `azureOrganization` ou `azureProject`, o CLI tenta iniciar esses campos a partir de `az devops configure -l`.
- Em toda execução, os valores atuais são exibidos no terminal.
- Em terminal interativo, o comando sempre permite editar os campos salvos:
  - pressione `Enter` para manter o valor atual
  - digite um novo valor para atualizar e persistir
- Se você passar flags (`--sprintId`, `--areaPathId`, `--assignedTo`, `--itemContrato`, `--azureOrganization`, `--azureProject`), esses valores têm prioridade e também ficam salvos para as próximas execuções.

## 📊 Sistema de Logging

A aplicação possui um sistema de logging estruturado e colorido que fornece visibilidade completa do processo:

### 🎨 Níveis de Log

Configure o nível de logging através da variável de ambiente `LOG_LEVEL`:

```bash
# Logs básicos (padrão)
LOG_LEVEL=info bun run src/index.ts --sprintId "123" --areaPathId "456" --itemContrato "Item 1"

# Logs detalhados para debug
LOG_LEVEL=debug bun run src/index.ts --sprintId "123" --areaPathId "456" --itemContrato "Item 1"

# Apenas erros críticos  
LOG_LEVEL=error bun run src/index.ts --sprintId "123" --areaPathId "456" --itemContrato "Item 1"
```

### 📝 Tipos de Log

**🚀 Inicialização**
- Validação de parâmetros
- Configurações da aplicação

**🔍 Análise Git**
- Detecção de arquivos alterados/novos
- Contagem de arquivos encontrados
- Filtragem de arquivos ignorados

**🤖 Processamento IA**
- Início do processamento por arquivo
- Tempo de resposta da API
- Número de tarefas geradas
- Detalhes das tarefas criadas

**📝 Geração CSV**
- Preparação dos dados
- Estatísticas do arquivo gerado
- Caminho do arquivo resultante

**❌ Tratamento de Erros**
- Erros de API da OpenAI
- Problemas de acesso a arquivos
- Falhas na geração do CSV

### 🔧 Características do Sistema de Logging

- **Timestamps**: Cada log inclui timestamp preciso
- **Cores**: Interface colorida para melhor legibilidade
- **Emojis**: Identificação visual rápida do tipo de operação
- **Estruturação**: Dados estruturados em JSON para facilitar análise
- **Performance**: Medição de tempo de execução para operações críticas
- **Contextualização**: Informações relevantes para cada operação

### 📈 Exemplos de Saída

```
🚀 Iniciando aplicação Commit IA Task
📋 Configuração atual { sprintId: "123", areaPathId: "456", assignedTo: "...", itemContrato: "Item 1", configFile: "..." }
📋 Configurações validadas { sprintId: "123", areaPathId: "456", assignedTo: "...", itemContrato: "Item 1" }
🔍 Iniciando análise de arquivos alterados { gitFolder: "/path/to/project" }
📁 Arquivos encontrados { count: 3, files: ["src/index.ts", "src/api.ts", "README.md"] }
🤖 Iniciando criação de tasks para arquivo { fileName: "src/index.ts" }
✅ Tasks geradas com sucesso { fileName: "src/index.ts", tasksCount: 2, tasks: [...] }
📝 Gerando arquivo CSV...
✅ Arquivo CSV gerado com sucesso { fileName: "tasks-15-12-14-30.csv", recordsWritten: 5 }
✅ Processo finalizado com sucesso!
```

## 🏗 Arquitetura

- `src/index.ts`: Ponto de entrada principal
- `src/git.ts`: Análise de diferenças do Git
- `src/ai.ts`: Roteamento entre provedores de IA
- `src/ai-codex.ts`: Integração com Codex SDK
- `src/ai-provider.ts`: Seleção e validação do provedor
- `src/csv.ts`: Geração de arquivos CSV
- `src/logger.ts`: Sistema de logging centralizado

## 🔧 Configuração

A aplicação suporta as seguintes variáveis de ambiente:

- `LOG_LEVEL`: Nível de logging (debug, info, warn, error)
- `OPENAI_API_KEY`: Chave da API OpenAI (obrigatória com `--aiProvider openai`)
- `CODEX_MODEL`: Modelo opcional para o Codex (usa config do usuário se omitido)
- `COMMIT_IA_TASK_CONFIG_DIR`: Diretório opcional para sobrescrever o local do `config.json`

## 📄 Saída

O sistema gera um arquivo CSV com as seguintes colunas:

- ID, Work Item Type, Title, Assigned To
- State, Area ID, Iteration ID, Item Contrato
- ID SPF, UST, Complexidade, Activity
- Description, Estimate Made, Remaining Work, Original Estimate

### Regras de preenchimento com IA

- `Complexidade` é gerada pela IA por tarefa e limitada a: `ALTA`, `MEDIA`, `BAIXA`, `ÚNICA`
- `Estimate Made` é gerado pela IA por tarefa como inteiro entre `1` e `8`
- `Remaining Work` e `Original Estimate` recebem o mesmo valor de `Estimate Made`
- Se `Estimate Made` vier inválido, o sistema aplica fallback para `1`

## 🤝 Contribuição

1. Fork o projeto
2. Crie uma branch para sua feature
3. Commit suas mudanças
4. Push para a branch
5. Abra um Pull Request
