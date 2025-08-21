#!/usr/bin/env node

import { Command } from 'commander';
import { HealthChecker } from './health-checker';
import { Logger, LogLevel } from './logger';
import chalk from 'chalk';

const program = new Command();

program
  .name('solana-health-check')
  .description('Health check tool for Solana RPC endpoints')
  .version('2.0.0');

program
  .option('-e, --endpoint <url>', 'Solana RPC endpoint URL', 'https://api.mainnet-beta.solana.com')
  .option('-t, --timeout <ms>', 'Request timeout in milliseconds', '10000')
  .option('--retries <number>', 'Number of retry attempts', '3')
  .option('--retry-delay <ms>', 'Delay between retries in milliseconds', '1000')
  .option('--monitor <interval>', 'Continuous monitoring interval in milliseconds (0 to disable)', '0')
  .option('--verbose', 'Enable verbose logging', false)
  .option('--log-level <level>', 'Log level: debug, info, warn, error, silent', 'info');

program.parse();

const options = program.opts();

async function main() {
  try {
    // Initialize logger
    const logger = Logger.getInstance();
    const logLevel = LogLevel[options.logLevel.toUpperCase() as keyof typeof LogLevel] || LogLevel.INFO;
    logger.setLogLevel(logLevel);

    logger.section('SOLANA RPC HEALTH CHECK');
    
    // Validate endpoint
    const endpointValidation = await HealthChecker.validateEndpoint(options.endpoint);
    if (!endpointValidation.isValid) {
      logger.error('Invalid endpoint URL', { 
        endpoint: options.endpoint, 
        error: endpointValidation.error 
      });
      process.exit(1);
    }

    // Show configuration
    logger.section('Configuration');
    logger.info(`Endpoint:     ${chalk.cyan(options.endpoint)}`);
    logger.info(`Timeout:      ${chalk.cyan(options.timeout)}ms`);
    logger.info(`Retries:      ${chalk.cyan(options.retries)}`);
    logger.info(`Retry Delay:  ${chalk.cyan(options.retryDelay)}ms`);
    logger.info(`Monitoring:   ${chalk.cyan(options.monitor > 0 ? `${options.monitor}ms` : 'Disabled')}`);

    // Create health checker
    const healthChecker = new HealthChecker(options.endpoint, parseInt(options.timeout));

    if (options.monitor > 0) {
      // Continuous monitoring mode
      logger.info('🔍 Starting continuous health monitoring...');
      
      const interval = await healthChecker.monitorHealth(parseInt(options.monitor), (result) => {
        const timestamp = new Date(result.timestamp).toLocaleTimeString();
        const status = result.isHealthy ? chalk.green('✅') : chalk.red('❌');
        const latency = `${result.latency}ms`;
        
        if (result.isHealthy) {
          logger.info(`${status} Health check passed at ${timestamp} - Latency: ${latency}`);
        } else {
          logger.warn(`${status} Health check failed at ${timestamp} - Latency: ${latency} - Error: ${result.error}`);
        }
      });

      // Keep the process running
      process.on('SIGINT', () => {
        logger.info('🛑 Stopping health monitoring...');
        clearInterval(interval);
        process.exit(0);
      });

      // Keep alive
      await new Promise(() => {}); // This will never resolve
      
    } else {
      // Single health check mode
      logger.info('🔍 Performing health check...');
      
      const result = await healthChecker.checkHealthWithRetry(
        parseInt(options.retries), 
        parseInt(options.retryDelay)
      );

      // Display results
      logger.section('Health Check Results');
      
      if (result.isHealthy) {
        logger.info(`${chalk.green('✅')} Endpoint is healthy`);
        logger.info(`Latency: ${chalk.cyan(result.latency)}ms`);
        logger.info(`Timestamp: ${chalk.cyan(new Date(result.timestamp).toISOString())}`);
        
        // Performance assessment
        let performance = 'Good';
        let performanceColor = chalk.green;
        
        if (result.latency > 1000) {
          performance = 'Poor';
          performanceColor = chalk.red;
        } else if (result.latency > 500) {
          performance = 'Fair';
          performanceColor = chalk.yellow;
        }
        
        logger.info(`Performance: ${performanceColor(performance)}`);
        
        process.exit(0);
      } else {
        logger.error(`${chalk.red('❌')} Endpoint is unhealthy`);
        logger.error(`Error: ${chalk.red(result.error)}`);
        logger.error(`Latency: ${chalk.cyan(result.latency)}ms`);
        logger.error(`Timestamp: ${chalk.cyan(new Date(result.timestamp).toISOString())}`);
        
        process.exit(1);
      }
    }

  } catch (error) {
    const logger = Logger.getInstance();
    logger.error('❌ Health check failed', { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  const logger = Logger.getInstance();
  logger.warn('⚠️  Interrupted by user. Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  const logger = Logger.getInstance();
  logger.warn('⚠️  Received SIGTERM. Shutting down gracefully...');
  process.exit(0);
});

if (require.main === module) {
  main().catch((error) => {
    const logger = Logger.getInstance();
    logger.error('❌ Unhandled error', { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });
}
