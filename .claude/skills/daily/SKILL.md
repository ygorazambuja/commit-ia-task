---
name: daily
description: Lança a task "Daily" de hoje na PBI Institucional da sprint atual no Azure DevOps, com o resumo das tasks feitas no dia. Use quando o usuário pedir para lançar, registrar ou criar a daily / alinhamento diário, normalmente no fim do expediente.
---

# Daily

Roda `scripts/daily.ts`, que cria no Azure DevOps a task "Daily" do dia como filha da PBI Institucional da sprint. A reunião é às 8:30, mas o script roda no fim do dia: a descrição lista o que foi feito no dia em que ele é executado.

## Requisitos

- Bun, com `bun install` feito neste repositório.
- Azure CLI com a extensão `azure-devops`, autenticado com `az devops login`.

Se `bun` ou `az` não forem encontrados, diga ao usuário o que instalar em vez de tentar contornar.

## Como executar

Na raiz deste repositório:

```bash
bun run scripts/daily.ts
```

Invocar esta skill já é o pedido do usuário para criar a task: rode direto, sem `--dryRun`.

Flags opcionais (nenhuma é salva na config):

- `--dryRun`: só consulta o Azure e imprime a descrição que seria usada. Use quando o usuário pedir para conferir antes.
- `--sprintId <id ou caminho>`: outra sprint em vez da salva na config.
- `--pbi <id>`: PBI pai explícita, quando a busca não acha uma única PBI Institucional.

## O que o script faz

1. Lê `sprintId`, `areaPathId`, `assignedTo`, `itemContrato`, organização e projeto do `config.json` do commit-ia-task.
2. Acha a PBI da sprint cujo título contém "Institucional".
3. Se já existe uma task "Daily" de hoje nessa PBI para o mesmo responsável, não cria outra (pode rodar de novo sem duplicar).
4. Busca as tasks atribuídas ao responsável que foram alteradas hoje (qualquer sprint, exceto outras Dailies).
5. Cria a task: título `Daily`, estado `Done`, 1h, ID SPF 17, UST 1, complexidade BAIXA, e vincula à PBI. A descrição é `Reunião diária da SPxx.` seguida da lista "Atividades do dia" com link `#id`, título e estado de cada task.

Se rodar antes de lançar as tasks do dia (ex.: antes do `commit-ia-task --createAzureTasks`), elas ficam de fora, e uma segunda execução não atualiza a Daily já criada. Avise o usuário se ele pedir a daily cedo.

## Resultado

A última linha do log diz `Daily criada`, `Daily existente` ou `Daily simulada`, com `pbi` e `id`. Informe ao usuário o status e o ID.

Código de saída `1` em erro. Erros comuns:

- "Nenhuma PBI Institucional": a sprint salva está desatualizada ou a PBI ainda não foi criada. Pergunte ao usuário a sprint nova (`--sprintId`) ou o ID da PBI (`--pbi`).
- "Mais de uma PBI Institucional": peça ao usuário qual ID usar e rode de novo com `--pbi`.
- Erro de autenticação do `az`: o usuário precisa rodar `az login`.
