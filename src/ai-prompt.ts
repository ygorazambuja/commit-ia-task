export type TaskGenerationInput = {
	file: string;
	diff: string;
};

export function buildTaskGenerationPrompt({
	file,
	diff,
}: TaskGenerationInput): string {
	return `${buildTaskGenerationSystemPrompt()}

Arquivo:
${file}

Diff:
${diff}`;
}

export function buildTaskGenerationSystemPrompt(): string {
	return `Você receberá um arquivo e um diff. Gere poucas tarefas, agrupando alterações relacionadas em uma mesma tarefa sempre que fizer sentido.
Priorize qualidade sobre quantidade: somente separe em múltiplas tarefas quando houver contextos claramente diferentes.
Para cada tarefa, gere: titulo, descrição, tipo, complexidade e estimateMade.
A descrição deve ser completa e didática, explicando: o que mudou, por que mudou, impacto técnico e resultado esperado.
Escreva a descrição de forma direta, sem frases de enquadramento como "olhando o diff", "no template X", "houve uma mudança significativa" ou variações equivalentes.
Não descreva o processo de análise; descreva apenas a mudança objetiva e seus efeitos.
Leve em conta a extensão e o nome do arquivo enviados. Não retorne markdown, apenas texto puro.
Retorne sempre em português brasileiro.
Evite palavras como 'Inutil' e 'Refatoração'; prefira termos como Reprocessamento ou alternativas mais agradáveis ao cliente.
O tipo deve ser obrigatoriamente um desses valores: BACKEND, FRONTEND ou TESTES.
Classifique como BACKEND alterações em regras de negócio, APIs, banco de dados, integrações ou processamento no servidor; FRONTEND alterações em interfaces, componentes visuais ou interação do usuário; TESTES alterações em testes automatizados e seus arquivos de suporte.
A complexidade deve ser obrigatoriamente um desses valores: ALTA, MEDIA, BAIXA, ÚNICA.
Defina complexidade assim:
ALTA = mudança ampla com várias regras/fluxos, alto risco ou forte impacto.
MEDIA = mudança moderada com impacto controlado e algumas regras relevantes.
BAIXA = ajuste pontual e simples, baixo risco e baixo impacto.
ÚNICA = tarefa isolada e autocontida, sem dependências relevantes com outras mudanças.
O estimateMade deve ser obrigatoriamente um número inteiro entre 1 e 8, coerente com a complexidade.`;
}
