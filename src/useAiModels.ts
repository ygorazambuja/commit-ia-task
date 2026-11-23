import { useCallback, useEffect, useRef, useState } from "react";
import { listAiModels } from "./desktop";
import type { AiModelCatalog, AiProvider, InitialState } from "./types";

export function useAiModels(
	state: Pick<InitialState, "aiProviders"> | null,
	apiKey: string,
	settingsOpen: boolean,
) {
	const [catalogs, setCatalogs] = useState<
		Partial<Record<AiProvider, AiModelCatalog>>
	>({});
	const [loading, setLoading] = useState<Partial<Record<AiProvider, boolean>>>(
		{},
	);
	const requests = useRef({ openai: 0, codex: 0 });
	const currentKey = useRef(apiKey);
	currentKey.current = apiKey;
	const mounted = useRef(true);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const refresh = useCallback(
		async (provider: AiProvider) => {
			const request = ++requests.current[provider];
			const key = currentKey.current;
			setLoading((current) => ({ ...current, [provider]: true }));
			try {
				const result = await listAiModels(
					provider,
					provider === "openai" ? key : undefined,
				);
				if (
					!mounted.current ||
					request !== requests.current[provider] ||
					(provider === "openai" && key !== currentKey.current)
				)
					return;
				setCatalogs((current) => ({
					...current,
					[provider]:
						result.source === "local" && current[provider]
							? { ...current[provider], warnings: result.warnings }
							: result,
				}));
			} catch {
				if (
					!mounted.current ||
					request !== requests.current[provider] ||
					(provider === "openai" && key !== currentKey.current)
				)
					return;
				setCatalogs((current) => ({
					...current,
					[provider]: {
						...(current[provider] ?? {
							models:
								state?.aiProviders.find((p) => p.id === provider)?.models ?? [],
							source: "local" as const,
						}),
						warnings: [
							"Não foi possível atualizar os modelos. A lista anterior foi mantida.",
						],
					},
				}));
			} finally {
				if (
					mounted.current &&
					request === requests.current[provider] &&
					(provider !== "openai" || key === currentKey.current)
				) {
					setLoading((current) => ({ ...current, [provider]: false }));
				}
			}
		},
		[state?.aiProviders],
	);

	const ready = state !== null;
	const previousKey = useRef(apiKey);
	const previousSettings = useRef(settingsOpen);
	useEffect(() => {
		if (!ready) return;
		const changed = previousKey.current !== apiKey;
		if (!changed || previousSettings.current !== settingsOpen)
			void refresh("codex");
		previousKey.current = apiKey;
		previousSettings.current = settingsOpen;
		++requests.current.openai;
		setLoading((current) => ({ ...current, openai: true }));
		const timer = window.setTimeout(
			() => {
				void refresh("openai");
			},
			changed ? 800 : 0,
		);
		return () => {
			window.clearTimeout(timer);
			++requests.current.openai;
		};
	}, [apiKey, ready, settingsOpen, refresh]);

	return { catalogs, loading };
}
