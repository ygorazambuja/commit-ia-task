import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "./logger";

interface SavedConfig {
	sprintId: string;
	areaPathId: string;
	assignedTo: string;
}

const CONFIG_FILE = join(tmpdir(), "commit-ia-task-config.json");

export async function saveConfig(config: SavedConfig): Promise<void> {
	try {
		await Bun.write(CONFIG_FILE, JSON.stringify(config, null, 2));
		logger.debug("💾 Configurações salvas", { configFile: CONFIG_FILE });
	} catch (error) {
		logger.warn("⚠️ Não foi possível salvar configurações", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export async function loadConfig(): Promise<SavedConfig | null> {
	try {
		if (!existsSync(CONFIG_FILE)) {
			logger.debug("📂 Nenhuma configuração salva encontrada");
			return null;
		}

		const file = Bun.file(CONFIG_FILE);
		const content = await file.text();
		const config = JSON.parse(content) as SavedConfig;

		logger.debug("📂 Configurações carregadas do cache", { config });
		return config;
	} catch (error) {
		logger.warn("⚠️ Erro ao carregar configurações salvas", {
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}
