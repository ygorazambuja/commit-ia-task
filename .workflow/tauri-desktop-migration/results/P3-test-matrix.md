# P3 — Matriz mínima de regressão e aceitação desktop

## Evidência de partida

Em 27/07/2026, antes da migração:

- `bun test`: **30 testes passando**, 0 falhas.
- `bun run typecheck`: passando.
- A suíte atual cobre normalização da resposta da IA, parsing do Codex,
  persistência básica, geração de CSV, montagem do comando Azure e três casos
  de Git.
- As maiores lacunas atuais são: sucesso parcial, conteúdo enviado em cada
  estado Git, preservação exata do index, falha de `git add`, caminhos hostis,
  symlinks, segredo OpenAI, orquestração completa e qualquer interação de UI.

Os contratos abaixo vêm do código atual, que deve prevalecer sobre descrições
antigas:

- `ID SPF`: `BACKEND=17`, `FRONTEND=19`, `TESTES=22`.
- `UST`: `BAIXA=8`, `MEDIA=24`, `ALTA=40`, `ÚNICA=8`.
- Cabeçalho CSV, em ordem:
  `ID, Work Item Type, Title, Assigned To, State, Area ID, Iteration ID,
  Item Contrato, ID SPF, UST, Complexidade, Activity, Description,
  Estimate Made, Remaining Work, Original Estimate`.
- Um arquivo novo envia o conteúdo completo; unstaged envia `git diff`; staged
  envia `git diff --cached`; mixed concatena as duas partes com os marcadores
  atuais.
- Somente arquivos processados com sucesso recebem `git add`.
- Falha de um arquivo não cancela os demais; falha de todos é fatal.
- Repositório sem alterações hoje resulta em CSV contendo somente o cabeçalho.
- O Azure recebe apenas os campos padrão/atividade/estimativas. `Item Contrato`,
  `ID SPF`, `UST` e `Complexidade` continuam exclusivos do CSV.

## Forma mais barata de testar

Não manter a implementação TypeScript antiga como “oráculo” em produção.
Portar os contratos para testes Rust/React e usar somente estas bordas:

1. Repositórios Git temporários reais para status, diff, rename e index.
2. Um `CommandRunner` injetável para `codex` e `az`; sempre recebe
   `program + Vec<String>`, nunca uma linha de shell.
3. Cliente HTTP falso/local para OpenAI; nenhuma chamada paga.
4. Diretório temporário e relógio injetável apenas onde o nome do CSV exigir.
5. Adapter da bridge Tauri mockado nos testes React.

Isso dá cobertura de risco sem introduzir WebDriver, container ou uma segunda
implementação do backend.

## Matriz automatizada bloqueante

`P0` é requisito de conclusão. `P1` fecha um risco já existente, mas não é
paridade literal; pode ser adiado somente se aparecer no relatório final.

