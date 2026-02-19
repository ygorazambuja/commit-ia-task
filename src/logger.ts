// Logger simples e compatível com Bun
type LogLevel = "debug" | "info" | "warn" | "error";

interface LogData {
	[key: string]: unknown;
}

class SimpleLogger {
	private level: LogLevel;
	private readonly maxStringLength = 140;
	private readonly maxArrayItems = 3;
	private readonly maxObjectEntries = 6;
	private levels: Record<LogLevel, number> = {
		debug: 0,
		info: 1,
		warn: 2,
		error: 3,
	};

	constructor(level: LogLevel = "info") {
		this.level = (process.env.LOG_LEVEL as LogLevel) || level;
	}

	private shouldLog(level: LogLevel): boolean {
		return this.levels[level] >= this.levels[this.level];
	}

	private sanitizeText(text: string): string {
		return text.replace(/\s+/g, " ").trim();
	}

	private truncate(text: string): string {
		return text.length > this.maxStringLength
			? `${text.slice(0, this.maxStringLength)}...`
			: text;
	}

	private formatValue(value: unknown, depth = 0): string {
		if (value == null) {
			return String(value);
		}

		if (value instanceof Error) {
			return `${value.name}: ${this.truncate(this.sanitizeText(value.message))}`;
		}

		if (typeof value === "string") {
			return this.truncate(this.sanitizeText(value));
		}

		if (typeof value === "number" || typeof value === "boolean") {
			return String(value);
		}

		if (Array.isArray(value)) {
			if (value.length === 0) {
				return "[]";
			}

			const items = value
				.slice(0, this.maxArrayItems)
				.map((item) => this.formatValue(item, depth + 1));
			const suffix =
				value.length > this.maxArrayItems
					? `...(+${value.length - this.maxArrayItems})`
					: "";
			return `[${items.join(", ")}${suffix}]`;
		}

		if (typeof value === "object") {
			if (depth >= 2) {
				return "[obj]";
			}

			const entries = Object.entries(value as Record<string, unknown>);
			if (entries.length === 0) {
				return "{}";
			}

			const formatted = entries
				.slice(0, this.maxObjectEntries)
				.map(
					([key, entryValue]) =>
						`${key}:${this.formatValue(entryValue, depth + 1)}`,
				);
			const suffix =
				entries.length > this.maxObjectEntries
					? ` ...(+${entries.length - this.maxObjectEntries})`
					: "";
			return `{${formatted.join(" ")}${suffix}}`;
		}

		return this.truncate(this.sanitizeText(String(value)));
	}

	private formatData(data?: LogData): string {
		if (!data) {
			return "";
		}

		const pairs = Object.entries(data).map(
			([key, value]) => `${key}=${this.formatValue(value)}`,
		);
		return pairs.length > 0 ? ` | ${pairs.join(" ")}` : "";
	}

	private formatMessage(
		level: LogLevel,
		message: string,
		data?: LogData,
	): string {
		const timestamp = new Date().toLocaleTimeString();
		const colors = {
			debug: "\x1b[36m", // cyan
			info: "\x1b[32m", // green
			warn: "\x1b[33m", // yellow
			error: "\x1b[31m", // red
		};
		const reset = "\x1b[0m";

		const coloredLevel = `${colors[level]}${level.toUpperCase()}${reset}`;
		const dataStr = this.formatData(data);

		return `[${timestamp}] ${coloredLevel} ${this.sanitizeText(message)}${dataStr}`;
	}

	debug(message: string, data?: LogData): void {
		if (this.shouldLog("debug")) {
			console.log(this.formatMessage("debug", message, data));
		}
	}

	info(message: string, data?: LogData): void {
		if (this.shouldLog("info")) {
			console.log(this.formatMessage("info", message, data));
		}
	}

	warn(message: string, data?: LogData): void {
		if (this.shouldLog("warn")) {
			console.warn(this.formatMessage("warn", message, data));
		}
	}

	error(message: string, data?: LogData): void {
		if (this.shouldLog("error")) {
			console.error(this.formatMessage("error", message, data));
		}
	}
}

export const logger = new SimpleLogger();

// Utilitário para formatação de duração
export const formatDuration = (ms: number): string => {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${(ms / 60000).toFixed(1)}min`;
};

// Utilitário para formatação de tamanho de arquivo
export const formatFileSize = (bytes: number): string => {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
};
