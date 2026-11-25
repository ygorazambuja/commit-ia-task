import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolveClaudeExecutable } from "../src/ai-claude";

const missing = () => {
	throw new Error("Cannot find module");
};
const onPath = () => "/usr/local/bin/claude";

describe("resolveClaudeExecutable", () => {
	test("CLAUDE_CODE_PATH wins over everything", () => {
		expect(
			resolveClaudeExecutable({
				env: { CLAUDE_CODE_PATH: "/custom/claude" },
				resolve: missing,
				which: onPath,
			}),
		).toBe("/custom/claude");
	});

	test("lets the SDK use its bundled binary when it exists", () => {
		expect(
			resolveClaudeExecutable({
				env: {},
				resolve: (id) => id,
				exists: () => true,
				which: onPath,
			}),
		).toBeUndefined();
	});

	test("falls back to PATH when the platform package is missing", () => {
		expect(
			resolveClaudeExecutable({ env: {}, resolve: missing, which: onPath }),
		).toBe("/usr/local/bin/claude");
	});

	// O caso do erro original: pacote instalado, mas sem o binário dentro.
	test("falls back to PATH when the package exists without the binary", () => {
		expect(
			resolveClaudeExecutable({
				env: {},
				resolve: (id) => id,
				exists: () => false,
				which: onPath,
			}),
		).toBe("/usr/local/bin/claude");
	});

	test("returns undefined when there is no fallback either", () => {
		expect(
			resolveClaudeExecutable({ env: {}, resolve: missing, which: () => null }),
		).toBeUndefined();
	});
});

test("finds a usable Claude binary on this machine", () => {
	const path = resolveClaudeExecutable();
	// undefined = o SDK achou o próprio binário; senão precisa existir o do PATH.
	if (path !== undefined) expect(existsSync(path)).toBe(true);
});
