import axios, { AxiosResponse } from 'axios';
import { RpcRequest, RpcResponse, TestResult, LoadTestConfig, LoadTestResults, WorkerStats, HealthCheckResult } from './types';
import { RpcMethodGenerator } from './rpc-methods';
import { Logger } from './logger';
import { ConfigValidator } from './config-validator';

export class SolanaRpcLoadTester {
  private config: LoadTestConfig;
  private results: TestResult[] = [];
  private workerStats: WorkerStats[] = [];
  private startTime: number = 0;
  private endTime: number = 0;
  private requestCount: number = 0;
  private errorCount: number = 0;
  private isRunning: boolean = false;
  private isShuttingDown: boolean = false;
  private rpcMethodGenerator: RpcMethodGenerator;
  private logger: Logger;
  private workers: Map<number, Promise<void>> = new Map();
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private progressInterval: NodeJS.Timeout | null = null;
  private nextRequestSlotMs: number = 0;

  constructor(config: Partial<LoadTestConfig>) {
    this.config = ConfigValidator.validate(config);
    this.rpcMethodGenerator = new RpcMethodGenerator(this.config);
    this.logger = Logger.getInstance();
  }

  async run(): Promise<LoadTestResults> {
    if (this.isRunning) {
      throw new Error('Load test is already running');
    }

    try {
      await this.performHealthCheck();
      await this.startLoadTest();
      await this.waitForCompletion();
      return this.calculateResults();
    } catch (error) {
      this.logger.error('Load test failed', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      await this.cleanup();
    }
  }

  private async performHealthCheck(): Promise<void> {
    this.logger.info('Performing health check...');
    const healthResult = await this.healthCheck();
    
    if (!healthResult.isHealthy) {
      throw new Error(`Endpoint health check failed: ${healthResult.error}`);
    }
    
    this.logger.info(`Health check passed - latency: ${healthResult.latency}ms`);
  }

  private async startLoadTest(): Promise<void> {
    this.isRunning = true;
    this.results = [];
    this.workerStats = [];
    this.requestCount = 0;
    this.errorCount = 0;
    this.startTime = Date.now();
    this.nextRequestSlotMs = this.startTime;

    this.logger.section('Load Test Runtime Settings');
    this.logger.info(`🚀 Starting load test for ${this.config.duration}s at ${this.config.rps} RPS`);
    this.logger.info(`📡 Endpoint: ${this.config.endpoint}`);
    this.logger.info(`🔌 WebSocket: ${this.config.websocketEndpoint ?? 'none (mock data)'}`);
    this.logger.info(`🔀 Concurrent connections: ${this.config.concurrent}`);
    this.logger.info(`⏱️  Timeout: ${this.config.timeout}ms`);
    this.logger.info(`💚 Health check interval: ${this.config.healthCheckInterval}ms`);
    this.logger.info(`⚙️  Methods: ${this.config.methods.length > 0 ? this.config.methods.join(', ') : 'All methods'}`);

    // Wait for RPC method generator initialization to complete
    this.logger.debug('Waiting for RPC method generator initialization...');
    await this.rpcMethodGenerator.waitForInitialization();
    this.logger.debug('RPC method generator initialized');

    this.logger.debug('Load test methods configuration', { 
      methods: this.config.methods, 
      methodsCount: this.config.methods.length,
      willUseRandom: this.config.methods.length === 0 
    });

    this.logger.info(`🔄 Starting ${this.config.concurrent} worker threads...`);
    this.logger.info(`⏱️  Target RPS: ${this.config.rps}, Workers: ${this.config.concurrent}, Global rate limiter: enabled`);
    
    // Start concurrent workers
    for (let i = 0; i < this.config.concurrent; i++) {
      const workerPromise = this.worker(i);
      this.workers.set(i, workerPromise);
    }

    // Start health monitoring
    if (this.config.healthMonitoring) {
      this.startHealthMonitoring();
    }
    
    // Start progress monitoring
    if (this.config.progress) {
      this.startProgressMonitoring();
    }
  }

  private async waitForCompletion(): Promise<void> {
    
    // Wait for duration
    await new Promise(resolve => setTimeout(resolve, this.config.duration * 1000));
    
    this.logger.info('🛑 Duration completed, initiating graceful shutdown...');
    this.isShuttingDown = true;
    this.isRunning = false;

    // Wait for all workers to finish
    const workerPromises = Array.from(this.workers.values());
    await Promise.allSettled(workerPromises);
    
    this.endTime = Date.now();
  }

  private async cleanup(): Promise<void> {
    this.logger.info('🧹 Cleaning up resources...');
    
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }

    await this.rpcMethodGenerator.cleanup();
    
    this.isRunning = false;
    this.isShuttingDown = false;
  }

