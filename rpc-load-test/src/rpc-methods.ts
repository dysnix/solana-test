import base58 from 'bs58';
import { RpcRequest, RpcMethod, Commitment, Encoding } from './types';
import { Keypair, Transaction, Connection, TransactionInstruction, PublicKey } from '@solana/web3.js';
import { Logger } from './logger';

/** When WebSocket is used, we have real slot/pubkeys/signatures; otherwise we use mock data */
const SLOT_RANGE = 200;
const CACHE_MIN_PUBKEYS = 10;
const CACHE_MIN_SIGNATURES = 10;

export class RpcMethodGenerator {
  private readonly BASE58_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  private config: any;
  private logger: Logger;
  private connection: Connection | null = null;
  private wsConnection: Connection | null = null;
  private slotSubscriptionId: number | null = null;
  /** Set when WebSocket slot subscription receives updates */
  private currentSlot: number | null = null;
  /** Set when no WebSocket; from getFirstAvailableBlock */
  private minBlockNumber: number | null = null;
  /** Real account pubkeys from a recent block (when WebSocket enabled) */
  private cachedPubkeys: string[] = [];
  /** Real tx signatures from recent blocks (when WebSocket enabled) */
  private cachedSignatures: string[] = [];
  private initDone = false;

  constructor(config: any) {
    this.config = config;
    this.logger = Logger.getInstance();
    if (config.websocketEndpoint) {
      this.initializeWebSocket().catch(error => {
        this.logger.error('WebSocket initialization failed, falling back to mock data', { error: error instanceof Error ? error.message : String(error) });
        this.fallbackToMock();
      });
    } else {
      this.initializeMinBlockNumber().catch(error => {
        this.logger.error('Failed to initialize minimum block number', { error: error instanceof Error ? error.message : String(error) });
        this.minBlockNumber = 100000000;
        this.initDone = true;
      });
    }
  }

  private fallbackToMock(): void {
    this.currentSlot = null;
    this.cachedPubkeys = [];
    this.cachedSignatures = [];
    void this.teardownWebSocket();
    this.initializeMinBlockNumber().catch(() => {
      this.minBlockNumber = 100000000;
    });
    this.initDone = true;
  }

