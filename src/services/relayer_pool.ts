import { Address, AddressComputer } from "@multiversx/sdk-core";
import { Mnemonic, parseUserKeys, UserSecretKey, UserSigner } from "@multiversx/sdk-wallet";

/**
 * MultiversX Metachain shard identifier.
 */
export const METACHAIN_SHARD_ID = 4294967295;

/**
 * Options for configuring relayer discovery from mnemonic.
 */
export interface MnemonicRelayerOptions {
  maxScanIndex?: number;
  shardsToCover?: number[];
}

/**
 * Multi-Shard Relayer Pool Manager.
 * Computes shard IDs for user addresses and manages relayer signers across shards (0, 1, 2, Metachain).
 */
export class RelayerPoolManager {
  private readonly addressComputer: AddressComputer;
  private readonly relayers: Map<number, UserSigner>;

  constructor(relayers?: Map<number, UserSigner> | Record<number, UserSigner>) {
    this.addressComputer = new AddressComputer();
    this.relayers = new Map<number, UserSigner>();

    if (relayers) {
      if (relayers instanceof Map) {
        for (const [shard, signer] of relayers.entries()) {
          this.relayers.set(shard, signer);
        }
      } else {
        for (const [shardStr, signer] of Object.entries(relayers)) {
          this.relayers.set(Number(shardStr), signer);
        }
      }
    }
  }

  /**
   * Computes the shard ID for any MultiversX address (string or Address instance).
   */
  getShardForAddress(address: string | Address): number {
    const addr = typeof address === "string" ? Address.newFromBech32(address) : address;
    return this.addressComputer.getShardOfAddress(addr);
  }

  /**
   * Registers a relayer signer for a specific shard.
   */
  registerRelayer(shard: number, signer: UserSigner): void {
    this.relayers.set(shard, signer);
  }

  /**
   * Registers a relayer signer by computing its shard automatically.
   */
  registerRelayerAuto(signer: UserSigner): number {
    const shard = this.getShardForAddress(signer.getAddress().bech32());
    this.relayers.set(shard, signer);
    return shard;
  }

  /**
   * Checks if a relayer is registered for the specified shard.
   */
  hasShard(shard: number): boolean {
    return this.relayers.has(shard);
  }

  /**
   * Returns the UserSigner for the given shard.
   */
  getRelayerForShard(shard: number): UserSigner {
    const relayer = this.relayers.get(shard);
    if (!relayer) {
      throw new Error(`No relayer configured for shard ${shard}`);
    }
    return relayer;
  }

  /**
   * Returns the bech32 address for the given shard relayer.
   */
  getRelayerAddressForShard(shard: number): string {
    const relayer = this.getRelayerForShard(shard);
    return relayer.getAddress().bech32();
  }

  /**
   * Computes the shard of the given user address and returns the matching relayer UserSigner.
   */
  getRelayerForAddress(userAddress: string | Address): UserSigner {
    const shard = this.getShardForAddress(userAddress);
    return this.getRelayerForShard(shard);
  }

  /**
   * Computes the shard of the given user address and returns the matching relayer bech32 address.
   */
  getRelayerAddressForUser(userAddress: string | Address): string {
    const relayer = this.getRelayerForAddress(userAddress);
    return relayer.getAddress().bech32();
  }

  /**
   * Returns a map of all registered relayers by shard.
   */
  getAllRelayers(): Map<number, UserSigner> {
    return new Map(this.relayers);
  }

  /**
   * Returns a record of shard ID to relayer bech32 address.
   */
  getAllRelayerAddresses(): Record<number, string> {
    const result: Record<number, string> = {};
    for (const [shard, signer] of this.relayers.entries()) {
      result[shard] = signer.getAddress().bech32();
    }
    return result;
  }

  /**
   * Initializes a RelayerPoolManager from a 24-word mnemonic phrase by scanning derivation indexes.
   */
  static fromMnemonic(mnemonicStr: string, options?: MnemonicRelayerOptions): RelayerPoolManager {
    const mnemonic = Mnemonic.fromString(mnemonicStr.trim());
    const maxScanIndex = options?.maxScanIndex ?? 100;
    const targetShards = new Set<number>(options?.shardsToCover ?? [0, 1, 2]);

    const pool = new RelayerPoolManager();
    const ac = new AddressComputer();

    for (let i = 0; i < maxScanIndex; i++) {
      const secret = mnemonic.deriveKey(i);
      const pub = secret.generatePublicKey();
      const addr = Address.newFromBech32(pub.toAddress().bech32());
      const shard = ac.getShardOfAddress(addr);

      if (targetShards.has(shard) && !pool.hasShard(shard)) {
        pool.registerRelayer(shard, new UserSigner(secret));
      }

      // Check if all requested shards are satisfied
      const allFilled = Array.from(targetShards).every((s) => pool.hasShard(s));
      if (allFilled) {
        break;
      }
    }

    return pool;
  }

  /**
   * Initializes a RelayerPoolManager from MultiversX PEM file content.
   */
  static fromPem(pemContent: string): RelayerPoolManager {
    const secretKeys = parseUserKeys(pemContent);
    const pool = new RelayerPoolManager();

    for (const secretKey of secretKeys) {
      const signer = new UserSigner(secretKey);
      pool.registerRelayerAuto(signer);
    }

    return pool;
  }

  /**
   * Initializes a RelayerPoolManager from a dictionary of shard IDs to private keys or UserSigners.
   */
  static fromPrivateKeys(
    keysByShard: Record<number, string | UserSigner | UserSecretKey>
  ): RelayerPoolManager {
    const pool = new RelayerPoolManager();

    for (const [shardStr, keyOrSigner] of Object.entries(keysByShard)) {
      const shard = Number(shardStr);
      if (keyOrSigner instanceof UserSigner) {
        pool.registerRelayer(shard, keyOrSigner);
      } else if (keyOrSigner instanceof UserSecretKey) {
        pool.registerRelayer(shard, new UserSigner(keyOrSigner));
      } else if (typeof keyOrSigner === "string") {
        const secret = new UserSecretKey(Buffer.from(keyOrSigner.replace(/^0x/, ""), "hex"));
        pool.registerRelayer(shard, new UserSigner(secret));
      }
    }

    return pool;
  }
}