  private startHealthMonitoring(): void {
    if (this.config.healthCheckInterval && this.config.healthCheckInterval > 0) {
      this.healthCheckInterval = setInterval(async () => {
        try {
          const healthResult = await this.healthCheck();
          if (!healthResult.isHealthy) {
            this.logger.warn('Health check failed during load test', { 
              error: healthResult.error, 
              latency: healthResult.latency 
            });
          }
        } catch (error) {
          this.logger.error('Health check monitoring failed', { error: error instanceof Error ? error.message : String(error) });
        }
      }, this.config.healthCheckInterval);
    }
  }

  private startProgressMonitoring(): void {
    this.progressInterval = setInterval(() => {
      const stats = this.getCurrentStats();
      this.logger.progress(
        `⏱️  Progress: ${stats.elapsed.toFixed(1)}s elapsed | ` +
        `📊 ${stats.requests} requests | ` +
        `❌ ${stats.errors} errors | ` +
        `🚀 ${(stats.requests / Math.max(stats.elapsed, 1)).toFixed(2)} RPS`
      );
    }, 1000);
  }

  private async worker(workerId: number): Promise<void> {
    const workerStartTime = Date.now();
    let requestsProcessed = 0;
    let errors = 0;
    let totalLatency = 0;
    
    this.logger.debug(`Worker ${workerId} started`, { workerId });
    
    try {
      while (this.isRunning && !this.isShuttingDown) {
        const startTime = Date.now();
        
        try {
          const method = await this.selectRandomMethod();
          const result = await this.makeRequest(method, workerId);
          
          this.results.push(result);
          requestsProcessed++;
          totalLatency += result.latency;
          
          if (result.success) {
            this.requestCount++;
          } else {
            this.errorCount++;
            errors++;
          }
          
        } catch (error) {
          this.logger.error(`Worker ${workerId} error`, { 
            workerId, 
            error: error instanceof Error ? error.message : String(error) 
          });
          
          this.errorCount++;
          errors++;
          
          const result: TestResult = {
            method: 'unknown',
            success: false,
            latency: Date.now() - startTime,
            timestamp: startTime,
            error: error instanceof Error ? error.message : String(error),
            workerId
          };
          this.results.push(result);
        }

      }
    } finally {
      const workerEndTime = Date.now();
      const avgLatency = requestsProcessed > 0 ? totalLatency / requestsProcessed : 0;
      
      this.workerStats.push({
        workerId,
        requestsProcessed,
        errors,
        avgLatency,
        startTime: workerStartTime,
        endTime: workerEndTime
      });
      
      this.logger.debug(`Worker ${workerId} stopped`, { 
        workerId, 
        requestsProcessed, 
        errors, 
        avgLatency: avgLatency.toFixed(2) 
      });
    }
  }