| ID | Pri. | Camada | Arranjo mínimo | Resultado obrigatório |
|---|---|---|---|---|
| R-AI-01 | P0 | Rust / domínio | Tabela com complexidades válidas, espaços/caixa, valor inválido; estimates `1`, `8`, string numérica, `0`, `9`, decimal e inválido; tipos válidos e JSON incompleto | Complexidade termina em `ALTA/MEDIA/BAIXA/ÚNICA`, inválida vira `ÚNICA`; estimate inválido vira `1`; schema incompleto/tipo inválido é rejeitado |
| R-AI-02 | P0 | Rust / providers | OpenAI em servidor falso e Codex com runner falso; casos de sucesso, JSON inválido e processo/HTTP não-zero | Prompt contém caminho e diff, resposta é validada/normalizada, falha vira erro em português com contexto do arquivo; nenhum processo ou rede real |
| R-GIT-01 | P0 | Rust / Git | Um teste tabelado em repo temporário: arquivo untracked, somente unstaged, somente staged, mixed, deleted e rename; incluir lockfiles em subpastas | O fake de IA recebe exatamente conteúdo completo/diff correto; mixed contém as duas seções; deleção/rename funcionam; `pnpm-lock.yaml`, `bun.lockb` e `package-lock.json` não são enviados |
| R-GIT-02 | P0 | Rust / staging parcial | Três arquivos; fake de IA aprova dois e falha um. Um dos arquivos falhos já possui parte staged | Resultado contém tasks e erro por arquivo; somente os dois aprovados ficam integralmente staged; o index do arquivo falho permanece byte a byte igual ao snapshot anterior |
| R-GIT-03 | P0 | Rust / falha total e stage | Subcasos: todos os providers falham; `git add` falha depois de gerar uma task | Falha total não cria CSV/Azure nem altera o index; falha no add não declara o arquivo como staged, aparece no resultado, e não apaga staging preexistente |
| R-GIT-04 | P0 | Rust / path safety | CWD aponta para repo B e o usuário escolhe repo A. Em A usar nomes com espaço, acento e prefixo `-`; parser recebe saída NUL. Tentar também caminho forjado com `../` | Toda operação usa A; nomes chegam intactos; args usam `--`; nada em B ou fora da raiz escolhida é lido ou staged |
| R-GIT-05 | P0 | Rust / symlink | Symlink untracked dentro do repo aponta para arquivo sentinela fora dele; outro arquivo interno é válido | Conteúdo externo nunca chega ao provider/log/resultado; symlink gera erro por arquivo e não é staged; o arquivo interno continua sendo processado |
| R-GIT-06 | P1 | Rust / corrida | Fake de IA bloqueia após receber o diff; o teste altera o arquivo antes de liberar a resposta | Backend detecta `changed_during_processing`, não stages uma versão que a IA não analisou e informa o usuário |
| R-CONFIG-01 | P0 | Rust / config | Round-trip, arquivo ausente, JSON corrompido, tipo inválido e config legada; diretório temporário | Round-trip preserva campos não secretos; ausente/corrompida usa defaults e warning sem crash; gravação fica somente no diretório da aplicação |
| R-SECRET-01 | P0 | Rust / segredo | Ambiente contém uma chave sentinela; salvar config, executar sucesso e forçar erro HTTP/CLI que inclua a sentinela | `OPENAI_API_KEY` só vai no header de autorização; não aparece no JSON de config, payload Tauri, CSV, logs ou mensagem apresentada; Codex continua usando sessão da CLI, sem token persistido |
| R-CSV-01 | P0 | Rust / CSV | Um golden file parseado como CSV com todos os três tipos, quatro complexidades, UTF-8, vírgula, aspas e `CR/LF` em título/descrição | Ordem e nomes dos 16 headers são exatos; texto vira uma linha válida; quoting é válido; SPF/UST e os três campos de estimate são exatos; arquivo vazio tem só header |
| R-CSV-02 | P0 | Rust / filesystem | Relógio fixo, duas exportações no mesmo diretório e uma escrita forçada a falhar | Nunca sobrescreve: segundo arquivo recebe `-1`; caminho retornado está no destino escolhido; erro de IO é exibível e impede chamada Azure |
| R-AZ-01 | P0 | Rust / Azure | Um registro contendo espaços, `;`, `$()` e aspas; org/projeto presentes e ausentes; lista vazia | Runner recebe cada valor como um único argumento, exatamente na ordem atual; org/projeto só entram quando definidos; zero registros faz zero chamadas |
| R-AZ-02 | P0 | Rust / Azure failures | Três registros; primeiro retorna id, segundo sai não-zero ou JSON sem id, terceiro seria sucesso | Não há retry ou chamada do terceiro; resultado/erro informa o id já criado, o título que falhou e que houve criação parcial, evitando “sucesso” falso |
| R-PIPE-01 | P0 | Rust / serviço Tauri | Serviço completo com repo real, provider/az falsos e diretório temporário; rodar uma vez sem e uma vez com Azure | Valida campos, analisa, retorna tasks/erros/stage/CSV em DTO serializável; Azure é zero chamadas por padrão e só roda após CSV bem-sucedido quando explicitamente marcado |
| R-PIPE-02 | P0 | Rust / estado vazio | Repo limpo, sem alterações | Preserva a decisão de paridade: retorna sucesso e CSV somente com cabeçalho; se o produto decidir mudar isso, a mudança deve ser explícita no PRD/README e neste teste |

