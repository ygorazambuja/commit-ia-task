import { CircleHelp, Terminal } from "lucide-react";
import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from "./components/ui/accordion";
import { Badge } from "./components/ui/badge";

const questions = [
	{
		id: "azure-cli",
		question: "Preciso instalar o Azure CLI?",
		answer: (
			<p>
				Não para gerar o CSV nem para registrar horas no Time Log Free. O Azure
				CLI só é necessário ao ativar “Criar tarefas no Azure DevOps” para criar
				os work items diretamente.
			</p>
		),
	},
	{
		id: "direct-creation",
		question: "Como habilito a criação direta de tarefas?",
		answer: (
			<>
				<p>
					Instale e autentique o Azure CLI e adicione a extensão Azure DevOps:
				</p>
				<code className="help-command">
					az extension add --name azure-devops
				</code>
				<p>
					Ao habilitar a criação, informe também o PBI, User Story ou
					Requirement que será o item pai. Ele é obrigatório e cada Task criada
					será vinculada a ele.
				</p>
			</>
		),
	},
	{
		id: "csv",
		question: "O que preciso para gerar apenas o CSV?",
		answer: (
			<p>
				Um repositório Git com alterações e um provedor de IA pronto: uma chave
				da OpenAI ou o Codex CLI autenticado. O Azure CLI não é usado nesse
				fluxo.
			</p>
		),
	},
	{
		id: "codex-cli",
		question: "Quando preciso do Codex CLI?",
		answer: (
			<p>
				Somente ao escolher o provedor Codex. Nesse caso, o executável deve
				estar instalado e a sessão autenticada com <code>codex login</code>. O
				provedor OpenAI não depende do Codex CLI.
			</p>
		),
	},
	{
		id: "time-log",
		question: "O que o Time Log Free exige?",
		answer: (
			<p>
				A organização do Azure DevOps e uma credencial válida: o PAT salvo em
				Configurações, com acesso de leitura e gravação a Extension Data, ou as
				variáveis <code>ADO_PAT</code> ou <code>ADO_TOKEN</code>. O Azure CLI
				não é necessário. Os tipos manuais disponíveis são Backend, Frontend,
				Teste, Análise e Reunião.
			</p>
		),
	},
	{
		id: "combined-time-log",
		question: "Como registro o Time Log junto com as tarefas?",
		answer: (
			<p>
				Ative a criação direta no Azure, informe o item pai e habilite
				“Registrar também no Time Log”. Depois que todas as Tasks forem criadas,
				as estimativas geradas serão convertidas em minutos e registradas no
				item pai, como Backend, Frontend ou Teste.
			</p>
		),
	},
	{
		id: "time-log-distribution",
		question: "Como as estimativas são distribuídas entre as datas?",
		answer: (
			<>
				<p>
					O intervalo inicial/final é inclusivo, não aceita datas futuras e usa
					somente segunda a sexta-feira. O aplicativo não consulta feriados;
					feriados em dias úteis contam como disponíveis.
				</p>
				<p>
					O limite é global: 420 minutos por dia para o usuário autenticado pelo
					PAT, incluindo lançamentos já existentes em qualquer work item ou
					tipo.
				</p>
			</>
		),
	},
	{
		id: "time-log-partial-failure",
		question: "O que acontece se faltar espaço ou alguma etapa falhar?",
		answer: (
			<>
				<p>
					As estimativas nunca são truncadas. Se o período não comportar todos
					os minutos, o plano mostra o saldo faltante e nenhum lançamento é
					enviado. Se a criação das Tasks no Azure for parcial, o Time Log é
					pulado.
				</p>
				<p>
					Durante os lançamentos, a primeira falha interrompe o lote e preserva
					os registros já confirmados. Falhas parciais ou de resultado
					indeterminado não são repetidas automaticamente; confira o Time Log
					Free antes de tentar novamente.
				</p>
			</>
		),
	},
	{
		id: "time-log-cli",
		question: "Como planejo um intervalo pelo terminal?",
		answer: (
			<p>
				Use <code>--date</code> para a data inicial e, opcionalmente,{" "}
				<code>--end-date</code> para a data final inclusiva. Sem a data final, o
				lançamento usa somente <code>--date</code>. A opção{" "}
				<code>--dry-run</code> consulta o saldo existente e mostra o plano sem
				fazer POST.
			</p>
		),
	},
	{
		id: "development",
		question: "Quais são os requisitos para desenvolver o aplicativo?",
		answer: (
			<p>
				Bun, Git, Rust/Cargo estável e os pré-requisitos do Tauri para o seu
				sistema operacional. Azure CLI e Codex CLI continuam opcionais e só são
				necessários para os fluxos descritos acima.
			</p>
		),
	},
	{
		id: "credentials",
		question: "Quais credenciais ficam salvas?",
		answer: (
			<p>
				Somente o PAT do Time Log pode ser persistido localmente. A chave da
				OpenAI digitada na interface permanece apenas em memória durante a
				execução.
			</p>
		),
	},
] as const;

export default function HelpPanel() {
	return (
		<section aria-labelledby="helpTitle" className="help-panel">
			<div className="help-heading">
				<div className="help-title">
					<span aria-hidden="true" className="help-title-icon">
						<CircleHelp size={19} />
					</span>
					<div>
						<h2 id="helpTitle">Ajuda e perguntas frequentes</h2>
						<p>Consulte os requisitos de cada integração antes de começar.</p>
					</div>
				</div>
				<Badge className="help-status" variant="outline">
					<Terminal aria-hidden="true" size={13} />
					Azure CLI opcional
				</Badge>
			</div>

			<Accordion className="help-faq" defaultValue={["azure-cli"]} multiple>
				{questions.map((item) => (
					<AccordionItem
						className="help-faq-item"
						key={item.id}
						value={item.id}
					>
						<AccordionTrigger>{item.question}</AccordionTrigger>
						<AccordionContent className="help-answer">
							{item.answer}
						</AccordionContent>
					</AccordionItem>
				))}
			</Accordion>
		</section>
	);
}
