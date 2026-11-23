# Pacote de trabalho 05 — Aprofundar o ciclo de vida da credencial do Time Log

## Prioridade

P1 — correção de segurança e de **Locality**. Executar antes do pacote 06.

## Objetivo

Aprofundar a **Module** de credenciais do Time Log para que seleção da fonte,
validação, autenticação, redaction e decisão de persistência tenham um único dono.
Um PAT nunca pode ser persistido antes de ser aceito pela organização informada.

O resultado deve manter os dois **Adapters** reais: o comando Tauri e o
`timelog-bot`. A **Interface** pública definitiva ainda será decidida durante a
implementação; este pacote fixa comportamento e responsabilidades, não
assinaturas, traits ou factories.

## Contexto e evidências

- [`src-tauri/src/commands.rs:206`](../../src-tauri/src/commands.rs#L206) resolve a
  credencial do lançamento no Adapter Tauri.
- [`src-tauri/src/commands.rs:222`](../../src-tauri/src/commands.rs#L222) persiste
  um PAT explícito antes de construir o `TimeLogService` e antes de consultar
  `connectionData`. Uma credencial inválida pode substituir a credencial salva.
- [`src-tauri/src/commands.rs:251`](../../src-tauri/src/commands.rs#L251) contém a
  matriz credencial/tipo/PAT salvo, mas a política de ambiente está em outro arquivo.
- [`src-tauri/src/commands.rs:143`](../../src-tauri/src/commands.rs#L143) já usa a
  ordem correta em Configurações: verifica o PAT e só então tenta salvá-lo.
- [`src-tauri/src/config.rs:90`](../../src-tauri/src/config.rs#L90) lê o PAT separado;
  [`src-tauri/src/config.rs:114`](../../src-tauri/src/config.rs#L114) grava com
  permissão `0600` em Unix.
- [`src-tauri/src/time_log.rs:50`](../../src-tauri/src/time_log.rs#L50) evita
  `Debug` na credencial, resolve `ADO_PAT`/`ADO_TOKEN` e redige o segredo.
- [`src-tauri/src/time_log.rs:171`](../../src-tauri/src/time_log.rs#L171) rejeita
  `System:PublicAccess`, inclusive quando o Azure responde 200.
- [`src-tauri/src/time_log.rs:286`](../../src-tauri/src/time_log.rs#L286) autentica
  via `connectionData`; [`src-tauri/src/time_log.rs:303`](../../src-tauri/src/time_log.rs#L303)
  cria o documento somente depois de resolver a identidade.
- [`src-tauri/src/bin/timelog-bot.rs:105`](../../src-tauri/src/bin/timelog-bot.rs#L105)
  é o segundo Adapter e aceita credenciais somente pelo ambiente.
- [`AGENTS.md:196`](../../AGENTS.md#L196) exige verificação antes de persistir;
  [`AGENTS.md:207`](../../AGENTS.md#L207) define precedência, sigilo e ausência de
  retry automático para POST indeterminado.

Hoje, a **Interface** obriga o chamador a conhecer origem, pareamento entre tipo e
segredo, precedência e momento de persistir. Pelo **deletion test**, apagar
`time_log_credential` apenas espalha seu `match`; concentrar o ciclo completo faz
a política reaparecer nos dois Adapters caso a Module seja removida.

## Escopo

- Concentrar na Module existente de Time Log a seleção entre credencial explícita
  em memória, PAT salvo e variáveis de ambiente.
- Manter `config.rs` como implementação do armazenamento local, sem autenticação
  de rede dentro dele.
- Tornar Configurações o único fluxo que grava ou remove o PAT persistido.
- Remover de `create_time_log` a gravação implícita de uma credencial recebida
  somente para aquela execução.
- Garantir que um novo PAT seja verificado contra a organização atual antes da
  gravação feita por `save_app_settings`.
- Reduzir o conhecimento dos Adapters Tauri e CLI sobre a política de credenciais.
- Ajustar testes Rust afetados usando apenas fakes locais.

## Fora de escopo

- Alterar o protocolo ou o formato de documentos da extensão Time Log Free.
- Adicionar cofre do sistema operacional, criptografia ou nova dependência.
- Adicionar Graph/Profile scopes para obter e-mail.
- Persistir Bearer token, `ADO_TOKEN` ou credencial recebida pelo lançamento.
- Remover campos opcionais de credencial do DTO; permanecem por compatibilidade.
- Mover lógica privilegiada para React ou expor o PAT ao frontend.
- Criar trait/factory para uma única implementação HTTP ou de armazenamento.

## Invariantes

- O PAT fica somente em `time-log.json`, nunca em `SavedConfig`.
- Respostas, warnings, logs, erros e valores com `Debug` nunca contêm o segredo.
- Apenas PAT pode ser persistido; Bearer token permanece em memória.
- PAT novo só é salvo após `connectionData` confirmar identidade não pública para
  a mesma organização normalizada.
- Falha de verificação não altera um PAT previamente salvo.
- Configuração principal é salva antes de gravar/remover PAT.
- Falha posterior do PAT vira warning visível e não reabre o onboarding.
- Credencial explícita e tipo devem aparecer juntos.
- Sem credencial explícita, o desktop usa PAT salvo e depois o ambiente.
- `ADO_PAT` e `ADO_TOKEN` simultâneos continuam sendo erro.
- O Adapter CLI continua lendo somente o ambiente.
- `System:PublicAccess`/ID todo `a` nunca é autenticação válida.
- POST indeterminado não recebe retry automático.
- Time Log não altera `CompletedWork` nem `RemainingWork`.

## Plano de implementação em passos

1. Escrever testes de caracterização da matriz de fontes e do bug de persistência.
2. Levar seleção e validação de fonte para a Module existente em `time_log.rs`,
   reutilizando `TimeLogCredential`; manter a forma privada mínima necessária.
3. Fazer o Adapter Tauri fornecer somente os fatos disponíveis: credencial de
   execução opcional e PAT carregado. A Module decide precedência e conflitos.
4. Remover de `create_time_log` qualquer escrita em `time-log.json`; a credencial
   explícita vale apenas para aquela execução.
5. Manter mutação durável em `save_app_settings`: validar entrada, autenticar o PAT
   contra a organização normalizada e só então chamar o armazenamento existente.
6. Fazer o CLI atravessar a mesma política de ambiente, sem mudar argumentos nem
   imprimir valores de variáveis.
7. Apagar o helper raso e duplicações que perderem função após a concentração.
8. Rodar formatação, Clippy e testes Rust completos.

## Estratégia de testes

- Testar resolução explícita PAT/Bearer, PAT salvo e ambiente, incluindo ausência,
  pares incompletos e conflito de variáveis.
- Regressão: `create_time_log` com PAT explícito não cria nem substitui
  `time-log.json`, tanto em sucesso quanto em erro.
- Com servidor loopback, provar que PAT novo válido é autenticado e então salvo.
- Com servidor loopback, provar que 401, 403 e 200 com `System:PublicAccess` não
  persistem o PAT nem removem o anterior.
- Confirmar que erros e warnings não contêm segredo enviado ou salvo.
- Preservar testes de arquivo separado e `0600` em
  [`src-tauri/src/config.rs:201`](../../src-tauri/src/config.rs#L201).
- Preservar testes de redaction e identidade pública em
  [`src-tauri/src/time_log.rs:694`](../../src-tauri/src/time_log.rs#L694) e
  [`src-tauri/src/time_log.rs:779`](../../src-tauri/src/time_log.rs#L779).
- Nenhum teste acessa Azure real ou credenciais do desenvolvedor.

## Critérios de aceite

- Não existe caminho que persista PAT antes de autenticação explícita.
- `create_time_log` não modifica armazenamento de credenciais.
- `save_app_settings` preserva o PAT anterior quando o novo PAT é inválido.
- Precedência e conflitos são exercitados por uma única superfície de teste.
- Tauri e CLI preservam seus contratos de registro e preview.
- PAT não aparece em `SavedConfig`, DTOs de saída, warnings, logs ou erros.
- Nenhum trait, factory ou dependência sem dois **Adapters** reais foi introduzido.
- Formatação, Clippy com warnings negados e todos os testes Rust passam.

## Coordenação entre agentes

- Este agente possui `src-tauri/src/time_log.rs` e as regiões Time Log de
  `src-tauri/src/commands.rs` (identificação, lançamento e credencial).
- Evitar alterar `src-tauri/src/config.rs`; consumir as funções de store existentes.
  Mudança imprescindível deve ser combinada com o agente 06.
- O agente 06 também tocará `save_app_settings`; integrar este pacote primeiro e
  fazer o agente 06 rebasear sobre ele.
- O pacote 06 deve preservar estes testes de segurança e tratar PAT verificado
  como etapa posterior ao save principal.
- Os pacotes 01, 03 e 04 não dependem deste trabalho; o pacote 02 integra
  `commands.rs` somente depois que 05 e 06 estiverem concluídos.

## Riscos

- Reordenar efeitos pode apagar/substituir PAT válido após falha parcial; iniciar
  os testes com PAT anterior e verificar o conteúdo final.
- Uma abstração genérica de provedor de credenciais criaria uma **Seam**
  hipotética; manter a **Module** concreta enquanto só existem as fontes conhecidas.
- Reautenticar duas vezes aumenta latência; reutilizar o resultado existente se
  possível, sem ampliar a **Interface** pública só para otimização.
- Testes que alteram ambiente podem interferir; serializar apenas esses casos ou
  testar a decisão com valores injetados internamente.