### Asserções específicas do comando Azure

O teste `R-AZ-01` deve fixar a sequência, sem passar por shell:

```text
boards work-item create
--type Task
--title <title>
--description <description>
--assigned-to <assigned>
--state To Do
--area <area>
--iteration <iteration>
--fields Microsoft.VSTS.Common.Activity=Development
         Microsoft.VSTS.Scheduling.OriginalEstimate=<estimate>
         Microsoft.VSTS.Scheduling.RemainingWork=<estimate>
[--org <organization>]
[--project <project>]
--output json
```

O teste também deve afirmar a ausência dos campos exclusivos do CSV.

## Matriz React bloqueante

Os testes de UI devem mockar somente um adapter (`loadConfig`,
`chooseRepository`, `runGeneration`), não os detalhes internos do Tauri.

| ID | Fluxo | Resultado obrigatório |
|---|---|---|
| UI-01 | Montar a tela, carregar config e escolher pasta; simular cancelamento e seleção | Campos não secretos são preenchidos, cancelamento preserva o valor, seleção mostra o caminho; labels/textos visíveis estão em português |
| UI-02 | Submeter com repo/sprint/área ausentes; depois preencher e clicar duas vezes enquanto a promise está pendente | Validação acessível impede invoke incompleto; payload válido contém provider e opções exatas; botão fica busy/desabilitado e ocorre uma única invocação |
| UI-03 | Bridge resolve com dois arquivos bem-sucedidos, um erro, CSV e status de staging | Tela mostra contagem/tasks, caminho exportado, sucesso por arquivo e erro por arquivo; não transforma resultado parcial em sucesso total nem esconde o que foi staged |
| UI-04 | Bridge rejeita por repo inválido, provider ausente e escrita CSV; tentar novamente | Erro acionável aparece com foco/`role=alert`, valores digitados são preservados, busy é encerrado e retry funciona |
| UI-05 | Azure desligado e ligado | Default é desligado; desligado envia `createAzureTasks=false`; ligado deixa a ação externa inequívoca antes da execução e mostra ids/erro parcial retornados |
| UI-06 | Provider OpenAI sem `OPENAI_API_KEY` | Não existe campo de API key nem segredo no estado/payload persistido; a tela explica que a variável de ambiente está ausente sem revelar valores |

## Segurança da bridge e do bundle

Estas verificações são pequenas, mas devem bloquear a entrega:

- Comandos Tauri registrados são somente os necessários para carregar/salvar
  config, escolher/validar repositório e executar o fluxo.
- Nenhuma capability concede shell arbitrário ou filesystem global ao
  frontend. Git, Codex e Azure são executados apenas pelo Rust com argumentos.
- DTOs não carregam conteúdo completo de arquivos/diffs de volta para React;
  retornam metadados, tasks e erros sanitizados.
- O build não embute `OPENAI_API_KEY`; um grep no `dist/` e no bundle pela
  chave sentinela deve retornar vazio.
- Erros apresentados não incluem `Authorization`, variáveis de ambiente,
  stdout/stderr bruto com segredo nem stack trace.

## Aceitação desktop

Não vale adicionar uma suíte WebDriver só para estes checks. Faça um smoke
manual no binário/dev app e mantenha a lógica coberta automaticamente acima.
Use executáveis falsos de `codex`/`az` no `PATH`; não faça chamada paga nem
crie work item real.

