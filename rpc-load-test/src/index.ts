#!/usr/bin/env node

import { Command } from 'commander';
import { SolanaRpcLoadTester } from './load-tester';
import { ResultsReporter } from './reporter';
import { ConfigValidator } from './config-validator';
import { Logger, LogLevel } from './logger';
import { LoadTestConfig, LoadTestOptions } from './types';
import chalk from 'chalk';

const program = new Command();

program
  .name('solana-rpc-load-test')
  .description('Load testing tool for Solana RPC endpoints')
  .version('2.0.0');

program
  .option('-e, --endpoint <url>', 'Solana RPC endpoint URL', 'https://api.mainnet-beta.solana.com')
  .option('-d, --duration <seconds>', 'Test duration in seconds', '60')
  .option('-r, --rps <number>', 'Target requests per second', '100')
  .option('-c, --concurrent <number>', 'Number of concurrent connections', '10')
  .option('-t, --timeout <ms>', 'Request timeout in milliseconds', '30000')
  .option('-m, --methods <methods>', 'Comma-separated list of RPC methods to test (default: all)', '')
  .option('--max-retries <number>', 'Maximum number of retries for failed requests', '3')
  .option('--retry-delay <ms>', 'Delay between retries in milliseconds', '1000')
  .option('--health-check-interval <ms>', 'Health check interval in milliseconds', '5000')
  .option('--health-monitoring', 'Enable health monitoring', true)
  .option('--dry-run', 'Show what would be tested without running', false)
  .option('--progress', 'Show real-time progress', false)
  // .option('--verbose', 'Enable verbose logging', false)
  .option('--output-format <format>', 'Output format: text, json, or csv', 'text')
  .option('--output-file <file>', 'Output file for results', '')
  .option('--log-level <level>', 'Log level: debug, info, warn, error, silent', 'info');

program.parse();

const options = program.opts();

async function main() {
  try {
    // Initialize logger
    const logger = Logger.getInstance();
    const logLevelStr = options.logLevel.toUpperCase();
    const logLevel = LogLevel[logLevelStr as keyof typeof LogLevel];
    logger.setLogLevel(logLevel);

    logger.section('SOLANA RPC LOAD TEST');
    
    // Parse and validate options
    const config: Partial<LoadTestConfig> = {
      endpoint: options.endpoint,
      duration: parseInt(options.duration),
      rps: parseInt(options.rps),
      concurrent: parseInt(options.concurrent),
      timeout: parseInt(options.timeout),
      methods: options.methods ? options.methods.split(',').map((m: string) => m.trim()) : [],
      maxRetries: parseInt(options.maxRetries),
      retryDelay: parseInt(options.retryDelay),
      healthCheckInterval: parseInt(options.healthCheckInterval),
      progress: options.progress,
      gracefulShutdown: true
    };

    logger.debug('Methods parsing', { 
      rawMethods: options.methods, 
      parsedMethods: config.methods,
      methodsLength: config.methods?.length 
    });

    // Validate methods
    try {
      config.methods = ConfigValidator.validateMethods(config.methods || []);
      logger.debug('Methods after validation', { methods: config.methods, originalMethods: options.methods });
    } catch (error) {
      logger.error('Method validation failed', { error: error instanceof Error ? error.message : String(error) });
      process.exit(1);
    }

    // Show configuration
    logger.section('Configuration');
    logger.info(`Endpoint:     ${chalk.cyan(config.endpoint)}`);
    logger.info(`Duration:     ${chalk.cyan(config.duration)}s`);
    logger.info(`Target RPS:   ${chalk.cyan(config.rps)}`);
    logger.info(`Concurrent:   ${chalk.cyan(config.concurrent)}`);
    logger.info(`Timeout:      ${chalk.cyan(config.timeout)}ms`);
    logger.info(`Max Retries:  ${chalk.cyan(config.maxRetries)}`);
    logger.info(`Retry Delay:  ${chalk.cyan(config.retryDelay)}ms`);
    logger.info(`Health Check: ${chalk.cyan(config.healthCheckInterval)}ms`);
    logger.info(`Methods:      ${chalk.cyan(config.methods.length > 0 ? config.methods.join(', ') : 'All methods')}`);

    if (options.dryRun) {
      logger.info('🧪 Dry run mode - no actual testing will be performed');
      return;
    }

    // Create and run load tester
    const loadTester = new SolanaRpcLoadTester(config);

    logger.info('🚀 Starting load test...');
    const results = await loadTester.run();

    // Display results
    ResultsReporter.printResults(results);

    // Export results if requested
    if (options.outputFormat !== 'text' || options.outputFile) {
      await exportResults(results, options);
    }

    // Exit with error code if there are too many failures
    const errorRate = (results.failedRequests / results.totalRequests) * 100;
    if (errorRate > 50) {
      logger.error('❌ High error rate detected. Consider checking your RPC endpoint.');
      process.exit(1);
    }

  } catch (error) {
    const logger = Logger.getInstance();
    logger.error('❌ Error occurred during load test', { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
}

async function exportResults(results: any, options: any): Promise<void> {
  const logger = Logger.getInstance();
  
  try {
    let filename = options.outputFile;
    if (!filename && options.outputFormat !== 'text') {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      filename = `load-test-results-${timestamp}.${options.outputFormat}`;
    }

    switch (options.outputFormat) {
      case 'json':
        ResultsReporter.exportToJson(results, filename);
        break;
      case 'csv':
        ResultsReporter.exportToCsv(results, filename);
        break;
      default:
        if (filename) {
          logger.warn(`Unknown output format: ${options.outputFormat}. Results not exported.`);
        }
    }
  } catch (error) {
    logger.error('Failed to export results', { error: error instanceof Error ? error.message : String(error) });
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  const logger = Logger.getInstance();
  logger.warn('⚠️  Interrupted by user. Shutting down gracefully...');
  
  // TODO: Implement graceful shutdown for load tester
  // if (loadTester && loadTester.isRunning) {
  //   await loadTester.stop();
  // }
  
  process.exit(0);
});

process.on('SIGTERM', async () => {
  const logger = Logger.getInstance();
  logger.warn('⚠️  Received SIGTERM. Shutting down gracefully...');
  
  // TODO: Implement graceful shutdown for load tester
  // if (loadTester && loadTester.isRunning) {
  //   await loadTester.stop();
  // }
  
  process.exit(0);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  const logger = Logger.getInstance();
  logger.error('Unhandled promise rejection', { reason: String(reason) });
  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  const logger = Logger.getInstance();
  logger.error('Uncaught exception', { error: error.message, stack: error.stack });
  process.exit(1);
});

if (require.main === module) {
  main().catch((error) => {
    const logger = Logger.getInstance();
    logger.error('❌ Unhandled error', { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });
}
