# Pacote de trabalho 04 — Seam dos provedores OpenAI e Codex

## Prioridade

P1 — consistência de configuração, testabilidade e evolução dos provedores.

## Objetivo

Aprofundar a **Module** de IA para que catálogo, capacidades, prontidão, validação e política de execução pertençam à **Seam** já real entre os dois **Adapters**, OpenAI e Codex. Os chamadores devem pedir geração de tarefas e consultar capacidades sem conhecer todos os parâmetros específicos de ambos.

O ganho esperado é **Leverage** para inicialização, configurações e geração, com **Locality** para alterar modelos, esforço do Codex, requisitos de autenticação e concorrência sem sincronizar regras espalhadas em Rust e React.

## Contexto e evidências

- O produto oferece OpenAI ou uma sessão local do Codex para gerar tarefas em português brasileiro ([README.md:3](../../README.md#L3), [README.md:89](../../README.md#L89)).
- A arquitetura exige que chamadas de IA e processos permaneçam no Rust ([AGENTS.md:14](../../AGENTS.md#L14)) e atribui prompt, schema e os dois **Adapters** a `ai.rs` ([AGENTS.md:123](../../AGENTS.md#L123)).
- `generate_tasks` recebe provedor, arquivo, diff, repositório, chave, modelo e esforço do Codex mesmo quando parte dos argumentos não se aplica ao provedor escolhido ([src-tauri/src/ai.rs:47](../../src-tauri/src/ai.rs#L47)).
- O catálogo e o esforço aceito vivem em funções de `ai.rs` ([src-tauri/src/ai.rs:13](../../src-tauri/src/ai.rs#L13)), enquanto defaults e configuração persistida vivem em `models.rs` ([src-tauri/src/models.rs:12](../../src-tauri/src/models.rs#L12), [src-tauri/src/models.rs:24](../../src-tauri/src/models.rs#L24)).
- `commands.rs` conhece separadamente detecção, preferência de onboarding, validação, configuração e autenticação do Codex ([src-tauri/src/commands.rs:68](../../src-tauri/src/commands.rs#L68), [src-tauri/src/commands.rs:588](../../src-tauri/src/commands.rs#L588), [src-tauri/src/commands.rs:609](../../src-tauri/src/commands.rs#L609), [src-tauri/src/commands.rs:695](../../src-tauri/src/commands.rs#L695)).
- A política de concorrência também está no comando: Codex usa dois jobs e OpenAI usa um ([src-tauri/src/commands.rs:26](../../src-tauri/src/commands.rs#L26), [src-tauri/src/commands.rs:340](../../src-tauri/src/commands.rs#L340)).
- O frontend repete os literais dos modelos e esforços nos tipos e nas opções da tela ([src/types.ts:1](../../src/types.ts#L1), [src/SettingsPanel.tsx:490](../../src/SettingsPanel.tsx#L490)).
- O gate de envio também interpreta diretamente requisitos específicos de cada provedor ([src/App.tsx:391](../../src/App.tsx#L391)).
- Existem testes locais adequados para os dois **Adapters**: servidor loopback para OpenAI e executável falso para Codex ([src-tauri/src/ai.rs:393](../../src-tauri/src/ai.rs#L393), [src-tauri/src/ai.rs:568](../../src-tauri/src/ai.rs#L568)).

Pelo **deletion test**, apagar `ai.rs` espalharia prompt, schema, HTTP, execução do Codex e parsing. A **Module** já merece existir; falta aumentar sua **Depth** absorvendo a política que os chamadores ainda precisam coordenar.

Não há `CONTEXT.md` nem ADRs no estado atual. Este pacote preserva as decisões normativas de `AGENTS.md` e não cria uma nova camada apenas por organização.

## Escopo

- Centralizar em Rust o catálogo de provedores, modelos, defaults, opções específicas e requisitos de prontidão.
- Fazer a **Module** de IA validar uma seleção completa e revalidar prontidão no momento da geração.
- Mover para a mesma **Module** a preferência de onboarding e a concorrência por provedor.
- Reduzir argumentos inaplicáveis na Interface de geração, sem fixar neste pacote documental o formato final do tipo de seleção.
- Expor ao frontend dados suficientes para renderizar provedores, modelos, esforços e status sem manter um segundo catálogo manual.
- Preservar compatibilidade de `SavedConfig` e atualizar DTOs espelhados quando necessário.
- Ajustar testes Rust e frontend afetados.

## Fora de escopo

- Adicionar um terceiro provedor, novos modelos ou descoberta remota de modelos.
- Trocar o prompt, o schema de tarefas ou as regras de normalização.
- Alterar as garantias do OpenAI (`store: false`) ou do Codex (efêmero,
  read-only e aprovação `never`).
- Persistir a chave OpenAI ou expor credenciais/status sensíveis ao frontend.
- Criar trait/factory para `reqwest`, `run_process` ou qualquer **Adapter** único.
- Criar registro dinâmico de plugins; OpenAI e Codex são o conjunto conhecido.
- Reestruturar toda a execução ponta a ponta do pacote 02.

## Invariantes

- OpenAI aceita a chave somente em memória, com precedência sobre
  `OPENAI_API_KEY`; a chave nunca entra em `SavedConfig`, respostas ou logs.
- Codex exige executável disponível e `codex login status` válido, inclusive uma
  nova verificação no momento da geração.
- Setup novo ou de reparo prefere Codex quando autenticado; caso contrário usa
  OpenAI. Se nenhum estiver pronto, mantém OpenAI e permite salvar configurações.
- Configuração completa já salva preserva o provedor escolhido.
- Modelo deve pertencer ao provedor; esforço de raciocínio só se aplica ao Codex.
- OpenAI continua com saída estruturada, `store: false` e timeout contextual.
- Codex continua efêmero, read-only, nunca aprova e recebe prompt/schema por
  argumentos e stdin sem shell.
- Respostas dos dois **Adapters** produzem as mesmas tarefas normalizadas.
- Falha de um arquivo continua isolada; ordem dos resultados é preservada.
- Política atual permanece: concorrência 1 para OpenAI e 2 para Codex, até
  medição que justifique mudança.
- A UI pode antecipar gates para boa experiência, mas Rust repete toda validação
  antes de operações privilegiadas.

As regras normativas estão em
[AGENTS.md:64](../../AGENTS.md#L64),
[AGENTS.md:99](../../AGENTS.md#L99) e
[AGENTS.md:203](../../AGENTS.md#L203).

## Plano de implementação em passos

1. Inventariar informações comuns e específicas: identificação, nome de exibição,
   modelos, default, esforço, credencial, prontidão, mensagem de pendência e
   concorrência.
2. Antes de codificar, escolher a menor **Interface** que represente uma seleção
   válida. Manter abertas as opções de enum com dados por variante, value object
   validado ou outro formato simples; evitar uma lista longa de parâmetros
   opcionais.
3. Concentrar catálogo, defaults e validação em `ai.rs` ou em tipos de domínio
   adjacentes já existentes. Não abrir novos arquivos sem ganho de **Locality**.
4. Fazer a consulta de capacidades/prontidão usar essa fonte e adaptar o resultado
   no comando de estado inicial. A forma exata do DTO permanece uma decisão de
   implementação, desde que o React não replique o catálogo.
5. Mover preferência inicial, verificação Codex e concorrência por provedor para
   a **Module** de IA; deixar `commands.rs` apenas orquestrar e converter erros.
6. Adaptar a geração para receber uma seleção coerente e despachar aos dois
   **Adapters**. Preservar enum dispatch se ele for suficiente; trait só é
   justificável se melhorar a Interface real dos dois Adapters e seus testes.
7. Renderizar opções no frontend a partir das capacidades recebidas. Manter
   estado específico do Codex apenas quando aplicável e a chave OpenAI somente no
   formulário em memória.
8. Remover catálogos literais duplicados e helpers pass-through após aplicar o
   **deletion test**.
9. Atualizar testes de compatibilidade e executar os gates Rust e frontend.

Decisões de **Interface** deixadas abertas: formato da seleção validada, formato
dos descritores enviados ao React e uso de enum versus trait na **Seam** dos dois
Adapters. Escolher pelo menor conhecimento exigido dos chamadores, não por
extensibilidade hipotética.

## Estratégia de testes

- Testar uma matriz única de modelos/defaults/opções por provedor pela nova
  Interface, incluindo combinações inválidas.
- Testar prontidão OpenAI com chave explícita, ambiente e valores vazios.
- Testar Codex disponível/autenticado, disponível sem login e ausente com
  executáveis falsos; nenhuma chamada real.
- Testar a matriz de preferência do onboarding e preservação da configuração
  completa existente.
- Testar que a política de concorrência selecionada chega à pipeline sem o
  comando conhecer detalhes de cada provedor.
- Preservar os testes loopback do request OpenAI, incluindo authorization,
  schema e `store: false`.
- Preservar os testes do Codex para modelo, esforço, stdin, schema, sandbox e
  aprovação.
- No frontend, comprovar que capacidades recebidas renderizam as opções, que
  campos específicos alternam corretamente e que os gates/status continuam em
  português brasileiro.
- Verificar round-trip e defaults de configurações legadas sem novos campos.
- Gates: `bun run test`, `bun run typecheck`, `bun run build`,
  `cargo fmt --manifest-path src-tauri/Cargo.toml --check`,
  `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings`
  e `cargo test --manifest-path src-tauri/Cargo.toml --locked`.

## Critérios de aceite

- Existe uma única fonte Rust para catálogo, defaults, validação, prontidão e
  concorrência dos provedores.
- O frontend não mantém listas manuais de IDs de modelos ou esforços divergentes
  da fonte Rust.
- `commands.rs` não precisa combinar parâmetros específicos de OpenAI e Codex
  para chamar a geração nem implementar a matriz de prontidão.
- Configurações legadas continuam carregando com defaults e o provedor salvo é
  preservado quando o perfil está completo.
- Salvar configurações permanece permitido quando nenhum provedor está pronto.
- A geração revalida o provedor selecionado e apresenta erros contextuais sem
  expor segredo.
- Ambos os Adapters satisfazem a mesma Interface observável de tarefas
  normalizadas e preservam suas garantias de segurança.
- Não há nova abstração para um único Adapter nem mecanismo especulativo de
  plugins.
- Todos os gates Rust e frontend passam.

## Coordenação entre agentes

- **Arquivos possuídos:** `src-tauri/src/ai.rs`, testes desse arquivo e mudanças
  necessárias em `src-tauri/src/models.rs`, `src/types.ts`, `src/App.tsx`,
  `src/SettingsPanel.tsx` e respectivos testes.
- **Integração compartilhada:** alterações mínimas em `src-tauri/src/commands.rs`;
  confirmar propriedade antes de editar.
- **Conflitos:** os pacotes 02 e 03 também alteram a geração em
  `commands.rs`; o pacote 06 pode alterar `SavedConfig`/inicialização; mudanças de
  UI paralelas podem atingir `App.tsx` e `SettingsPanel.tsx`.
- **Ordem recomendada:** estabilizar primeiro o pacote 03, implementar este
  núcleo e seus DTOs, e então deixar o pacote 02 aprofundar a execução usando as
  Interfaces finais de Git e IA. Coordenar o pacote 06 antes de alterar defaults.
- Dividir trabalho interno apenas por **Seams** reais: um agente pode preparar o
  núcleo Rust e outro os consumidores React depois de acordado o DTO. Não manter
  duas fontes temporárias de catálogo em commits finais.
- Entregar cada etapa em estado compilável; não editar `AGENTS.md` neste pacote.

## Riscos

- Um DTO excessivamente genérico pode apenas transferir a complexidade para o
  frontend e tornar a Module rasa.
- Remover literais TypeScript pode enfraquecer tipos; compensar com validação Rust
  e tipos discriminados derivados do DTO, sem codegen especulativo.
- Cachear prontidão pode deixar o estado obsoleto; a geração sempre deve
  revalidar a condição privilegiada.
- Misturar catálogo com detalhes de transporte pode dificultar os testes dos
  Adapters; manter funções privadas testáveis dentro da Implementation.
- Alterar simultaneamente configuração, UI e orquestração aumenta conflitos;
  separar commits por resultado observável e respeitar a ordem de integração.
- Uma abstração prematura para futuros provedores pode aumentar a Interface sem
  Leverage atual; OpenAI e Codex são suficientes para orientar a Seam.
