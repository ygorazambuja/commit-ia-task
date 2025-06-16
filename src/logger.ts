// Logger simples e compatível com Bun
type LogLevel = "debug" | "info" | "warn" | "error";

interface LogData {
  [key: string]: any;
}

class SimpleLogger {
  private level: LogLevel;
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

  private formatMessage(
    level: LogLevel,
    message: string,
    data?: LogData
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
    const dataStr = data ? ` ${JSON.stringify(data, null, 2)}` : "";

    return `[${timestamp}] ${coloredLevel}: ${message}${dataStr}`;
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
