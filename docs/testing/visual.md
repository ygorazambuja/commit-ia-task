# Verificação visual de Minhas tarefas

`bun run test:visual` abre a interface em Chromium com cards, notificações e um
plano fictícios. O script substitui a ponte `src/desktop.ts` inteira e bloqueia
requisições externas: não usa PAT, Azure, Codex ou o backend Tauri. Confere o
fluxo Fazer → repositório → plano, a marcação de notificações como lidas, erros
de JavaScript e rolagem horizontal nos tamanhos 1440 × 900 e 860 × 640.

## Preparação

Instale as dependências do app com `bun install --frozen-lockfile`. A rotina
reutiliza o Playwright da skill `dev-browser`, sem acrescentá-lo ao aplicativo.
Por padrão, encontra a skill em `~/.codex/skills/dev-browser`; para outro local,
defina `DEV_BROWSER_SKILL_DIR` como o caminho absoluto da pasta da skill.

Inicie o servidor independente da skill em outro terminal:

```bash
cd "${DEV_BROWSER_SKILL_DIR:-$HOME/.codex/skills/dev-browser}"
./server.sh --headless
```

Aguarde `Ready`. Execute na raiz deste repositório:

```bash
bun run test:visual
```

Se o servidor da skill usa outra porta, informe a URL local em
`DEV_BROWSER_URL` (padrão `http://127.0.0.1:9222`). O modo de extensão, que usa
uma sessão pessoal do navegador, é recusado.

## Resultado e manutenção

O script inicia o próprio Vite em uma porta disponível e encerra esse Vite e
a página de teste ao terminar, inclusive quando uma asserção falha. O servidor
da skill fica disponível para outras verificações; encerre-o com Ctrl+C no
terminal em que foi iniciado.

Os arquivos ficam em `.cache/visual-review/`, já ignorado pelo Git:

- `minhas-tarefas-1440.png`: cards e notificações abertas;
- `minhas-tarefas-plano.png`: análise e plano gerados;
- `minhas-tarefas-860.png`: plano com viewport menor;
- `report.json`: sucesso/falha e capturas da última execução;
- `failure.png`: captura auxiliar quando a rotina falha.

Confira as imagens para avaliar legibilidade, espaçamento, quebras de texto e
ações visíveis. A rotina não compara pixels com uma imagem de referência; o
relatório aprovado confirma as asserções funcionais, não substitui a revisão
das capturas. Datas são fixas nos dados e renderizadas no fuso do navegador.

As fixtures e as ações estão em `scripts/visual-review.ts`. Ao mudar o contrato
da ponte desktop ou os nomes acessíveis dos controles, atualize esse script e
execute-o novamente. Essa verificação é complementar aos testes unitários e
ao CI de builds nativos; não precisa de credenciais nem deve chamá-las.

A folha de estilos do Google Fonts recebe uma resposta local vazia; as capturas
usam as fontes alternativas declaradas pelo app. Qualquer outra requisição
externa inesperada falha a verificação.
