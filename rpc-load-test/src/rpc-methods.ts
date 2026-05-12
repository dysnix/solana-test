import base58 from 'bs58';
import { RpcRequest, RpcMethod, Commitment, Encoding } from './types';
import { Keypair, Transaction, Connection, TransactionInstruction, PublicKey, SystemProgram } from '@solana/web3.js';
import { Logger } from './logger';

/** When WebSocket is used, we have real slot/pubkeys/signatures; otherwise we use mock data */
const SLOT_RANGE = 200;
const CACHE_MIN_PUBKEYS = 10;
const CACHE_MIN_SIGNATURES = 10;
/** Rolling buffer caps so we keep cache memory bounded while the test runs. */
const MAX_PUBKEY_BUFFER = 5000;
const MAX_SIGNATURE_BUFFER = 5000;
/** Refresh cadence: ~400ms per slot on mainnet, so every 10 slots ≈ 4s. */
const REFRESH_EVERY_N_SLOTS = 10;
/** Blockhashes are valid for ~150 slots (~60s); refresh well within that window. */
const BLOCKHASH_REFRESH_MS = 20_000;
/** Destination for sendTransaction load — accepts tips, no real value transferred (signer has 0 SOL). */
const SEND_TX_TIP_ADDRESS = new PublicKey('TipbH4gTBnBxwsXXb4YJmbsqhjoGumuBrNSwZvLBeqm');
const SEND_TX_LAMPORTS = 1000;

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
  /** Real account pubkeys from recent blocks (when WebSocket enabled), refreshed periodically */
  private cachedPubkeys: string[] = [];
  private cachedPubkeysSet: Set<string> = new Set();
  /** Real tx signatures from recent blocks (when WebSocket enabled), refreshed periodically */
  private cachedSignatures: string[] = [];
  private cachedSignaturesSet: Set<string> = new Set();
  /** Slot at which we last triggered a cache refresh; used to throttle refresh cadence. */
  private lastRefreshSlot: number | null = null;
  /** Prevents concurrent refresh fetches when blocks lag behind slot updates. */
  private refreshInFlight = false;
  /** Stops scheduling new refreshes once cleanup() has been called. */
  private shuttingDown = false;
  private initDone = false;
  /** Most recently fetched blockhash; used to sign sendTransaction payloads. */
  private cachedBlockhash: string | null = null;
  private blockhashRefreshTimer: NodeJS.Timeout | null = null;

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
    this.cachedPubkeysSet.clear();
    this.cachedSignatures = [];
    this.cachedSignaturesSet.clear();
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
      this.maybeScheduleRefresh(slotInfo.slot);
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
    await this.refreshCacheFromRpc();
    if (this.config.healthCheck !== false) {
      await this.refreshBlockhash();
      this.startBlockhashRefresh();
    }
    this.initDone = true;
  }

  private maybeScheduleRefresh(slot: number): void {
    if (this.shuttingDown || this.refreshInFlight) return;
    if (this.lastRefreshSlot !== null && slot - this.lastRefreshSlot < REFRESH_EVERY_N_SLOTS) return;
    this.lastRefreshSlot = slot;
    this.refreshInFlight = true;
    this.refreshCacheFromRpc()
      .catch(error => {
        this.logger.debug('Background cache refresh failed', { error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        this.refreshInFlight = false;
      });
  }

  private addPubkeys(keys: Iterable<string>): number {
    let added = 0;
    for (const k of keys) {
      if (this.cachedPubkeysSet.has(k)) continue;
      this.cachedPubkeysSet.add(k);
      this.cachedPubkeys.push(k);
      added++;
    }
    while (this.cachedPubkeys.length > MAX_PUBKEY_BUFFER) {
      const evicted = this.cachedPubkeys.shift();
      if (evicted !== undefined) this.cachedPubkeysSet.delete(evicted);
    }
    return added;
  }

  private addSignatures(sigs: Iterable<string>): number {
    let added = 0;
    for (const s of sigs) {
      if (this.cachedSignaturesSet.has(s)) continue;
      this.cachedSignaturesSet.add(s);
      this.cachedSignatures.push(s);
      added++;
    }
    while (this.cachedSignatures.length > MAX_SIGNATURE_BUFFER) {
      const evicted = this.cachedSignatures.shift();
      if (evicted !== undefined) this.cachedSignaturesSet.delete(evicted);
    }
    return added;
  }

  private async refreshCacheFromRpc(): Promise<void> {
    const connection = await this.getConnection();
    const startSlot = this.currentSlot != null ? Math.max(0, this.currentSlot - 1) : await connection.getSlot();
    // Solana skips slots and recently-produced slots may not yet be queryable;
    // walk back through nearby slots until one returns a block.
    const MAX_ATTEMPTS = 10;
    let lastError: unknown = null;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const slot = Math.max(0, startSlot - i);
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
          const added = this.addSignatures(sigsRes.signatures);
          this.logger.debug('Refreshed tx signature cache', { added, total: this.cachedSignatures.length, slot });
        }
        if (blockRes?.transactions?.length) {
          const pubkeys = new Set<string>();
          for (const tx of blockRes.transactions) {
            const keys = (tx as { transaction?: { accountKeys?: Array<{ pubkey: PublicKey }> } }).transaction?.accountKeys;
            if (keys) for (const k of keys) pubkeys.add(k.pubkey.toBase58());
          }
          const added = this.addPubkeys(pubkeys);
          this.logger.debug('Refreshed account pubkey cache', { added, total: this.cachedPubkeys.length, slot });
        }
        return;
      } catch (error) {
        lastError = error;
        this.logger.debug('refreshCacheFromRpc attempt failed, retrying with older slot', {
          slot,
          attempt: i + 1,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.logger.warn('Failed to refresh real-data cache after retries, will use mock for missing data', {
      attempts: MAX_ATTEMPTS,
      startSlot,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
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
    if (this.config.healthCheck !== false) {
      await this.refreshBlockhash();
      this.startBlockhashRefresh();
    }
    if (!this.initDone) this.initDone = true;
  }

  private async refreshBlockhash(): Promise<void> {
    try {
      const connection = await this.getConnection();
      const { blockhash } = await connection.getLatestBlockhash(Commitment.PROCESSED);
      this.cachedBlockhash = blockhash;
      this.logger.debug('Refreshed blockhash', { blockhash });
    } catch (error) {
      this.logger.debug('Failed to refresh blockhash', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private startBlockhashRefresh(): void {
    if (this.blockhashRefreshTimer) return;
    this.blockhashRefreshTimer = setInterval(() => {
      if (this.shuttingDown) return;
      this.refreshBlockhash().catch(() => undefined);
    }, BLOCKHASH_REFRESH_MS);
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
    this.shuttingDown = true;
    if (this.blockhashRefreshTimer) {
      clearInterval(this.blockhashRefreshTimer);
      this.blockhashRefreshTimer = null;
    }
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

  getAccountInfo(): RpcRequest {
    return {
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1000000),
      method: RpcMethod.GET_ACCOUNT_INFO,
      params: [
        this.generateRandomPublicKey(),
        {
          encoding: Encoding.BASE64,
          commitment: Commitment.CONFIRMED
        }
      ]
    };
  }

  getBalance(): RpcRequest {
    return {
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1000000),
      method: RpcMethod.GET_BALANCE,
      params: [
        this.generateRandomPublicKey(),
        {
          commitment: Commitment.CONFIRMED
        }
      ]
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

  getSignaturesForAddress(): RpcRequest {
    return {
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1000000),
      method: RpcMethod.GET_SIGNATURES_FOR_ADDRESS,
      params: [
        this.generateRandomPublicKey(),
        {
          commitment: Commitment.CONFIRMED,
          limit: 10,
        }
      ]
    };
  }

  getMultipleAccounts(): RpcRequest {
    const configured = this.config.multipleAccountsCount;
    const numAccounts = typeof configured === 'number' && configured > 0
      ? configured
      : Math.floor(Math.random() * 5) + 1;
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

  getTokenAccountsByOwner(): RpcRequest {
    return {
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1000000),
      method: RpcMethod.GET_TOKEN_ACCOUNTS_BY_OWNER,
      params: [
        this.generateRandomPublicKey(),
        {
          programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
        },
        {
          encoding: Encoding.BASE64,
          commitment: Commitment.CONFIRMED,
        }
      ]
    };
  }

  getTokenAccountsByDelegate(): RpcRequest {
    return {
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1000000),
      method: RpcMethod.GET_TOKEN_ACCOUNTS_BY_DELEGATE,
      params: [
        this.generateRandomPublicKey(),
        {
          encoding: Encoding.BASE64,
          commitment: Commitment.CONFIRMED,
        }
      ]
    };
  }

  getTokenAccountBalance(): RpcRequest {
    return {
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1000000),
      method: RpcMethod.GET_TOKEN_ACCOUNT_BALANCE,
      params: [
        this.generateRandomPublicKey(),
        {
          encoding: Encoding.BASE64,
          commitment: Commitment.CONFIRMED,
        }
      ]
    };
  }

  getTokenLargestAccounts(): RpcRequest {
    return {
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1000000),
      method: RpcMethod.GET_TOKEN_LARGEST_ACCOUNTS,
      params: [
        this.generateRandomPublicKey(),
        {
          encoding: Encoding.BASE64,
          commitment: Commitment.CONFIRMED,
        }
      ]
    }
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

  sendTransaction(): RpcRequest {
    // With health checks off we assume the endpoint is send-only and can't serve getLatestBlockhash,
    // so we mint a random 32-byte base58 hash per call instead of relying on the cache.
    const blockhash = this.config.healthCheck === false
      ? Keypair.generate().publicKey.toBase58()
      : this.cachedBlockhash;
    if (!blockhash) {
      throw new Error('sendTransaction unavailable: no recent blockhash cached yet');
    }
    const keypair = Keypair.generate();
    const tx = new Transaction();
    tx.feePayer = keypair.publicKey;
    tx.recentBlockhash = blockhash;
    tx.add(SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: SEND_TX_TIP_ADDRESS,
      lamports: SEND_TX_LAMPORTS,
    }));
    tx.sign(keypair);
    const encoded = tx.serialize({ requireAllSignatures: true, verifySignatures: false }).toString('base64');
    return {
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1000000),
      method: RpcMethod.SEND_TRANSACTION,
      params: [
        encoded,
        {
          encoding: Encoding.BASE64,
          skipPreflight: true,
          preflightCommitment: Commitment.PROCESSED,
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
      () => this.getBalance(),
      () => this.getAccountInfo(),
      () => this.getTransaction(),
      () => this.getSignaturesForAddress(),
      () => this.getMultipleAccounts(),
      () => this.getProgramAccounts(),
      () => this.getBlock(),
      () => this.getLatestBlockhash()
    ];
    
    const randomMethod = methods[Math.floor(Math.random() * methods.length)];
    return randomMethod();
  }
}
