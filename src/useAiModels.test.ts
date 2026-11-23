import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { listAiModels } from "./desktop";
import type { AiModelCatalog, AiProviderCapability } from "./types";
import { useAiModels } from "./useAiModels";

vi.mock("./desktop", () => ({ listAiModels: vi.fn() }));
const model = {
	value: "gpt-7-new",
	label: "Novo modelo",
	reasoningEfforts: [],
	defaultReasoningEffort: null,
	compatibilityVerified: false,
};
const catalog: AiModelCatalog = {
	models: [model],
	source: "provider",
	warnings: [],
};
const state = {
	aiProviders: (["openai", "codex"] as const).map(
		(id): AiProviderCapability => ({
			id,
			models: [model],
			displayName: id,
			description: "Provedor simulado",
			defaultModel: model.value,
			reasoningEfforts: [],
			allowsApiKeyInput: id === "openai",
			ready: true,
			statusDetail: "Pronto",
			pendingMessage: "Indisponível",
		}),
	),
};

function deferred() {
	let resolve!: (value: AiModelCatalog) => void;
	const promise = new Promise<AiModelCatalog>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.mocked(listAiModels).mockResolvedValue(catalog);
});
afterEach(() => {
	vi.useRealTimers();
});

async function advance(ms = 0) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

test("consulta na abertura e em Configurações; falha preserva último catálogo e sucesso vazio o substitui", async () => {
	const { result, rerender } = renderHook(
		({ settingsOpen }) => useAiModels(state, "", settingsOpen),
		{ initialProps: { settingsOpen: false } },
	);
	await advance();
	expect(listAiModels).toHaveBeenCalledTimes(2);
	expect(result.current.catalogs.openai).toEqual(catalog);
	rerender({ settingsOpen: true });
	await advance();
	expect(listAiModels).toHaveBeenCalledTimes(4);
	vi.mocked(listAiModels).mockResolvedValue({
		models: [],
		source: "local",
		warnings: ["Consulta falhou"],
	});
	rerender({ settingsOpen: false });
	await advance();
	expect(result.current.catalogs.openai).toEqual({
		...catalog,
		warnings: ["Consulta falhou"],
	});
	vi.mocked(listAiModels).mockRejectedValue(new Error("Falha do bridge"));
	rerender({ settingsOpen: true });
	await advance();
	expect(result.current.catalogs.openai?.models).toEqual([model]);
	expect(result.current.catalogs.openai?.warnings[0]).toContain(
		"lista anterior",
	);
	vi.mocked(listAiModels).mockResolvedValue({
		models: [],
		source: "provider",
		warnings: [],
	});
	rerender({ settingsOpen: false });
	await advance();
	expect(result.current.catalogs.openai?.models).toEqual([]);
});

test("debounce de 800ms e descarte imediato de respostas da chave anterior", async () => {
	const stale = deferred();
	const newest = deferred();
	vi.mocked(listAiModels).mockImplementation((provider, key) =>
		provider === "codex"
			? Promise.resolve(catalog)
			: key === "old-key"
				? stale.promise
				: newest.promise,
	);
	const { result, rerender } = renderHook(
		({ key }) => useAiModels(state, key, false),
		{ initialProps: { key: "old-key" } },
	);
	await advance();
	expect(listAiModels).toHaveBeenCalledWith("openai", "old-key");
	rerender({ key: "new-key" });
	await act(async () => {
		stale.resolve({ ...catalog, models: [{ ...model, value: "gpt-stale" }] });
	});
	expect(result.current.catalogs.openai).toBeUndefined();
	await advance(799);
	expect(listAiModels).not.toHaveBeenCalledWith("openai", "new-key");
	await advance(1);
	expect(listAiModels).toHaveBeenCalledWith("openai", "new-key");
	await act(async () => {
		newest.resolve(catalog);
	});
	expect(result.current.catalogs.openai).toEqual(catalog);
	expect(result.current.loading.openai).toBe(false);
});

test("uma atualização mais recente prevalece mesmo usando a mesma chave", async () => {
	const stale = deferred();
	vi.mocked(listAiModels).mockImplementation((provider) =>
		provider === "openai" ? stale.promise : Promise.resolve(catalog),
	);
	const { result, rerender, unmount } = renderHook(
		({ settingsOpen }) => useAiModels(state, "", settingsOpen),
		{ initialProps: { settingsOpen: false } },
	);
	await advance();
	vi.mocked(listAiModels).mockResolvedValue(catalog);
	rerender({ settingsOpen: true });
	await advance();
	await act(async () => {
		stale.resolve({ ...catalog, models: [] });
	});
	expect(result.current.catalogs.openai).toEqual(catalog);
	unmount();
});
