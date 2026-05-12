export interface RpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params: any[];
}

export interface RpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export interface TestResult {
  method: string;
  success: boolean;
  latency: number;
  timestamp: number;
  error?: string;
  responseSize?: number;
  requestDetails?: {
    id: string | number;
    params: any[];
  };
  workerId?: number;
  attempt?: number;
}

export interface LoadTestConfig {
  endpoint: string;
  /** Optional WebSocket endpoint (e.g. wss://...) for real slot/account/signature data; when omitted, mock data is used */
  websocketEndpoint?: string;
  duration: number; // seconds
  rps: number; // requests per second
  concurrent: number;
  methods: string[];
  timeout: number; // milliseconds
  healthCheckInterval?: number;
  healthMonitoring?: boolean;
  /** When false, skip both the pre-run health probe and periodic health monitoring. Use for endpoints that only support sendTransaction. */
  healthCheck?: boolean;
  gracefulShutdown?: boolean;
  progress?: boolean;
  maxRetries?: number;
  retryDelay?: number;
  /** Fixed number of accounts for getMultipleAccounts; when omitted, a random count in [1,5] is used */
  multipleAccountsCount?: number;
}

export interface LoadTestResults {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  totalLatency: number;
  minLatency: number;
  maxLatency: number;
  avgLatency: number;
  p50Latency: number;
  p95Latency: number;
  p99Latency: number;
  maxRps: number;
  errors: Array<{ method: string; error: string; count: number }>;
  methodResults: Map<string, TestResult[]>;
  workerStats: WorkerStats[];
  testDuration: number;
  actualRps: number;
}

export interface WorkerStats {
  workerId: number;
  requestsProcessed: number;
  errors: number;
  avgLatency: number;
  startTime: number;
  endTime: number;
}

export interface HealthCheckResult {
  isHealthy: boolean;
  latency: number;
  error?: string;
  timestamp: number;
}

export enum RpcMethod {
  GET_SLOT = 'getSlot',
  GET_BALANCE = 'getBalance',
  GET_ACCOUNT_INFO = 'getAccountInfo',
  GET_TRANSACTION = 'getTransaction',
  GET_SIGNATURES_FOR_ADDRESS = 'getSignaturesForAddress',
  GET_MULTIPLE_ACCOUNTS = 'getMultipleAccounts',
  GET_PROGRAM_ACCOUNTS = 'getProgramAccounts',
  GET_BLOCK = 'getBlock',
  GET_LATEST_BLOCKHASH = 'getLatestBlockhash',
  GET_TOKEN_ACCOUNTS_BY_OWNER = 'getTokenAccountsByOwner',
  GET_TOKEN_ACCOUNT_BALANCE = 'getTokenAccountBalance',
  GET_TOKEN_LARGEST_ACCOUNTS = 'getTokenLargestAccounts',
  GET_TOKEN_ACCOUNTS_BY_DELEGATE = 'getTokenAccountsByDelegate',
  SEND_TRANSACTION = 'sendTransaction',
}

export enum Commitment {
  PROCESSED = 'processed',
  CONFIRMED = 'confirmed',
  FINALIZED = 'finalized'
}

export enum Encoding {
  BASE58 = 'base58',
  BASE64 = 'base64',
  JSON_PARSED = 'jsonParsed'
}

export interface LoadTestOptions {
  dryRun?: boolean;
  progress?: boolean;
  verbose?: boolean;
  outputFormat?: 'text' | 'json' | 'csv';
  outputFile?: string;
}
