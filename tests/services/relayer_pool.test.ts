import { describe, it, expect, beforeAll } from "vitest";
import { Address } from "@multiversx/sdk-core";
import { Mnemonic, UserSigner } from "@multiversx/sdk-wallet";
import { RelayerPoolManager } from "../../src/services/relayer_pool.js";

describe("RelayerPoolManager (Multi-Shard Relayer Pool)", () => {
  let testMnemonic: string;
  let sampleShard0Address: string;
  let sampleShard1Address: string;
  let sampleShard2Address: string;

  beforeAll(() => {
    testMnemonic =
      "invest glove require measure roast patch destroy bitter apple bus proof evoke deputy total curve example simple review type arrest lyrics seven flush grow";
    
    // Compute sample addresses for Shards 0, 1, and 2
    const manager = RelayerPoolManager.fromMnemonic(testMnemonic);
    sampleShard0Address = manager.getRelayerAddressForShard(0);
    sampleShard1Address = manager.getRelayerAddressForShard(1);
    sampleShard2Address = manager.getRelayerAddressForShard(2);
  });

  describe("Shard Computation", () => {
    it("should accurately compute shard ID for MultiversX addresses", () => {
      const manager = RelayerPoolManager.fromMnemonic(testMnemonic);

      expect(manager.getShardForAddress(sampleShard0Address)).toBe(0);
      expect(manager.getShardForAddress(sampleShard1Address)).toBe(1);
      expect(manager.getShardForAddress(sampleShard2Address)).toBe(2);

      // Also accepts Address instance
      const addr0 = Address.newFromBech32(sampleShard0Address);
      expect(manager.getShardForAddress(addr0)).toBe(0);
    });

    it("should compute shard for well-known MultiversX addresses", () => {
      const manager = RelayerPoolManager.fromMnemonic(testMnemonic);
      const alice = "erd1qyu5wthldzr8wx5c9ucg8kjagg0jfs53s8nr3zpz3hypefsdd8ssycr6th";
      expect(manager.getShardForAddress(alice)).toBe(1);
    });
  });

  describe("Pool Initialization from Mnemonic", () => {
    it("should discover and assign relayer wallets for Shards 0, 1, and 2", () => {
      const manager = RelayerPoolManager.fromMnemonic(testMnemonic);

      expect(manager.hasShard(0)).toBe(true);
      expect(manager.hasShard(1)).toBe(true);
      expect(manager.hasShard(2)).toBe(true);

      const relayer0 = manager.getRelayerForShard(0);
      const relayer1 = manager.getRelayerForShard(1);
      const relayer2 = manager.getRelayerForShard(2);

      expect(relayer0).toBeInstanceOf(UserSigner);
      expect(relayer1).toBeInstanceOf(UserSigner);
      expect(relayer2).toBeInstanceOf(UserSigner);

      expect(manager.getRelayerAddressForShard(0)).toBe(sampleShard0Address);
      expect(manager.getRelayerAddressForShard(1)).toBe(sampleShard1Address);
      expect(manager.getRelayerAddressForShard(2)).toBe(sampleShard2Address);
    });

    it("should return map of all relayer addresses", () => {
      const manager = RelayerPoolManager.fromMnemonic(testMnemonic);
      const allAddresses = manager.getAllRelayerAddresses();

      expect(allAddresses[0]).toBe(sampleShard0Address);
      expect(allAddresses[1]).toBe(sampleShard1Address);
      expect(allAddresses[2]).toBe(sampleShard2Address);
    });
  });

  describe("User Routing to Shard Relayers", () => {
    it("should return the matching relayer signer and address for a user in Shard 0", () => {
      const manager = RelayerPoolManager.fromMnemonic(testMnemonic);
      const signer = manager.getRelayerForAddress(sampleShard0Address);
      const addr = manager.getRelayerAddressForUser(sampleShard0Address);

      expect(addr).toBe(sampleShard0Address);
      expect(signer.getAddress().bech32()).toBe(sampleShard0Address);
    });

    it("should return the matching relayer signer and address for a user in Shard 1", () => {
      const manager = RelayerPoolManager.fromMnemonic(testMnemonic);
      const alice = "erd1qyu5wthldzr8wx5c9ucg8kjagg0jfs53s8nr3zpz3hypefsdd8ssycr6th"; // shard 1
      const signer = manager.getRelayerForAddress(alice);
      const addr = manager.getRelayerAddressForUser(alice);

      expect(addr).toBe(sampleShard1Address);
      expect(signer.getAddress().bech32()).toBe(sampleShard1Address);
    });

    it("should return the matching relayer signer and address for a user in Shard 2", () => {
      const manager = RelayerPoolManager.fromMnemonic(testMnemonic);
      const signer = manager.getRelayerForAddress(sampleShard2Address);
      const addr = manager.getRelayerAddressForUser(sampleShard2Address);

      expect(addr).toBe(sampleShard2Address);
      expect(signer.getAddress().bech32()).toBe(sampleShard2Address);
    });
  });

  describe("Pool Initialization from PEM Content", () => {
    it("should load relayers from multi-key PEM text", () => {
      const mnemonic = Mnemonic.fromString(testMnemonic);
      let pemCombined = "";

      // Derive first 15 keys to cover shards 0, 1, and 2
      for (let i = 0; i < 15; i++) {
        const secret = mnemonic.deriveKey(i);
        const pub = secret.generatePublicKey();
        const addr = Address.newFromBech32(pub.toAddress().bech32());
        const hex = Buffer.concat([secret.valueOf(), pub.valueOf()]).toString("hex");
        const b64 = Buffer.from(hex).toString("base64");
        pemCombined += `-----BEGIN PRIVATE KEY for ${addr.toBech32()}-----\n${b64}\n-----END PRIVATE KEY for ${addr.toBech32()}-----\n`;
      }

      const manager = RelayerPoolManager.fromPem(pemCombined);
      expect(manager.hasShard(0)).toBe(true);
      expect(manager.hasShard(1)).toBe(true);
      expect(manager.hasShard(2)).toBe(true);
      expect(manager.getRelayerAddressForShard(0)).toBeDefined();
    });
  });

  describe("Pool Initialization from Explicit Private Keys", () => {
    it("should load relayers from explicit key mapping", () => {
      const mnemonic = Mnemonic.fromString(testMnemonic);
      const key0 = mnemonic.deriveKey(0); // shard 1
      const signer0 = new UserSigner(key0);

      const manager = RelayerPoolManager.fromPrivateKeys({
        1: signer0,
      });

      expect(manager.hasShard(1)).toBe(true);
      expect(manager.hasShard(0)).toBe(false);
      expect(manager.getRelayerForShard(1)).toBe(signer0);
      expect(() => manager.getRelayerForShard(0)).toThrow("No relayer configured for shard 0");
    });
  });

  describe("Multi-Relayer Rotation per Shard", () => {
    it("should allow registering multiple relayers per shard and rotate round-robin", () => {
      const mnemonic = Mnemonic.fromString(testMnemonic);
      const pool = new RelayerPoolManager();

      // Register two distinct relayers in shard 1
      const signerA = new UserSigner(mnemonic.deriveKey(0));
      const signerB = new UserSigner(mnemonic.deriveKey(15)); // another derivation
      const addrA = signerA.getAddress().bech32();
      const addrB = signerB.getAddress().bech32();

      pool.registerRelayer(1, signerA);
      pool.registerRelayer(1, signerB);

      const relayersInShard1 = pool.getAllRelayersForShard(1);
      expect(relayersInShard1.length).toBe(2);

      // Round robin calls alternate between signerA and signerB
      const first = pool.getNextRelayerForShard(1);
      const second = pool.getNextRelayerForShard(1);
      const third = pool.getNextRelayerForShard(1);

      expect([addrA, addrB]).toContain(first.getAddress().bech32());
      expect([addrA, addrB]).toContain(second.getAddress().bech32());
      expect(first.getAddress().bech32()).not.toBe(second.getAddress().bech32());
      expect(third.getAddress().bech32()).toBe(first.getAddress().bech32());
    });

    it("should check if an address belongs to the relayer pool via isConfiguredRelayer", () => {
      const manager = RelayerPoolManager.fromMnemonic(testMnemonic);
      expect(manager.isConfiguredRelayer(sampleShard0Address)).toBe(true);
      expect(manager.isConfiguredRelayer(sampleShard1Address)).toBe(true);
      expect(manager.isConfiguredRelayer("erd1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq6gq4hu")).toBe(false);
    });

    it("should support relayersPerShard parameter in fromMnemonic", () => {
      const pool = RelayerPoolManager.fromMnemonic(testMnemonic, {
        relayersPerShard: 2,
        shardsToCover: [0, 1, 2],
        maxScanIndex: 60,
      });

      expect(pool.getAllRelayersForShard(0).length).toBeGreaterThanOrEqual(2);
      expect(pool.getAllRelayersForShard(1).length).toBeGreaterThanOrEqual(2);
      expect(pool.getAllRelayersForShard(2).length).toBeGreaterThanOrEqual(2);
    });
  });
});
