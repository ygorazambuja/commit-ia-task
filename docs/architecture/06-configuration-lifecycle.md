# Pacote de trabalho 06 — Aprofundar o ciclo de vida da configuração

## Prioridade

P2 — melhoria estrutural. Executar depois do pacote 05.

## Objetivo

Transformar `config.rs` de uma coleção de operações de store em uma **Module**
profunda que possua abertura, compatibilidade, reparo, atualização estável,
persistência e classificação de warnings. Os Adapters Tauri devem receber
**Leverage** sem reproduzir ordem, defaults e modos de falha.

Este pacote fixa os fluxos observáveis, mas não congela nomes, assinaturas ou
tipos auxiliares. Escolher a menor **Interface** durante a implementação e não
criar traits/factories para a única store existente.

## Contexto e evidências

- [`src-tauri/src/config.rs:12`](../../src-tauri/src/config.rs#L12) resolve o
  caminho, enquanto [`src-tauri/src/config.rs:38`](../../src-tauri/src/config.rs#L38)
  e [`src-tauri/src/config.rs:64`](../../src-tauri/src/config.rs#L64) carregam e
  salvam valores já preparados pelo chamador.
- [`src-tauri/src/commands.rs:53`](../../src-tauri/src/commands.rs#L53) conhece
  caminho, fallback, reparo, onboarding, warning de leitura e estado do PAT.
- [`src-tauri/src/commands.rs:117`](../../src-tauri/src/commands.rs#L117) repete
  caminho, fallback após corrupção, merge, ordem de gravação e severidade distinta
  para falha principal e falha posterior do PAT.
- [`src-tauri/src/commands.rs:325`](../../src-tauri/src/commands.rs#L325) implementa
  uma terceira política: falha ao persistir durante geração é não fatal e vira
  `GenerationResult.warnings`.
- [`src-tauri/src/commands.rs:523`](../../src-tauri/src/commands.rs#L523) mantém
  validação, merge estável, normalização, reparo e completude fora de `config.rs`.
- [`src-tauri/src/models.rs:24`](../../src-tauri/src/models.rs#L24) mantém
  compatibilidade por defaults Serde e define os campos não secretos.
- [`AGENTS.md:74`](../../AGENTS.md#L74) preserva a localização legada e
  [`AGENTS.md:80`](../../AGENTS.md#L80) define o conteúdo persistente e a separação
  do PAT.
- [`AGENTS.md:82`](../../AGENTS.md#L82) define precedência dos defaults e reparo;
  [`AGENTS.md:97`](../../AGENTS.md#L97) distingue warnings de abertura e geração.
- [`AGENTS.md:172`](../../AGENTS.md#L172) descreve startup e
  [`AGENTS.md:196`](../../AGENTS.md#L196) fixa a ordem do save principal e PAT.

Pelo **deletion test**, remover `config.rs` espalharia Store, fechamento de
recursos e permissão de arquivo; ela já entrega algum **Leverage**. Porém, sua
**Interface** ainda faz três chamadores conhecerem a maior parte da
**Implementation** do ciclo de vida, reduzindo **Locality**.

## Escopo

- Concentrar resolução de caminhos, leitura compatível, diagnóstico de corrupção,
  defaults, completude e preparação para onboarding em `config.rs`.
- Concentrar atualização de campos estáveis sem apagar repositório, Sprint, Área
  e Item de contrato.
- Representar na Module as políticas de startup/reparo, save de Configurações e
  save não fatal durante geração.
- Integrar o estado configurado do PAT sem carregar seu valor para DTOs de saída.
- Preservar o contrato serializado de `SavedConfig`, `InitialState`,
  `SaveAppSettingsResult` e `GenerationResult`.
- Enxugar `commands.rs` para adaptação Tauri, checks externos assíncronos e
  composição dos DTOs.
- Atualizar testes Rust e testes de UI que cobrem warnings.

## Fora de escopo

- Alterar campos persistidos ou criar versão/migração de configuração.
- Trocar `tauri-plugin-store`, mover arquivos ou adotar banco de dados.
- Persistir chave OpenAI, toggle de Azure direto ou item pai.
- Importar organização/projeto de `az devops configure -l`.
- Mudar o layout das telas de onboarding/Configurações.
- Reprojetar autenticação do Time Log; isso pertence ao pacote 05.
- Criar uma Seam genérica de storage com um único Adapter.

## Invariantes

- A localização legada de `config.json` e `COMMIT_IA_TASK_CONFIG_DIR` permanece.
- Defaults Serde continuam lendo configurações legadas sem migração manual.
- Configuração completa salva vence defaults fixos.
- Configuração ausente, incompleta ou corrompida exige onboarding/reparo.
- Corrupção gera warning visível e usa defaults; não é silenciosa.
- Defaults de reparo continuam sendo perfil Infortech, organização canônica e
  projeto `SPF-SIAFIC`.
- Não existe marcador de versão do onboarding.
- Responsável é persistido como `Nome <email corporativo>`.
- Organização é persistida como `https://dev.azure.com/<org>` canônica.
- Save de Configurações mescla somente campos estáveis e preserva os operacionais.
- Falha do save principal mantém Configurações abertas e impede mutação do PAT.
- Após save principal bem-sucedido, falha de PAT é warning e onboarding termina.
- Falha de save durante geração não interrompe geração e aparece no resultado.
- PAT permanece em arquivo separado e nunca integra estruturas serializadas.
- Stores são fechadas inclusive após falha de leitura, deserialize ou save.
- O frontend continua mostrando warnings de startup, Configurações e geração.

## Plano de implementação em passos

1. Caracterizar com testes os fluxos ausente, completo, incompleto e corrompido,
   além das políticas diferentes de falha de gravação.
2. Mover para `config.rs` a preparação carregada: compatibilidade, defaults,
   normalização, perfil e onboarding. Passar prontidão dos provedores como fatos;
   não executar subprocessos dentro da Module.
3. Mover o merge estável para a mesma Module. Manter validação no backend Rust e
   evitar expor mutabilidade desnecessária ao Adapter.
4. Encapsular o save de Configurações com ordem explícita: configuração principal
   obrigatória; operação de PAT já verificado depois; resultado contém somente
   status booleano e warnings sem segredo.
5. Encapsular o save de geração como operação best effort que devolve warning sem
   converter falha em erro da geração.
6. Simplificar `get_initial_state`, `save_app_settings` e `run_generation` para
   consumir esses resultados e montar os DTOs existentes.
7. Remover helpers e ramificações duplicadas de `commands.rs` somente depois que
   seus testes atravessarem a nova Interface.
8. Rodar validação Rust e testes frontend que confirmam exibição de warnings.

## Estratégia de testes

- Testar caminho padrão e override por `COMMIT_IA_TASK_CONFIG_DIR` em diretório
  temporário, sem gravar na configuração real do usuário.
- Testar configuração ausente, completa, incompleta, JSON inválido e campo com tipo
  inválido; confirmar defaults, onboarding e warning apropriados.
- Confirmar que arquivo corrompido não é regravado durante leitura, preservando
  [`src-tauri/src/config.rs:265`](../../src-tauri/src/config.rs#L265).
- Testar merge estável preservando repositório, Sprint, Área e Item de contrato.
- Testar que falha no save principal não executa gravação/remoção do PAT.
- Testar que falha posterior de PAT retorna sucesso com warning e estado coerente.
- Testar geração com save impossível: processamento segue e warning é incluído.
- Confirmar ausência de PAT, chave OpenAI, toggle Azure e item pai no JSON e DTOs.
- Preservar teste Unix de permissão `0600` da store de PAT.
- Em React, preservar cobertura de warnings carregados em
  [`src/App.tsx:217`](../../src/App.tsx#L217), Configurações em
  [`src/App.tsx:491`](../../src/App.tsx#L491) e geração em
  [`src/App.tsx:1266`](../../src/App.tsx#L1266).
- Nenhum teste acessa Azure, OpenAI, Codex ou configuração real.

## Critérios de aceite

- Abertura, reparo, merge e persistência ficam concentrados em `config.rs`, com
  Interface menor que a coordenação atual.
- Os três comandos deixam de montar manualmente warnings e ordem de persistência.
- Cada falha mantém a fatalidade prevista nas invariantes.
- Configurações legadas carregam e configurações completas não são sobrescritas.
- Nenhum segredo novo é persistido ou serializado.
- O código removido de `commands.rs` supera qualquer boilerplate acrescentado;
  nenhuma trait, factory ou dependência hipotética é criada.
- Frontend continua exibindo todos os warnings nos locais atuais.
- Formatação, Clippy, testes Rust e testes frontend relevantes passam.

## Coordenação entre agentes

- Este agente possui `src-tauri/src/config.rs` e as regiões de configuração de
  `src-tauri/src/commands.rs`: startup, save, persistência da geração e helpers.
- O pacote 05 deve ser integrado primeiro. Preservar a decisão de que
  `create_time_log` não grava PAT e reutilizar a operação de PAT verificado.
- Não alterar autenticação, redaction ou protocolo em `time_log.rs`; dúvidas de
  segurança voltam ao agente 05.
- Como ambos tocam `save_app_settings` e `commands.rs`, não editar no mesmo
  checkout em paralelo; rebasear o pacote 06 sobre o 05 antes de começar.
- O pacote 02 tocará `run_generation` e deve ser integrado somente depois deste
  pacote; aqui, limitar a mudança ao trecho de persistência e warnings.
- Mudanças em DTOs exigem coordenação com `src/types.ts`, mas não são esperadas.

## Riscos

- Uma Module grande demais pode absorver validação de IA ou UI sem ganhar Depth;
  manter subprocessos e apresentação fora dela.
- Ao unificar warnings, é fácil trocar falha não fatal por fatal ou o inverso;
  testar cada ponto de falha observável antes da movimentação.
- Ler o PAT apenas para status pode vazar o valor por erro derivado; retornar
  somente presença e mensagens redigidas.
- Testes de ambiente e permissões variam por plataforma; isolar estado global e
  manter asserts Unix sob `cfg(unix)`.
- Refatorar DTOs junto com o ciclo de vida amplia conflitos sem necessidade;
  preservar os contratos até surgir evidência concreta.
