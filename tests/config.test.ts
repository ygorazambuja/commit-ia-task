import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigFilePath, loadConfig, saveConfig } from "../src/config";

const originalConfigDir = process.env.COMMIT_IA_TASK_CONFIG_DIR;
let tempDir: string;

describe("config persistence", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "commit-ia-task-config-"));
		process.env.COMMIT_IA_TASK_CONFIG_DIR = tempDir;
	});

	afterEach(() => {
		if (originalConfigDir === undefined) {
			delete process.env.COMMIT_IA_TASK_CONFIG_DIR;
		} else {
			process.env.COMMIT_IA_TASK_CONFIG_DIR = originalConfigDir;
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("saves and loads config from the configured directory", async () => {
		const config = {
			sprintId: "SPRINT-1",
			areaPathId: "AREA-2",
			assignedTo: "Pessoa <dev@example.com>",
			itemContrato: "Item 3",
			azureOrganization: "https://dev.azure.com/org",
			azureProject: "Projeto",
		};

		await saveConfig(config);

		expect(getConfigFilePath()).toBe(join(tempDir, "config.json"));
		expect(existsSync(getConfigFilePath())).toBe(true);
		expect(await loadConfig()).toEqual(config);
	});

	test("returns null when no config file exists", async () => {
		expect(await loadConfig()).toBeNull();
	});

	test("returns null when the config file is invalid", async () => {
		await writeFile(getConfigFilePath(), "{invalid-json");

		expect(await loadConfig()).toBeNull();
	});

	test("returns null when a config field has an invalid type", async () => {
		await writeFile(
			getConfigFilePath(),
			JSON.stringify({
				sprintId: "SPRINT-1",
				areaPathId: "AREA-2",
				assignedTo: 42,
				itemContrato: "Item 3",
				azureOrganization: "",
				azureProject: "",
			}),
		);

		expect(await loadConfig()).toBeNull();
	});

	test("loads legacy config without Azure DevOps fields", async () => {
		await writeFile(
			getConfigFilePath(),
			JSON.stringify({
				sprintId: "SPRINT-1",
				areaPathId: "AREA-2",
				assignedTo: "Pessoa <dev@example.com>",
				itemContrato: "Item 3",
			}),
		);

		expect(await loadConfig()).toEqual({
			sprintId: "SPRINT-1",
			areaPathId: "AREA-2",
			assignedTo: "Pessoa <dev@example.com>",
			itemContrato: "Item 3",
			azureOrganization: "",
			azureProject: "",
		});
	});
});
