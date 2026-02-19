import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "./logger";

export interface SavedConfig {
	sprintId: string;
	areaPathId: string;
	assignedTo: string;
	itemContrato: string;
}

const APP_NAME = "commit-ia-task";

const getConfigDir = (): string => {
	if (process.platform === "win32") {
		const appData = process.env.APPDATA;
		return appData
			? join(appData, APP_NAME)
			: join(homedir(), ".config", APP_NAME);
	}

	if (process.platform === "darwin") {
		return join(homedir(), "Library", "Application Support", APP_NAME);
	}

	const xdgConfigHome = process.env.XDG_CONFIG_HOME;
	if (xdgConfigHome) {
		return join(xdgConfigHome, APP_NAME);
	}

	return join(homedir(), ".config", APP_NAME);
};

export const getConfigFilePath = (): string => {
	return join(getConfigDir(), "config.json");
};

export async function saveConfig(config: SavedConfig): Promise<void> {
	try {
		const configFile = getConfigFilePath();
		await mkdir(getConfigDir(), { recursive: true });
		await Bun.write(configFile, JSON.stringify(config, null, 2));
		logger.debug("💾 Configurações salvas", { configFile });
	} catch (error) {
		logger.warn("⚠️ Não foi possível salvar configurações", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export async function loadConfig(): Promise<SavedConfig | null> {
	try {
		const configFile = getConfigFilePath();
		if (!existsSync(configFile)) {
			logger.debug("📂 Nenhuma configuração salva encontrada");
			return null;
		}

		const file = Bun.file(configFile);
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
