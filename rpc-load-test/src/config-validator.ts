import { LoadTestConfig } from './types';

export class ConfigValidator {
  private static readonly DEFAULT_CONFIG = {
    maxRetries: 3,
    retryDelay: 1000,
    healthCheckInterval: 5000,
    gracefulShutdown: true,
  };

  static validate(config: Partial<LoadTestConfig>): LoadTestConfig {
    const validatedConfig = { ...this.DEFAULT_CONFIG, ...config };

    // Validate required fields
    if (!validatedConfig.endpoint) {
      throw new Error('Endpoint URL is required');
    }

    if (!this.isValidUrl(validatedConfig.endpoint)) {
      throw new Error('Invalid endpoint URL format');
    }

    // Validate numeric fields
    if (!validatedConfig.duration || validatedConfig.duration <= 0) {
      throw new Error('Duration must be greater than 0');
    }

    if (!validatedConfig.rps || validatedConfig.rps <= 0) {
      throw new Error('RPS must be greater than 0');
    }

    if (!validatedConfig.concurrent || validatedConfig.concurrent <= 0) {
      throw new Error('Concurrent connections must be greater than 0');
    }

    if (validatedConfig.concurrent > 1000) {
      throw new Error('Concurrent connections cannot exceed 1000');
    }

    if (!validatedConfig.timeout || validatedConfig.timeout <= 0) {
      throw new Error('Timeout must be greater than 0');
    }

    if (validatedConfig.timeout > 300000) {
      throw new Error('Timeout cannot exceed 5 minutes (300000ms)');
    }

    // Validate RPS vs concurrent relationship
    if (validatedConfig.rps < validatedConfig.concurrent) {
      throw new Error('RPS should be at least equal to concurrent connections for optimal performance');
    }

    // Validate optional fields
    if (validatedConfig.maxRetries !== undefined && validatedConfig.maxRetries < 0) {
      throw new Error('Max retries cannot be negative');
    }

    if (validatedConfig.retryDelay !== undefined && validatedConfig.retryDelay < 0) {
      throw new Error('Retry delay cannot be negative');
    }

    if (validatedConfig.healthCheckInterval !== undefined && validatedConfig.healthCheckInterval < 1000) {
      throw new Error('Health check interval must be at least 1000ms');
    }

    return validatedConfig as LoadTestConfig;
  }

  private static isValidUrl(url: string): boolean {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }

  static getRecommendedConfig(endpoint: string): Partial<LoadTestConfig> {
    return {
      endpoint,
      duration: 60,
      rps: 100,
      concurrent: 10,
      timeout: 30000,
      maxRetries: 3,
      retryDelay: 1000,
      healthCheckInterval: 5000,
      gracefulShutdown: true,
    };
  }

  static validateMethods(methods: string[]): string[] {
    const validMethods = [
      'getSlot',
      'getTransaction',
      'getMultipleAccounts',
      'getProgramAccounts',
      'getBlock',
      'getLatestBlockhash'
    ];

    if (methods.length === 0) {
      return []; // Return empty array when no methods specified
    }

    const invalidMethods = methods.filter(method => !validMethods.includes(method));
    if (invalidMethods.length > 0) {
      throw new Error(`Invalid RPC methods: ${invalidMethods.join(', ')}. Valid methods: ${validMethods.join(', ')}`);
    }

    return methods;
  }
}