  private async initializeWebSocket(): Promise<void> {
    this.wsConnection = new Connection(this.config.endpoint, {
      commitment: Commitment.CONFIRMED,
      disableRetryOnRateLimit: true,
      wsEndpoint: this.config.websocketEndpoint,
    });
    this.slotSubscriptionId = this.wsConnection.onSlotChange((slotInfo) => {
      this.currentSlot = slotInfo.slot;
    });
    // Wait for first slot
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 15000;
      const t = setInterval(() => {
        if (this.currentSlot !== null) {
          clearInterval(t);
          this.logger.debug('WebSocket slot subscription active', { slot: this.currentSlot });
          resolve();
          return;
        }
        if (Date.now() > deadline) {
          clearInterval(t);
          reject(new Error('WebSocket slot subscription timeout'));
        }
      }, 100);
    });
    await this.fillCacheFromRpc();
    this.initDone = true;
  }

  private async fillCacheFromRpc(): Promise<void> {
    const connection = await this.getConnection();
    const slot = this.currentSlot != null ? Math.max(0, this.currentSlot - 1) : await connection.getSlot();
    try {
      const [sigsRes, blockRes] = await Promise.all([
        connection.getBlockSignatures(slot, Commitment.CONFIRMED),
        connection.getBlock(slot, {
          commitment: Commitment.CONFIRMED,
          transactionDetails: 'accounts',
          maxSupportedTransactionVersion: 0,
        }),
      ]);
      if (sigsRes?.signatures?.length) {
        this.cachedSignatures = [...sigsRes.signatures];
        this.logger.debug('Cached real tx signatures', { count: this.cachedSignatures.length });
      }
      if (blockRes?.transactions?.length) {
        const pubkeys = new Set<string>();
        for (const tx of blockRes.transactions) {
          const keys = (tx as { transaction?: { accountKeys?: Array<{ pubkey: PublicKey }> } }).transaction?.accountKeys;
          if (keys) for (const k of keys) pubkeys.add(k.pubkey.toBase58());
        }
        this.cachedPubkeys = [...pubkeys];
        this.logger.debug('Cached real account pubkeys', { count: this.cachedPubkeys.length });
      }
    } catch (error) {
      this.logger.warn('Failed to fill real-data cache, will use mock for missing data', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async initializeMinBlockNumber(): Promise<void> {
    try {
      const connection = await this.getConnection();
      this.minBlockNumber = await connection.getFirstAvailableBlock();
      this.logger.debug('Initialized minimum block number', { minBlockNumber: this.minBlockNumber });
    } catch (error) {
      this.logger.warn('Failed to get first available block, will use fallback', { error: error instanceof Error ? error.message : String(error) });
      this.minBlockNumber = 100000000;
    }
    if (!this.initDone) this.initDone = true;
  }

  async waitForInitialization(): Promise<void> {
    const deadline = Date.now() + 20000;
    while (!this.initDone) {
      if (Date.now() > deadline) break;
      await new Promise(r => setTimeout(r, 100));
    }
    if (!this.config.websocketEndpoint && this.minBlockNumber === null) {
      while (this.minBlockNumber === null && Date.now() <= deadline) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
    if (this.config.websocketEndpoint && this.currentSlot !== null) {
      this.logger.debug('Using real data from WebSocket', { slot: this.currentSlot, pubkeys: this.cachedPubkeys.length, signatures: this.cachedSignatures.length });
    } else {
      this.logger.debug('Using mock/fallback data', { minBlockNumber: this.minBlockNumber });
    }
  }

  private async getConnection(): Promise<Connection> {
    if (!this.connection) {
      this.connection = new Connection(this.config.endpoint, {
          commitment: Commitment.CONFIRMED,
          disableRetryOnRateLimit: true
        }
      );
    }
    return this.connection;
  }

  private async teardownWebSocket(): Promise<void> {
    if (this.wsConnection && this.slotSubscriptionId !== null) {
      try {
        await this.wsConnection.removeSlotChangeListener(this.slotSubscriptionId);
      } catch {
        // Ignore teardown errors to avoid breaking graceful shutdown
      }
    }

    // web3.js keeps internal WS sockets/reconnect timers alive unless explicitly closed.
    const wsRpc = (this.wsConnection as any)?._rpcWebSocket;
    const rawSocket = wsRpc?._socket ?? wsRpc?._ws;
    const readyState = typeof rawSocket?.readyState === 'number' ? rawSocket.readyState : undefined;
    const socketIsConnecting = readyState === 0;
    const socketIsOpen = readyState === 1;

    try {
      // Prevent noisy "WebSocket was closed before the connection was established"
      // during teardown race conditions.
      rawSocket?.once?.('error', () => undefined);
    } catch {
      // Ignore listener attachment errors
    }

    if (socketIsOpen && wsRpc?.close) {
      try {
        await wsRpc.close();
      } catch {
        // Ignore teardown errors to avoid breaking graceful shutdown
      }
    } else if (socketIsConnecting && rawSocket?.terminate) {
      try {
        rawSocket.terminate();
      } catch {
        // Ignore teardown errors to avoid breaking graceful shutdown
      }
    }

    this.wsConnection = null;
    this.slotSubscriptionId = null;
  }

  private async teardownHttpConnection(): Promise<void> {
    const httpRpc = (this.connection as any)?._rpcClient;
    if (httpRpc?.close) {
      try {
        await httpRpc.close();
      } catch {
        // Ignore teardown errors to avoid breaking graceful shutdown
      }
    }

    this.connection = null;
  }

  async cleanup(): Promise<void> {
    await this.teardownWebSocket();
    await this.teardownHttpConnection();
  }

  generateRandomBase58(length: number): string {
    let result = '';
    for (let i = 0; i < length; i++) {
      result += this.BASE58_CHARS.charAt(Math.floor(Math.random() * this.BASE58_CHARS.length));
    }
    return result;
  }

  // async getLatestBlockhashFromRpc(): Promise<string> {
    // try {
    //   const connection = await this.getConnection();
    //   const blockhash = await connection.getLatestBlockhash();
    //   this.logger.debug('Latest blockhash', { blockhash: blockhash.blockhash });
    //   return blockhash.blockhash;
    // } catch (error) {
    //   this.logger.warn('Failed to get latest blockhash from RPC, using fallback', { error: error instanceof Error ? error.message : String(error) });
    //   // Fallback to a mock blockhash
    //   return this.generateRandomBase58(44);
    // }
  // }

  generateRandomSignature(): string {
    if (this.cachedSignatures.length >= CACHE_MIN_SIGNATURES) {
      return this.cachedSignatures[Math.floor(Math.random() * this.cachedSignatures.length)];
    }
    const transaction = new Transaction();
    const keypair = Keypair.generate();
    transaction.instructions.push(new TransactionInstruction({
      keys: [],
      programId: new PublicKey('11111111111111111111111111111111'),
      data: Buffer.from([])
    }));
    transaction.recentBlockhash = this.generateRandomPublicKey();
    transaction.sign(keypair);

    if (!transaction.signature) {
      throw new Error('Failed to generate transaction signature');
    }

    return base58.encode(transaction.signature);
  }

  generateRandomPublicKey(): string {
    if (this.cachedPubkeys.length >= CACHE_MIN_PUBKEYS) {
      return this.cachedPubkeys[Math.floor(Math.random() * this.cachedPubkeys.length)];
    }
    try {
      const keypair = Keypair.generate();
      return keypair.publicKey.toBase58();
    } catch (error) {
      this.logger.warn('Failed to generate real public key, using fallback', { error: error instanceof Error ? error.message : String(error) });
      return this.generateRandomBase58(44);
    }
  }

  generateRandomBlockNumber(): number {
    if (this.currentSlot !== null) {
      const min = Math.max(0, this.currentSlot - SLOT_RANGE);
      return Math.floor(Math.random() * (this.currentSlot - min + 1)) + min;
    }
    if (this.minBlockNumber !== null) {
      const maxBlock = this.minBlockNumber + 3000;
      return Math.floor(Math.random() * (maxBlock - this.minBlockNumber)) + this.minBlockNumber;
    }
    return Math.floor(Math.random() * 100000000) + 100000000;
  }

  getSlot(): RpcRequest {
    return {
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1000000),
      method: RpcMethod.GET_SLOT,
      params: [{
        commitment: Commitment.CONFIRMED
      }]
    };
  }

  getTransaction(): RpcRequest {
    return {
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1000000),
      method: RpcMethod.GET_TRANSACTION,
      params: [
        this.generateRandomSignature(),
        {
          encoding: Encoding.BASE64,
          commitment: Commitment.CONFIRMED,
          maxSupportedTransactionVersion: 0
        }
      ]
    };
  }

  getMultipleAccounts(): RpcRequest {
    const numAccounts = Math.floor(Math.random() * 5) + 1;
    const accounts = Array.from({ length: numAccounts }, () => this.generateRandomPublicKey());
    
    return {
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1000000),
      method: RpcMethod.GET_MULTIPLE_ACCOUNTS,
      params: [
        accounts,
        {
          encoding: Encoding.BASE64,
          commitment: Commitment.CONFIRMED
        }
      ]
    };
  }

  getProgramAccounts(): RpcRequest {
    return {
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1000000),
      method: RpcMethod.GET_PROGRAM_ACCOUNTS,
      params: [
        this.generateRandomPublicKey(),
        {
          encoding: Encoding.BASE64,
          commitment: Commitment.CONFIRMED,
        }
      ]
    };
  }

  getBlock(): RpcRequest {
    return {
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1000000),
      method: RpcMethod.GET_BLOCK,
      params: [
        this.generateRandomBlockNumber(),
        {
          encoding: Encoding.BASE64,
          transactionDetails: 'none',
          commitment: Commitment.CONFIRMED,
          maxSupportedTransactionVersion: 0,
        }
      ]
    };
  }

  getLatestBlockhash(): RpcRequest {
    return {
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1000000),
      method: RpcMethod.GET_LATEST_BLOCKHASH,
      params: [{
        commitment: Commitment.PROCESSED
      }]
    };
  }

  async generateRandomMethod(): Promise<RpcRequest> {
    const methods = [
      () => this.getSlot(),
      () => this.getTransaction(),
      () => this.getMultipleAccounts(),
      () => this.getProgramAccounts(),
      () => this.getBlock(),
      () => this.getLatestBlockhash()
    ];
    
    const randomMethod = methods[Math.floor(Math.random() * methods.length)];
    return randomMethod();
  }
}
