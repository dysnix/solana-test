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

    if (validatedConfig.websocketEndpoint !== undefined && validatedConfig.websocketEndpoint !== '' && !this.isValidWebSocketUrl(validatedConfig.websocketEndpoint)) {
      throw new Error('Invalid websocket endpoint URL format (use ws:// or wss://)');
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

  private static readonly HTTP_PROTOCOLS = ['http:', 'https:'];
  private static readonly VALID_METHODS = [
    'getSlot',
    'getBalance',
    'getTransaction',
    'getSignaturesForAddress',
    'getMultipleAccounts',
    'getProgramAccounts',
    'getBlock',
    'getLatestBlockhash',
    'getTokenAccountsByOwner',
    'getTokenAccountBalance',
    'getTokenLargestAccounts',
    'getTokenAccountsByDelegate',
  ];

  private static isValidUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return this.HTTP_PROTOCOLS.includes(parsed.protocol);
    } catch {
      return false;
    }
  }

  private static isValidWebSocketUrl(url: string): boolean {
    const validated = /^wss?:\/\/.+/i.test(url.trim());
    return validated;
  }

  static getRecommendedConfig(endpoint: string): Partial<LoadTestConfig> {
    return {
      endpoint,
      duration: 60,
      rps: 100,
      concurrent: 10,
      timeout: 1000,
      maxRetries: 3,
      retryDelay: 1000,
      healthCheckInterval: 5000,
      gracefulShutdown: true,
    };
  }

  static validateMethods(methods: string[]): string[] {
    if (methods.length === 0) {
      return []; // Return empty array when no methods specified
    }

    const invalidMethods = methods.filter(method => !this.VALID_METHODS.includes(method));
    if (invalidMethods.length > 0) {
      throw new Error(`Invalid RPC methods: ${invalidMethods.join(', ')}. Valid methods: ${this.VALID_METHODS.join(', ')}`);
    }

    return methods;
  }

  static getValidMethods(): string[] {
    return [...this.VALID_METHODS];
  }
}
