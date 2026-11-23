import {
	Bell,
	CircleAlert,
	FolderSearch,
	ListTodo,
	RefreshCw,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Spinner } from "./components/ui/spinner";
import { toast } from "./components/ui/toast";
import {
	analyzeAzureTask,
	chooseRepository,
	getAzureTasks,
	markAzureNotificationsRead,
	onAzureTasksUpdated,
	refreshAzureTasks,
} from "./desktop";
import type { AzureTasksSnapshot, AzureWorkItem, CardAnalysis } from "./types";

interface MyTasksPanelProps {
	codexReady: boolean;
	onOpenSettings: () => void;
	onUnreadChange: (count: number) => void;
}

const initialSnapshot: AzureTasksSnapshot = {
	items: [],
	notifications: [],
	status: "loading",
	message: null,
	lastCheckedAt: null,
};

function errorMessage(error: unknown): string {
	return error instanceof Error
		? error.message
		: typeof error === "string" && error.trim()
			? error
			: "Tente novamente.";
}

function formatDate(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? value
		: date.toLocaleString("pt-BR", {
				day: "2-digit",
				month: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
			});
}

export default function MyTasksPanel({
	codexReady,
	onOpenSettings,
	onUnreadChange,
}: MyTasksPanelProps) {
	const [snapshot, setSnapshot] = useState(initialSnapshot);
	const [error, setError] = useState("");
	const [isRefreshing, setIsRefreshing] = useState(false);
	const [isMarkingRead, setIsMarkingRead] = useState(false);
	const [analyzing, setAnalyzing] = useState<{
		item: AzureWorkItem;
		repository: string | null;
	} | null>(null);
	const [result, setResult] = useState<{
		item: AzureWorkItem;
		repository: string;
		analysis: CardAnalysis;
	} | null>(null);
	const lifecycle = useRef(0);
	const snapshotVersion = useRef(0);
	const knownNotifications = useRef<Set<string> | null>(null);
	const actionPending = useRef(false);
	const unread = snapshot.notifications.filter((item) => !item.read).length;

	const receiveSnapshot = (next: AzureTasksSnapshot, notify = true) => {
		if (knownNotifications.current && notify) {
			const newNotifications = next.notifications.filter(
				(item) => !item.read && !knownNotifications.current?.has(item.id),
			);
			if (newNotifications.length) {
				toast.success(
					newNotifications.length === 1
						? `Novidade no card #${newNotifications[0].workItemId}`
						: `${newNotifications.length} novidades nas suas tarefas`,
					"Veja as atualizações em Minhas tarefas.",
				);
			}
		}
		if (next.status === "ready" || next.notifications.length) {
			knownNotifications.current = new Set(
				next.notifications.map((item) => item.id),
			);
		}
		setSnapshot(next);
	};
	const receiveSnapshotRef = useRef(receiveSnapshot);
	receiveSnapshotRef.current = receiveSnapshot;

	useEffect(() => {
		onUnreadChange(unread);
	}, [onUnreadChange, unread]);

	useEffect(() => {
		const currentLifecycle = ++lifecycle.current;
		let unlisten: (() => void) | undefined;
		const active = () => lifecycle.current === currentLifecycle;
		const initialize = async () => {
			try {
				const stop = await onAzureTasksUpdated((next) => {
					if (!active()) return;
					snapshotVersion.current += 1;
					receiveSnapshotRef.current(next);
				});
				if (!active()) {
					stop();
					return;
				}
				unlisten = stop;
			} catch (listenerError) {
				if (!active()) return;
				setError(
					`Não foi possível acompanhar as atualizações. Use Atualizar ou reinicie o aplicativo. ${errorMessage(listenerError)}`,
				);
			}
			const version = snapshotVersion.current;
			try {
				const next = await getAzureTasks();
				if (active() && version === snapshotVersion.current) {
					receiveSnapshotRef.current(next, false);
				}
			} catch (loadError) {
				if (active() && version === snapshotVersion.current) {
					setSnapshot({
						...initialSnapshot,
						status: "error",
						message: `Não foi possível carregar suas tarefas. ${errorMessage(loadError)}`,
					});
				}
			}
		};
		void initialize();
		return () => {
			lifecycle.current += 1;
			unlisten?.();
		};
	}, []);

	const updateSnapshot = async (markRead: boolean) => {
		if (isRefreshing || isMarkingRead) return;
		const currentLifecycle = lifecycle.current;
		const version = snapshotVersion.current;
		setError("");
		if (markRead) setIsMarkingRead(true);
		else setIsRefreshing(true);
		try {
			const next = await (markRead
				? markAzureNotificationsRead()
				: refreshAzureTasks());
			if (
				lifecycle.current === currentLifecycle &&
				version === snapshotVersion.current
			) {
				receiveSnapshot(next);
			}
		} catch (updateError) {
			if (lifecycle.current === currentLifecycle) {
				setError(errorMessage(updateError));
			}
		} finally {
			if (lifecycle.current === currentLifecycle) {
				setIsRefreshing(false);
				setIsMarkingRead(false);
			}
		}
	};

	const handleAnalyze = async (item: AzureWorkItem) => {
		if (actionPending.current || !codexReady || !item.canAnalyze) return;
		actionPending.current = true;
		const currentLifecycle = lifecycle.current;
		setError("");
		setAnalyzing({ item, repository: null });
		try {
			const repository = await chooseRepository();
			if (!repository || lifecycle.current !== currentLifecycle) return;
			setResult(null);
			setAnalyzing({ item, repository });
			const analysis = await analyzeAzureTask({
				workItemId: item.id,
				repositoryPath: repository,
			});
			if (lifecycle.current !== currentLifecycle) return;
			setResult({ item, repository, analysis });
			toast.success(
				`Plano do card #${item.id} pronto`,
				"Leia a análise em Minhas tarefas antes de implementar.",
			);
		} catch (analysisError) {
			if (lifecycle.current === currentLifecycle) {
				setError(
					`Não foi possível analisar o card #${item.id}. ${errorMessage(analysisError)}`,
				);
			}
		} finally {
			if (lifecycle.current === currentLifecycle) {
				actionPending.current = false;
				setAnalyzing(null);
			}
		}
	};

	return (
		<section aria-labelledby="myTasksTitle" className="my-tasks-panel">
			<header className="my-tasks-heading">
				<div className="my-tasks-title">
					<ListTodo aria-hidden="true" className="my-tasks-title-icon" />
					<div>
						<h2 id="myTasksTitle">Minhas tarefas</h2>
						<p>
							Cards atribuídos à pessoa do PAT. Consulta automática a cada 2
							minutos enquanto o aplicativo estiver aberto.
						</p>
					</div>
				</div>
				<Button
					disabled={
						isRefreshing || isMarkingRead || snapshot.status === "loading"
					}
					onClick={() => void updateSnapshot(false)}
					type="button"
					variant="outline"
				>
					{isRefreshing ? (
						<Spinner aria-hidden="true" />
					) : (
						<RefreshCw aria-hidden="true" />
					)}
					{isRefreshing ? "Atualizando…" : "Atualizar"}
				</Button>
			</header>

			<div className="my-tasks-content">
				{snapshot.lastCheckedAt ? (
					<p className="my-tasks-last-checked">
						Última consulta:{" "}
						<time dateTime={snapshot.lastCheckedAt}>
							{formatDate(snapshot.lastCheckedAt)}
						</time>
					</p>
				) : null}
				{error || snapshot.status === "error" ? (
					<Alert variant="destructive">
						<CircleAlert aria-hidden="true" />
						<AlertTitle>Confira a conexão com o Azure e o Codex</AlertTitle>
						<AlertDescription>{error || snapshot.message}</AlertDescription>
					</Alert>
				) : null}
				{snapshot.status === "ready" && snapshot.message ? (
					<Alert>
						<CircleAlert aria-hidden="true" />
						<AlertTitle>Consulta concluída com aviso</AlertTitle>
						<AlertDescription>{snapshot.message}</AlertDescription>
					</Alert>
				) : null}
				{snapshot.status === "loading" ? (
					<p className="my-tasks-status" role="status">
						<Spinner aria-hidden="true" /> Carregando suas tarefas…
					</p>
				) : snapshot.status === "unconfigured" ? (
					<div className="my-tasks-empty" role="status">
						<h3>Conecte suas tarefas do Azure</h3>
						<p>
							{snapshot.message ||
								"Salve um PAT e configure a organização e o projeto em Configurações."}
						</p>
						<p>
							O PAT precisa da permissão Work Items — Read para ler os cards.
						</p>
						<Button onClick={onOpenSettings} type="button" variant="outline">
							Abrir Configurações
						</Button>
					</div>
				) : null}

				{snapshot.notifications.length ? (
					<details className="my-tasks-notifications">
						<summary>
							<Bell
								aria-hidden="true"
								className="my-tasks-notifications-icon"
							/>{" "}
							Atualizações dos cards
							{unread ? ` · ${unread} não lidas` : " · tudo lido"}
						</summary>
						<div className="my-tasks-notification-actions">
							<Button
								disabled={!unread || isMarkingRead || isRefreshing}
								onClick={() => void updateSnapshot(true)}
								type="button"
								variant="ghost"
							>
								{isMarkingRead ? "Marcando…" : "Marcar todas como lidas"}
							</Button>
						</div>
						<ul>
							{snapshot.notifications.map((notification) => (
								<li key={notification.id}>
									<div>
										<strong>
											#{notification.workItemId} · {notification.title}
										</strong>
										{!notification.read ? (
											<Badge variant="outline">Não lida</Badge>
										) : null}
									</div>
									<p>{notification.message}</p>
									<time dateTime={notification.createdAt}>
										{formatDate(notification.createdAt)}
									</time>
								</li>
							))}
						</ul>
					</details>
				) : null}

				{snapshot.items.length ? (
					<>
						<div className="my-tasks-list-heading">
							<h3>
								Cards atribuídos a você <span>({snapshot.items.length})</span>
							</h3>
							<p>
								Em Fazer, escolha o repositório para gerar uma análise e um
								plano com o Codex.
							</p>
							{!codexReady ? (
								<p className="my-tasks-codex-pending" role="status">
									Para analisar, instale o Codex CLI e execute codex login.
									Depois, reinicie o aplicativo.
								</p>
							) : null}
						</div>
						<ul className="my-tasks-list">
							{snapshot.items.map((item) => (
								<li key={item.id}>
									<div className="my-tasks-item-copy">
										<div className="my-tasks-item-meta">
											<span>
												#{item.id} · {item.workItemType}
											</span>
											<Badge variant="outline">{item.state}</Badge>
											{item.priority !== null ? (
												<span>Prioridade {item.priority}</span>
											) : null}
										</div>
										<h4>{item.title}</h4>
										<p>
											{item.iterationPath || "Sem sprint"}
											{item.changedDate ? (
												<>
													{" "}
													· Alterado em{" "}
													<time dateTime={item.changedDate}>
														{formatDate(item.changedDate)}
													</time>
												</>
											) : null}
										</p>
									</div>
									{item.canAnalyze ? (
										<Button
											aria-label={`Fazer análise do card #${item.id}`}
											disabled={!codexReady || analyzing !== null}
											onClick={() => void handleAnalyze(item)}
											type="button"
											variant="outline"
										>
											{analyzing?.item.id === item.id ? (
												<Spinner aria-hidden="true" />
											) : (
												<FolderSearch aria-hidden="true" />
											)}
											{analyzing?.item.id === item.id ? "Preparando…" : "Fazer"}
										</Button>
									) : null}
								</li>
							))}
						</ul>
					</>
				) : snapshot.status === "ready" ? (
					<div className="my-tasks-empty" role="status">
						<h3>Nenhum card atribuído a você</h3>
						<p>
							Quando houver cards atribuídos a você neste projeto, eles
							aparecerão aqui.
						</p>
					</div>
				) : null}

				{analyzing ? (
					<div className="my-tasks-analysis-progress" role="status">
						<Spinner aria-hidden="true" />
						<div>
							<strong>
								{analyzing.repository
									? `Analisando o card #${analyzing.item.id} com o Codex…`
									: "Escolha a pasta do repositório…"}
							</strong>
							<p>
								{analyzing.repository || "O seletor de pastas está aberto."}
							</p>
							<p>
								O plano ficará disponível nesta aba. Você pode continuar usando
								o aplicativo.
							</p>
						</div>
					</div>
				) : null}
				{result ? (
					<section
						aria-labelledby="cardAnalysisTitle"
						className="my-tasks-analysis"
					>
						<h3 id="cardAnalysisTitle">Análise e plano · #{result.item.id}</h3>
						<p className="my-tasks-analysis-title">{result.item.title}</p>
						<p className="my-tasks-repository">
							Repositório: <code>{result.repository}</code>
						</p>
						<p className="my-tasks-analysis-note">
							Revise este plano antes de implementar. Nenhuma implementação foi
							iniciada.
						</p>
						<p className="my-tasks-analysis-summary">
							{result.analysis.summary}
						</p>
						{(
							[
								["Critérios de aceite", result.analysis.acceptanceCriteria],
								["Arquivos relevantes", result.analysis.relevantFiles],
								["Plano de implementação", result.analysis.implementationPlan],
								["Plano de testes", result.analysis.testPlan],
								["Riscos", result.analysis.risks],
								["Dúvidas em aberto", result.analysis.openQuestions],
								["Avisos da análise", result.analysis.warnings],
							] as const
						).map(([title, items]) =>
							items.length ? (
								<div className="my-tasks-analysis-section" key={title}>
									<h4>{title}</h4>
									<ol>
										{Array.from(new Set(items)).map((item) => (
											<li key={item}>{item}</li>
										))}
									</ol>
								</div>
							) : null,
						)}
					</section>
				) : null}
			</div>
		</section>
	);
}
