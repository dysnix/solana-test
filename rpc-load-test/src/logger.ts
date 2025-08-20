import chalk from 'chalk';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4
}

export interface LogContext {
  workerId?: number;
  method?: string;
  requestId?: string | number;
  [key: string]: any;
}

export class Logger {
  private static instance: Logger;
  private logLevel: LogLevel = LogLevel.INFO;
  private isVerbose: boolean = false;
  private logBuffer: string[] = [];
  private maxBufferSize: number = 1000;

  private constructor() {}

  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  setLogLevel(level: LogLevel): void {
    this.logLevel = level;
  }

  setVerbose(verbose: boolean): void {
    this.isVerbose = verbose;
    if (verbose && this.logLevel > LogLevel.DEBUG) {
      this.logLevel = LogLevel.DEBUG;
    }
  }

  private formatMessage(level: LogLevel, message: string, context?: LogContext): string {
    const timestamp = new Date().toISOString();
    const levelStr = this.getLevelString(level);
    const contextStr = context ? this.formatContext(context) : '';
    
    return `${timestamp} [${levelStr}] ${message}${contextStr}`;
  }

  private formatContext(context: LogContext): string {
    const parts = Object.entries(context)
      .filter(([_, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    
    return parts ? ` | ${parts}` : '';
  }

  private getLevelString(level: LogLevel): string {
    switch (level) {
      case LogLevel.DEBUG: return chalk.gray('DEBUG');
      case LogLevel.INFO: return chalk.blue('INFO ');
      case LogLevel.WARN: return chalk.yellow('WARN ');
      case LogLevel.ERROR: return chalk.red('ERROR');
      default: return '     ';
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return level >= this.logLevel;
  }

  private log(level: LogLevel, message: string, context?: LogContext): void {
    if (!this.shouldLog(level)) return;

    const formattedMessage = this.formatMessage(level, message, context);
    
    // Add to buffer for potential export
    this.logBuffer.push(formattedMessage);
    if (this.logBuffer.length > this.maxBufferSize) {
      this.logBuffer.shift();
    }

    // Console output with colors
    switch (level) {
      case LogLevel.DEBUG:
        console.log(chalk.gray(formattedMessage));
        break;
      case LogLevel.INFO:
        console.log(formattedMessage);
        break;
      case LogLevel.WARN:
        console.log(chalk.yellow(formattedMessage));
        break;
      case LogLevel.ERROR:
        console.error(chalk.red(formattedMessage));
        break;
    }
  }

  debug(message: string, context?: LogContext): void {
    this.log(LogLevel.DEBUG, message, context);
  }

  info(message: string, context?: LogContext): void {
    this.log(LogLevel.INFO, message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.log(LogLevel.WARN, message, context);
  }

  error(message: string, context?: LogContext): void {
    this.log(LogLevel.ERROR, message, context);
  }

  // Progress logging for real-time updates
  progress(message: string): void {
    if (this.logLevel <= LogLevel.INFO) {
      process.stdout.write(`\r${message}`);
    }
  }

  clearProgress(): void {
    if (this.logLevel <= LogLevel.INFO) {
      process.stdout.write('\n');
    }
  }

  // Section headers for better readability
  section(title: string): void {
    if (this.logLevel <= LogLevel.INFO) {
      console.log('\n' + chalk.bold.blue('─'.repeat(60)));
      console.log(chalk.bold.blue(`📋 ${title}`));
      console.log(chalk.bold.blue('─'.repeat(60)));
    }
  }

  // Get logs for export
  getLogs(): string[] {
    return [...this.logBuffer];
  }

  // Clear logs
  clearLogs(): void {
    this.logBuffer = [];
  }

  // Export logs to file
  async exportLogs(filename: string): Promise<void> {
    const fs = await import('fs/promises');
    const logs = this.getLogs().join('\n');
    await fs.writeFile(filename, logs, 'utf8');
  }
}
