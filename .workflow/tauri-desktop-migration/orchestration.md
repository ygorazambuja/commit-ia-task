# Orchestration: Tauri desktop migration

## Execution Rules

- Keep the original objective intact.
- Ask for approval before risky, expensive, external, or destructive actions.
- Keep immediate blocking work local.
- Delegate only bounded, disjoint, materially useful packets.
- Integrate packet results before final verification.

## Branching Rules

- Se a API oficial divergir da implementação antiga, preservar o contrato do
  usuário e adaptar apenas o transporte.
- Se uma CLI externa não estiver instalada, retornar erro acionável pela UI e
  cobrir o comando por teste com executor falso.
- Se o build de bundle exigir assinatura, validar com `--no-bundle`.
- Não manter duas implementações de produção para a mesma regra.

## Packet Prompts

- P1: mapear comportamento, contratos e casos-limite dos módulos TypeScript.
- P2: confirmar scaffolding/configuração Tauri 2 + React e APIs necessárias.
- P3: propor testes mínimos que provem paridade e segurança operacional.
- P4: substituir a aplicação e integrar todos os resultados aceitos.
- P5: revisar o diff, executar verificações e apontar falhas concretas.

## Completion Audit

- Todos os critérios do plano têm evidência executável.
- Nenhum segredo, artefato de build ou CSV gerado entrou no repositório.
- A aplicação inicia e o frontend consegue invocar os comandos registrados.
- README descreve desenvolvimento, configuração e uso desktop.
