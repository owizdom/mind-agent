import * as fs from 'fs';
import * as path from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

class Logger {
  private logFile: string | null = null;
  private minLevel: LogLevel = 'info';

  setLogFile(filePath: string): void {
    this.logFile = filePath;
    // Ensure directory exists
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  private formatMessage(level: LogLevel, message: string, meta?: object): string {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`;
  }

  private write(level: LogLevel, message: string, meta?: object): void {
    if (LOG_LEVELS[level] < LOG_LEVELS[this.minLevel]) {
      return;
    }

    const formatted = this.formatMessage(level, message, meta);

    // Write to console
    const consoleFn = level === 'error' ? console.error : 
                      level === 'warn' ? console.warn : 
                      console.log;
    consoleFn(formatted);

    // Write to file if configured
    if (this.logFile) {
      fs.appendFileSync(this.logFile, formatted + '\n');
    }
  }

  debug(message: string, meta?: object): void {
    this.write('debug', message, meta);
  }

  info(message: string, meta?: object): void {
    this.write('info', message, meta);
  }

  warn(message: string, meta?: object): void {
    this.write('warn', message, meta);
  }

  error(message: string, meta?: object): void {
    this.write('error', message, meta);
  }
}

// Singleton logger instance
export const logger = new Logger();