  private async acquireRequestSlot(): Promise<void> {
    const now = Date.now();
    const minIntervalMs = 1000 / this.config.rps;
    const scheduledAt = Math.max(now, this.nextRequestSlotMs);
    this.nextRequestSlotMs = scheduledAt + minIntervalMs;

    const waitMs = scheduledAt - now;
    if (waitMs > 0) {
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }

  private async selectRandomMethod(): Promise<RpcRequest> {
    this.logger.debug('Selecting method', { 
      specifiedMethods: this.config.methods, 
      methodsCount: this.config.methods.length 
    });
    
    if (this.config.methods.length === 0) {
      this.logger.debug('No methods specified, using random method');
      return await this.rpcMethodGenerator.generateRandomMethod();
    }

    const methodName = this.config.methods[Math.floor(Math.random() * this.config.methods.length)];
    this.logger.debug('Selected method from specified list', { methodName });
    
    switch (methodName) {
      case 'getSlot':
        return this.rpcMethodGenerator.getSlot();
      case 'getBalance':
        return this.rpcMethodGenerator.getBalance();
      case 'getTransaction':
        return this.rpcMethodGenerator.getTransaction();
      case 'getSignaturesForAddress':
        return this.rpcMethodGenerator.getSignaturesForAddress();
      case 'getMultipleAccounts':
        return this.rpcMethodGenerator.getMultipleAccounts();
      case 'getProgramAccounts':
        return this.rpcMethodGenerator.getProgramAccounts();
      case 'getBlock':
        return this.rpcMethodGenerator.getBlock();
      case 'getLatestBlockhash':
        return this.rpcMethodGenerator.getLatestBlockhash();
      default:
        throw new Error(`Invalid method specified: ${methodName}. Valid methods: ${this.config.methods.join(', ')}`);
    }
  }

  private async makeRequest(request: RpcRequest, workerId: number, attempt: number = 1): Promise<TestResult> {
    await this.acquireRequestSlot();
    const startTime = Date.now();
    
    this.logger.debug(`Sending ${request.method} request`, { 
      workerId, 
      method: request.method, 
      requestId: request.id,
      attempt 
    });
    
    try {
      const response: AxiosResponse<RpcResponse> = await axios.post(
        this.config.endpoint,
        request,
        {
          timeout: this.config.timeout,
          headers: {
            'Content-Type': 'application/json',
          }
        }
      );

      const endTime = Date.now();
      const latency = endTime - startTime;

      if (response.data.error) {
        this.logger.debug(`${request.method} failed with RPC error`, { 
          workerId, 
          method: request.method, 
          error: response.data.error.message,
          code: response.data.error.code 
        });
        
        return {
          method: request.method,
          success: false,
          latency,
          timestamp: startTime,
          error: `RPC Error ${response.data.error.code}: ${response.data.error.data?.toString()}`,
          responseSize: JSON.stringify(response.data).length,
          requestDetails: {
            id: request.id,
            params: request.params
          },
          workerId,
          attempt
        };
      }

      this.logger.debug(`${request.method} completed successfully`, { 
        workerId, 
        method: request.method, 
        latency 
      });
      
      return {
        method: request.method,
        success: true,
        latency,
        timestamp: startTime,
        responseSize: JSON.stringify(response.data).length,
        requestDetails: {
          id: request.id,
          params: request.params
        },
        workerId,
        attempt
      };

    } catch (error) {
      const endTime = Date.now();
      const latency = endTime - startTime;

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

      this.logger.debug(`${request.method} failed permanently`, { 
        workerId, 
        method: request.method, 
        error: errorMessage,
        attempt 
      });
      
      return {
        method: request.method,
        success: false,
        latency,
        timestamp: startTime,
        error: errorMessage,
        requestDetails: {
          id: request.id,
          params: request.params
        },
        workerId,
        attempt
      };
    }
  }

  private async healthCheck(): Promise<HealthCheckResult> {
    const startTime = Date.now();
    
    try {
      const response = await axios.post(
        this.config.endpoint,
        {
          jsonrpc: '2.0',
          id: 'health-check',
          method: 'getSlot',
          params: []
        },
        {
          timeout: 10000,
          headers: { 'Content-Type': 'application/json' }
        }
      );

      const latency = Date.now() - startTime;
      
      if (response.data.error) {
        return {
          isHealthy: false,
          latency,
          error: `RPC Error: ${response.data.error.message}`,
          timestamp: startTime
        };
      }

      return {
        isHealthy: true,
        latency,
        timestamp: startTime
      };
    } catch (error) {
      const latency = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      return {
        isHealthy: false,
        latency,
        error: errorMessage,
        timestamp: startTime
      };
    }
  }

  private calculateResults(): LoadTestResults {
    const successfulResults = this.results.filter(r => r.success);
    const failedResults = this.results.filter(r => !r.success);
    
    const latencies = successfulResults.map(r => r.latency).sort((a, b) => a - b);
    
    const totalLatency = latencies.reduce((sum, latency) => sum + latency, 0);
    const avgLatency = latencies.length > 0 ? totalLatency / latencies.length : 0;
    
    const p50Index = Math.floor(latencies.length * 0.5);
    const p95Index = Math.floor(latencies.length * 0.95);
    const p99Index = Math.floor(latencies.length * 0.99);

    // Group errors by method and error message
    const errorMap = new Map<string, number>();
    failedResults.forEach(result => {
      const key = `${result.method}: ${result.error}`;
      errorMap.set(key, (errorMap.get(key) || 0) + 1);
    });

    const errors = Array.from(errorMap.entries()).map(([error, count]) => {
      const [method, errorMessage] = error.split(': ', 2);
      return { method, error: errorMessage, count };
    });

    // Group results by method
    const methodResults = new Map<string, TestResult[]>();
    this.results.forEach(result => {
      if (!methodResults.has(result.method)) {
        methodResults.set(result.method, []);
      }
      methodResults.get(result.method)!.push(result);
    });

    const actualDuration = (this.endTime - this.startTime) / 1000;
    const maxRps = this.requestCount / actualDuration;
    const actualRps = this.results.length / actualDuration;

    return {
      totalRequests: this.results.length,
      successfulRequests: successfulResults.length,
      failedRequests: failedResults.length,
      totalLatency,
      minLatency: latencies.length > 0 ? latencies[0] : 0,
      maxLatency: latencies.length > 0 ? latencies[latencies.length - 1] : 0,
      avgLatency,
      p50Latency: latencies.length > 0 ? latencies[p50Index] : 0,
      p95Latency: latencies.length > 0 ? latencies[p95Index] : 0,
      p99Latency: latencies.length > 0 ? latencies[p99Index] : 0,
      maxRps,
      errors,
      methodResults,
      workerStats: this.workerStats,
      testDuration: actualDuration,
      actualRps
    };
  }

  getCurrentStats(): { requests: number; errors: number; elapsed: number } {
    const elapsed = this.isRunning ? (Date.now() - this.startTime) / 1000 : 0;
    return {
      requests: this.requestCount,
      errors: this.errorCount,
      elapsed
    };
  }

  async stop(): Promise<void> {
    this.logger.info('🛑 Stopping load test...');
    this.isShuttingDown = true;
    this.isRunning = false;
    
    // Wait for workers to finish
    const workerPromises = Array.from(this.workers.values());
    await Promise.allSettled(workerPromises);
    
    this.endTime = Date.now();
    await this.cleanup();
  }
}
