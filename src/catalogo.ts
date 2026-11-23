import type { Complexity } from "./ai-schema";

type Servico = {
	ust: Partial<Record<Complexity, number>>;
	o_que: string;
	nao_usar_para?: string;
};

// Serviços do catálogo aplicáveis a diff de código. A chave é o ID SPF e a UST vem da aba
// Tabela_Servicos_agrupado de "SPF-SIAFIC-CATALOGO DE SERVICOS.xlsx" (Média = 3× Baixa, Alta = 5× Baixa).
// o_que/nao_usar_para são os critérios enviados ao Jev: "novo" é o que não existia, "manutenção" altera o que já existe.
export const SERVICOS: Record<string, Servico> = {
	// Documentação Customizada de Solução
	"7": {
		ust: { BAIXA: 3, MEDIA: 9, ALTA: 15 },
		o_que:
			"Documentação técnica específica da solução: README, guias, manuais técnicos, documentação de API.",
	},
	// Implementação de nova Funcionalidade do tipo Interface de Usuário (backend e frontend)
	"12": {
		ust: { BAIXA: 18, MEDIA: 54, ALTA: 90 },
		o_que:
			"Criação de uma funcionalidade NOVA completa com tela: interface de usuário mais o backend (CRUD, formulário, aba ou tela nova com persistência).",
		nao_usar_para:
			"Ajustes em tela já existente (use 21A/21B) ou página só de frontend sem backend (use 19).",
	},
	// Implementação de nova Funcionalidade do tipo Serviço (backend e endpoint)
	"13": {
		ust: { BAIXA: 5, MEDIA: 15, ALTA: 25 },
		o_que:
			"Criação de um serviço/endpoint/API NOVO para integração ou consumo por outras aplicações (controller + service + rota novos).",
		nao_usar_para: "Mudança de contrato de endpoint existente (use 21F).",
	},
	// Implementação de nova Funcionalidade do tipo Relatório (backend e template)
	"14": {
		ust: { BAIXA: 11, MEDIA: 33, ALTA: 55 },
		o_que:
			"Criação de um relatório NOVO ou exportação nova (PDF, CSV, Excel, impressão) com seu template e consulta de dados.",
		nao_usar_para: "Incluir ou alterar campo em relatório existente (use 21A).",
	},
	// Implementação de nova Funcionalidade do tipo Batch (backend e Jobs)
	"15": {
		ust: { BAIXA: 8, MEDIA: 24, ALTA: 40 },
		o_que:
			"Criação de um processamento em lote NOVO: job, rotina agendada, command, worker ou fila.",
		nao_usar_para: "Ajuste em job existente.",
	},
	// Implementação de nova Funcionalidade do tipo Dashboard (backend e frontend)
	"16": {
		ust: { BAIXA: 6, MEDIA: 18, ALTA: 30 },
		o_que: "Criação de gráfico ou dashboard NOVO com sua fonte de dados.",
	},
	// Implementação de novo Recurso do tipo Componente (backend ou frontend)
	"17": {
		ust: { BAIXA: 8, MEDIA: 24, ALTA: 40 },
		o_que:
			"Criação de um componente NOVO e reutilizável: classe de suporte ou infraestrutura, DTO, helper, cliente de serviço, mapeador, componente de tela, controller/service/repository novo que não é uma funcionalidade completa.",
		nao_usar_para:
			"Alterações em componente que já existe (use 21A–21G), testes (use 22) e regra de negócio nova (use 18).",
	},
	// Implementação de novo Recurso do tipo Regra de Negócio (backend)
	"18": {
		ust: { BAIXA: 3, MEDIA: 9, ALTA: 15 },
		o_que:
			"Implementação de uma regra de negócio NOVA no backend (cálculo, política, condição ou fluxo de decisão que não existia).",
		nao_usar_para:
			"Alterar ou remover regra existente (use 21D) ou validação de formato/obrigatoriedade (use 21C).",
	},
	// Implementação de Página Web (HTML, css e javascript) - apenas frontend
	"19": {
		ust: { BAIXA: 4, MEDIA: 12, ALTA: 20 },
		o_que:
			"Criação de página web NOVA apenas de frontend (HTML, CSS, JavaScript), sem backend.",
	},
	// Implementação de Testes Unitários Automatizados
	"22": {
		ust: { BAIXA: 4, MEDIA: 12, ALTA: 20 },
		o_que:
			"Criação ou ajuste de testes unitários automatizados (arquivos de teste, mocks, fixtures, cobertura).",
	},
	// Implementação de Testes Funcionais Automatizados
	"24": {
		ust: { ÚNICA: 30 },
		o_que:
			"Criação de testes funcionais automatizados de ponta a ponta pela interface (Selenium, Cypress, Playwright).",
	},
	// Implementação de Testes de Integração Automatizados
	"26": {
		ust: { ÚNICA: 10 },
		o_que:
			"Criação de testes de integração automatizados (API, banco de dados, vários componentes juntos).",
	},
	// Criação de dados de teste
	"29": {
		ust: { ÚNICA: 4 },
		o_que:
			"Criação de massa de dados para teste: seeds, factories ou scripts de dados de teste.",
	},
	// Configuração/Preparação da Aplicação para Implantação
	"30": {
		ust: { ÚNICA: 6 },
		o_que:
			"Configuração da aplicação para implantação: arquivos de configuração, profiles, appsettings, variáveis de ambiente, logs, segurança, dependências do projeto.",
	},
	// Configuração padrão relacionada à Integração Contínua para Aplicação
	"32": {
		ust: { ÚNICA: 8 },
		o_que:
			"Configuração padrão de integração contínua: pipeline, build, versionamento, repositório de artefatos.",
	},
	// Projeto customizado de Integração Contínua para Aplicação
	"33": {
		ust: { ÚNICA: 36 },
		o_que:
			"Projeto customizado de integração contínua: rotinas e scripts próprios de CI/CD para necessidades específicas.",
	},
	// Elaboração e execução de Scripts
	"38": {
		ust: { ÚNICA: 5 },
		o_que:
			"Elaboração e execução de scripts de banco de dados: SQL, NoSQL, migrations, alteração de tabelas, carga ou correção de dados.",
	},
	// Manutenções em Sistemas Existentes (corretivas, evolutivas, adaptativas ou perfectivas)
	"21A": {
		ust: { ÚNICA: 4 },
		o_que:
			"Manutenção: incluir, alterar ou remover atributo/campo/coluna/filtro em formulário, tela, relatório ou serviço que JÁ EXISTE, com ajustes no frontend e backend.",
	},
	// Manutenções em Sistemas Existentes (corretivas, evolutivas, adaptativas ou perfectivas)
	"21B": {
		ust: { ÚNICA: 2 },
		o_que:
			"Manutenção: incluir, alterar ou remover textos e elementos estáticos em tela ou relatório existente (labels, tooltips, mensagens, títulos, traduções, cabeçalhos, estilo visual).",
	},
	// Manutenções em Sistemas Existentes (corretivas, evolutivas, adaptativas ou perfectivas)
	"21C": {
		ust: { ÚNICA: 2 },
		o_que:
			"Manutenção: incluir, alterar ou remover validação de dados (obrigatoriedade, formato, tamanho, intervalo, consistência de entrada).",
	},
	// Manutenções em Sistemas Existentes (corretivas, evolutivas, adaptativas ou perfectivas)
	"21D": {
		ust: { ÚNICA: 2 },
		o_que:
			"Manutenção: alterar ou remover regra de negócio que JÁ EXISTE (ajuste de cálculo, condição, permissão ou fluxo existente).",
	},
	// Manutenções em Sistemas Existentes (corretivas, evolutivas, adaptativas ou perfectivas)
	"21E": {
		ust: { ÚNICA: 2 },
		o_que:
			"Manutenção: correção de erro (bug) em componente de backend ou frontend; o comportamento estava errado e foi consertado.",
	},
	// Manutenções em Sistemas Existentes (corretivas, evolutivas, adaptativas ou perfectivas)
	"21F": {
		ust: { ÚNICA: 5 },
		o_que:
			"Manutenção: alteração de contrato de API ou de componente (assinatura, payload, DTO de resposta, nomes de campos JSON) ou adequação de cliente/SPI, incluindo atualização de versão de framework ou biblioteca.",
	},
	// Manutenções em Sistemas Existentes (corretivas, evolutivas, adaptativas ou perfectivas)
	"21G": {
		ust: { ÚNICA: 4 },
		o_que:
			"Manutenção: remoção de funcionalidade, arquivo ou código existente, com os ajustes de impacto.",
	},
	// Manutenções em Sistemas Existentes (corretivas, evolutivas, adaptativas ou perfectivas)
	"21H": {
		ust: { BAIXA: 3, MEDIA: 9, ALTA: 15 },
		o_que:
			"Análise exploratória de problema em sistema existente (troubleshooting, debug, investigação de causa) sem implementar a correção.",
	},
};

// Complexidade que não existe para o serviço cai no primeiro nível dele (Baixa ou Única).
export function resolveUst(
	idSpf: string,
	complexidade: Complexity,
): { complexidade: Complexity; ust: number } {
	const niveis = SERVICOS[idSpf]?.ust;
	if (!niveis) {
		throw new Error(`Serviço ${idSpf} não está no catálogo`);
	}

	const nivel =
		complexidade in niveis
			? complexidade
			: (Object.keys(niveis)[0] as Complexity);

	return { complexidade: nivel, ust: niveis[nivel] as number };
}
