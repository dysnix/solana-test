import axios from 'axios';
import { HealthCheckResult } from './types';
import { Logger } from './logger';

export class HealthChecker {
  private logger: Logger;
  private endpoint: string;
  private timeout: number;

  constructor(endpoint: string, timeout: number = 10000) {
    this.logger = Logger.getInstance();
    this.endpoint = endpoint;
    this.timeout = timeout;
  }

  async checkHealth(): Promise<HealthCheckResult> {
    const startTime = Date.now();
    
    try {
      this.logger.debug('Performing health check', { endpoint: this.endpoint });
      
      const response = await axios.post(
        this.endpoint,
        {
          jsonrpc: '2.0',
          id: 'health-check',
          method: 'getSlot',
          params: []
        },
        {
          timeout: this.timeout,
          headers: { 'Content-Type': 'application/json' }
        }
      );

      const latency = Date.now() - startTime;
      
      if (response.data.error) {
        this.logger.warn('Health check failed with RPC error', { 
          error: response.data.error.message,
          code: response.data.error.code,
          latency 
        });
        
        return {
          isHealthy: false,
          latency,
          error: `RPC Error: ${response.data.error.message}`,
          timestamp: startTime
        };
      }

      this.logger.debug('Health check passed', { latency });
      
      return {
        isHealthy: true,
        latency,
        timestamp: startTime
      };
    } catch (error) {
      const latency = Date.now() - startTime;
      let errorMessage = 'Unknown error';
      
      if (axios.isAxiosError(error)) {
        if (error.code === 'ECONNABORTED') {
          errorMessage = 'Request timeout';
        } else if (error.response) {
          errorMessage = `HTTP ${error.response.status}: ${error.response.statusText}`;
        } else if (error.request) {
          errorMessage = 'Network error - no response received';
        } else {
          errorMessage = error.message;
        }
      } else if (error instanceof Error) {
        errorMessage = error.message;
      }

      this.logger.warn('Health check failed', { 
        error: errorMessage, 
        latency,
        endpoint: this.endpoint 
      });
      
      return {
        isHealthy: false,
        latency,
        error: errorMessage,
        timestamp: startTime
      };
    }
  }

  async checkHealthWithRetry(maxRetries: number = 3, retryDelay: number = 1000): Promise<HealthCheckResult> {
    let lastResult: HealthCheckResult | null = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      this.logger.debug(`Health check attempt ${attempt}/${maxRetries}`, { endpoint: this.endpoint });
      
      lastResult = await this.checkHealth();
      
      if (lastResult.isHealthy) {
        this.logger.info(`Health check passed on attempt ${attempt}`, { 
          latency: lastResult.latency,
          endpoint: this.endpoint 
        });
        return lastResult;
      }
      
      if (attempt < maxRetries) {
        this.logger.debug(`Health check failed, retrying in ${retryDelay}ms`, { 
          attempt, 
          error: lastResult.error 
        });
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
    
    this.logger.error(`Health check failed after ${maxRetries} attempts`, { 
      endpoint: this.endpoint,
      lastError: lastResult?.error 
    });
    
    return lastResult!;
  }

  async monitorHealth(interval: number, callback?: (result: HealthCheckResult) => void): Promise<NodeJS.Timeout> {
    this.logger.info(`Starting health monitoring every ${interval}ms`, { endpoint: this.endpoint });
    
    const healthInterval = setInterval(async () => {
      try {
        const result = await this.checkHealth();
        
        if (callback) {
          callback(result);
        }
        
        if (!result.isHealthy) {
          this.logger.warn('Health monitoring detected unhealthy endpoint', { 
            error: result.error,
            latency: result.latency,
            endpoint: this.endpoint 
          });
        }
      } catch (error) {
        this.logger.error('Health monitoring failed', { 
          error: error instanceof Error ? error.message : String(error),
          endpoint: this.endpoint 
        });
      }
    }, interval);
    
    return healthInterval;
  }

  static async quickHealthCheck(endpoint: string, timeout: number = 5000): Promise<HealthCheckResult> {
    const checker = new HealthChecker(endpoint, timeout);
    return checker.checkHealth();
  }

  static async validateEndpoint(endpoint: string): Promise<{ isValid: boolean; error?: string }> {
    try {
      new URL(endpoint);
      return { isValid: true };
    } catch {
      return { isValid: false, error: 'Invalid URL format' };
    }
  }
}
