# Commit IA Task

Sistema automatizado para geração de tarefas baseado em diferenças do Git usando Inteligência Artificial.

## 🚀 Funcionalidades

- Análise automática de arquivos alterados no Git
- Geração de tarefas usando OpenAI GPT-4o-mini
- Exportação para arquivo CSV compatível com ferramentas de gestão
- Sistema de logging avançado com diferentes níveis de verbosidade

## 📋 Requisitos

- Bun (runtime JavaScript)
- Git
- Conta cadastrada na plataforma OpenAI com créditos disponíveis: https://platform.openai.com/
- Chave da API OpenAI configurada

## 🛠 Instalação

```bash
bun install
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
commit-ia-task [--sprintId 123 --areaPathId 123 --assignedTo "Nome <email>" --itemContrato "Item 1"]
```

### Parâmetros

- `--sprintId`: ID do sprint (opcional quando já estiver salvo)
- `--areaPathId`: ID da área do projeto (opcional quando já estiver salvo)  
- `--assignedTo`: Pessoa responsável pelas tarefas (opcional, padrão: "Ygor Azambuja <ygor.azambuja@infortechms.com.br>")
- `--itemContrato`: Item de contrato para o CSV (opcional, padrão: "Item 1")

### 💾 Persistência de configuração

- O CLI salva `sprintId`, `areaPathId`, `assignedTo` e `itemContrato` em um arquivo de configuração persistente por sistema operacional.
- Em toda execução, os valores atuais são exibidos no terminal.
- Em terminal interativo, o comando sempre permite editar os três campos:
  - pressione `Enter` para manter o valor atual
  - digite um novo valor para atualizar e persistir
- Se você passar flags (`--sprintId`, `--areaPathId`, `--assignedTo`, `--itemContrato`), esses valores têm prioridade e também ficam salvos para as próximas execuções.

## 📊 Sistema de Logging

A aplicação possui um sistema de logging estruturado e colorido que fornece visibilidade completa do processo:

### 🎨 Níveis de Log

Configure o nível de logging através da variável de ambiente `LOG_LEVEL`:

```bash
# Logs básicos (padrão)
LOG_LEVEL=info bun run src/index.ts --sprintId "123" --areaPathId "456"

# Logs detalhados para debug
LOG_LEVEL=debug bun run src/index.ts --sprintId "123" --areaPathId "456"

# Apenas erros críticos  
LOG_LEVEL=error bun run src/index.ts --sprintId "123" --areaPathId "456"
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
📋 Configurações validadas { sprintId: "123", areaPathId: "456", assignedTo: "..." }
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
- `src/ai.ts`: Integração com OpenAI
- `src/csv.ts`: Geração de arquivos CSV
- `src/logger.ts`: Sistema de logging centralizado

## 🔧 Configuração

A aplicação suporta as seguintes variáveis de ambiente:

- `LOG_LEVEL`: Nível de logging (debug, info, warn, error)
- `OPENAI_API_KEY`: Chave da API OpenAI

## 📄 Saída

O sistema gera um arquivo CSV com as seguintes colunas:

- ID, Work Item Type, Title, Assigned To
- State, Area ID, Iteration ID, Item Contrato
- ID SPF, UST, Complexidade, Activity
- Description, Estimate Made, Remaining Work, Original Estimated

### Regras de preenchimento com IA

- `Complexidade` é gerada pela IA por tarefa e limitada a: `ALTA`, `MEDIA`, `BAIXA`, `ÚNICA`
- `Estimate Made` é gerado pela IA por tarefa como inteiro entre `1` e `8`
- `Remaining Work` e `Original Estimated` recebem o mesmo valor de `Estimate Made`
- Se `Estimate Made` vier inválido, o sistema aplica fallback para `1`

## 🤝 Contribuição

1. Fork o projeto
2. Crie uma branch para sua feature
3. Commit suas mudanças
4. Push para a branch
5. Abra um Pull Request