### D-01 — Janela, picker e happy path

1. Criar repo temporário com um arquivo untracked, um unstaged e um mixed,
   incluindo nome `-ação com espaço.ts`.
2. Iniciar a aplicação com fake `codex` retornando JSON schema-válido.
3. Selecionar o repo pelo picker, preencher campos e executar sem Azure.
4. Confirmar na janela tasks/arquivos/CSV e zero erro.
5. Confirmar no terminal que somente os arquivos processados estão staged e
   que o CSV abre como UTF-8 com os 16 headers.

### D-02 — Sucesso parcial e segurança

1. Fazer o fake provider falhar para um arquivo e responder para outro.
2. Confirmar que a UI termina, exibe ambos os resultados e permite retry.
3. Confirmar que o arquivo falho e qualquer staging anterior dele permanecem
   intocados.
4. Repetir com symlink para sentinela externa; a sentinela não pode aparecer
   em UI/log e o symlink não pode ser staged.

### D-03 — Ações externas e persistência

1. Rodar com Azure desligado: fake `az` registra zero `work-item create`.
2. Ligar Azure conscientemente: fake `az` registra exatamente os args de
   `R-AZ-01`, e os ids aparecem na janela.
3. Reiniciar a aplicação: configuração não secreta reaparece.
4. Inspecionar config, logs e `dist/bundle`: chave sentinela não aparece.
5. Remover `git`, `codex` ou `az` do `PATH` em execuções separadas e confirmar
   erro em português indicando qual dependência falta.

## Semântica de falha que o DTO precisa preservar

| Falha | Staging | CSV | Azure | UI |
|---|---|---|---|---|
| Um provider falha | Sucessos sim; falho intacto | Somente tasks válidas | Opcional, somente records válidos | Resultado parcial por arquivo |
| Todos providers falham | Nenhum staging novo | Não | Não | Erro fatal acionável |
| `git add` falha | Não alegar sucesso; nunca resetar index alheio | Pode conter a task já gerada | Segue somente se contrato permitir e UI souber do warning | Warning do arquivo |
| Escrita CSV falha | Não tentar rollback destrutivo do index | Não concluído | Não | Mostrar falha e quais arquivos já foram staged |
| Azure falha no item N | Staging/CSV permanecem | Permanece | Parar; sem retry automático | Mostrar ids criados e item N falho |
| Config corrompida | Sem efeito | Sem efeito | Sem efeito | Defaults + warning, sem crash |
| Repo inválido/path fora da raiz | Nenhum | Não | Não | Rejeição antes do fluxo |

## Gate final sugerido

Executar na raiz, adaptando apenas os nomes de scripts escolhidos:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
bun test
bun run typecheck
bun run build
bun run tauri build --no-bundle
```

Além dos comandos:

- nenhum teste pode depender de rede, conta, key ou login reais;
- `git status --short` não pode conter CSV, segredo, `dist`, `target` ou bundle;
- D-01 a D-03 devem ser registrados no relatório final com resultado e
  eventual limitação do ambiente.

## Riscos que não devem ficar invisíveis

1. **Corrida entre análise e stage:** a CLI atual pode adicionar uma versão
   alterada enquanto a IA processa. `R-GIT-06` é o hardening recomendado.
2. **Azure não é transacional:** depois do primeiro id não existe rollback
   seguro; o resultado estruturado precisa preservar criação parcial.
3. **Symlink untracked:** ler conteúdo completo sem contenção pode vazar um
   arquivo fora do repo.
4. **GUI iniciada pelo Finder:** pode não herdar o `PATH`/ambiente do shell.
   Mensagens para `OPENAI_API_KEY`, `codex`, `az` e `git` ausentes precisam ser
   claras.
5. **Staging preexistente:** nunca usar `git reset`, `restore` ou checkout como
   “cleanup”; o teste compara o index antes/depois para proteger trabalho do
   usuário.
