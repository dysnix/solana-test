import base58 from 'bs58';
import { RpcRequest, RpcMethod, Commitment, Encoding } from './types';
import { Keypair, Transaction, Connection, TransactionInstruction, PublicKey } from '@solana/web3.js';
import { Logger } from './logger';

export class RpcMethodGenerator {
  private readonly BASE58_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  private config: any;
  private logger: Logger;
  private connection: Connection | null = null;
  private minBlockNumber: number | null = null;

  constructor(config: any) {
    this.config = config;
    this.logger = Logger.getInstance();
    // Start initialization in background
    this.initializeMinBlockNumber().catch(error => {
      this.logger.error('Failed to initialize minimum block number', { error: error instanceof Error ? error.message : String(error) });
    });
  }

  private async initializeMinBlockNumber(): Promise<void> {
    try {
      const connection = await this.getConnection();
      this.minBlockNumber = await connection.getMinimumLedgerSlot();
      this.logger.info('Initialized minimum block number', { minBlockNumber: this.minBlockNumber });
    } catch (error) {
      this.logger.warn('Failed to get first available block, will use fallback', { error: error instanceof Error ? error.message : String(error) });
      this.minBlockNumber = 100000000; // Fallback to original minimum
    }
  }

  async waitForInitialization(): Promise<void> {
    if (this.minBlockNumber === null) {
      // Wait for initialization to complete
      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          if (this.minBlockNumber !== null) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 100);
      });
    }
  }

  private async getConnection(): Promise<Connection> {
    if (!this.connection) {
      this.connection = new Connection(this.config.endpoint, 'confirmed');
    }
    return this.connection;
  }

  generateRandomBase58(length: number): string {
    let result = '';
    for (let i = 0; i < length; i++) {
      result += this.BASE58_CHARS.charAt(Math.floor(Math.random() * this.BASE58_CHARS.length));
    }
    return result;
  }

  async getLatestBlockhashFromRpc(): Promise<string> {
    try {
      const connection = await this.getConnection();
      const blockhash = await connection.getLatestBlockhash();
      return blockhash.blockhash;
    } catch (error) {
      this.logger.warn('Failed to get latest blockhash from RPC, using fallback', { error: error instanceof Error ? error.message : String(error) });
      // Fallback to a mock blockhash
      return this.generateRandomBase58(44);
    }
  }

  async generateRandomSignature(): Promise<string> {
    try {
      const transaction = new Transaction();
      const keypair = Keypair.generate();
      transaction.instructions.push(new TransactionInstruction({
        keys: [],
        programId: new PublicKey('11111111111111111111111111111111'),
        data: Buffer.from([])
      }));
      transaction.recentBlockhash = await this.getLatestBlockhashFromRpc();
      transaction.sign(keypair);
      
      if (!transaction.signature) {
        throw new Error('Failed to generate transaction signature');
      }
      
      return base58.encode(transaction.signature);
    } catch (error) {
      this.logger.warn('Failed to generate real signature, using fallback', { error: error instanceof Error ? error.message : String(error) });
      // Fallback to a mock signature
      return this.generateRandomBase58(88);
    }
  }

  generateRandomPublicKey(): string {
    try {
      const keypair = Keypair.generate();
      return keypair.publicKey.toBase58();
    } catch (error) {
      this.logger.warn('Failed to generate real public key, using fallback', { error: error instanceof Error ? error.message : String(error) });
      // Fallback to a mock public key
      return this.generateRandomBase58(44);
    }
  }

  generateRandomBlockNumber(): number {
    if (this.minBlockNumber === null) {
      // If initialization hasn't completed yet, use fallback
      return Math.floor(Math.random() * 100000000) + 100000000;
    }
    const maxBlock = this.minBlockNumber + 30000; // Add some range above the minimum block
    return Math.floor(Math.random() * (maxBlock - this.minBlockNumber)) + this.minBlockNumber;
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

  async getTransaction(): Promise<RpcRequest> {
    return {
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1000000),
      method: RpcMethod.GET_TRANSACTION,
      params: [
        await this.generateRandomSignature(),
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

  async getAllMethods(): Promise<RpcRequest[]> {
    return [
      this.getSlot(),
      await this.getTransaction(),
      this.getMultipleAccounts(),
      this.getProgramAccounts(),
      this.getBlock(),
      this.getLatestBlockhash()
    ];
  }
}
