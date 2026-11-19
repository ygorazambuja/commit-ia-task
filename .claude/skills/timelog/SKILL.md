---
name: timelog
description: Registra horas trabalhadas na aba "Time Log Free" de um work item (task) do Azure DevOps. Use quando o usuário pedir para lançar, apontar ou registrar horas/tempo em uma task.
---

# Timelog

Roda `scripts/timelog.ts`, que cria uma linha na aba **Time Log Free** (extensão `TimeLog.time-logging-extension`) de um work item. Não altera `CompletedWork`, `RemainingWork` nem outros campos da task.

## Requisitos

- Bun, com `bun install` feito neste repositório.
- Azure CLI com a extensão `azure-devops`, autenticado com `az devops login` (PAT com escopo Extension Data read & write).

Se `bun` ou `az` não forem encontrados, diga ao usuário o que instalar em vez de tentar contornar.

## Como executar

Na raiz deste repositório:

```bash
bun run scripts/timelog.ts <workItemId> --hours 2 --minutes 30 --type Frontend --comment "Implementei os indexadores financeiros"
```

- `<workItemId>`: ID da task. Obrigatório.
- `--hours` / `--minutes`: duração; minutos de 0 a 59; o total precisa ser maior que zero.
- `--type`: `Backend` ou `Frontend` (sem diferenciar maiúsculas). Obrigatório.
- `--comment`: o que foi feito. Obrigatório.
- `--date YYYY-MM-DD`: dia do trabalho; padrão é hoje.
- `--dryRun`: só mostra o documento que seria gravado.

Se faltar task, duração, tipo ou comentário no pedido, pergunte ao usuário antes de rodar. Não invente o tipo: se a task for de testes ou outra coisa, pergunte qual dos dois usar.

## Cuidados

- **Não é idempotente:** cada execução cria uma linha nova. Não rode de novo para "confirmar".
- Se der erro de rede durante o envio, o lançamento pode ter sido criado mesmo assim. Peça ao usuário para conferir a aba Time Log Free antes de repetir.
- A identidade gravada é a do `az devops login` (descoberta com `@Me`). Se der erro de autenticação, o usuário precisa rodar `az devops login`.

## Resultado

Sucesso imprime `registrado: 2h30min em #<id> no dia <data> como <tipo> (documento <id>)`. Repasse isso ao usuário. Código de saída `1` em erro, com a mensagem após `erro:`.
