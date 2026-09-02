import { describe, it, expect, beforeEach } from "vitest";
import { Address, Transaction, TransactionComputer } from "@multiversx/sdk-core";
import { Mnemonic, UserSigner } from "@multiversx/sdk-wallet";
import { PaymentErrorCode, SettleRequest, X402PaymentPayload } from "../../src/domain/types.js";
import { INetworkProvider, ISimulationResult } from "../../src/domain/network.js";
import { RelayerPoolManager } from "../../src/services/relayer_pool.js";
import { VerifierService } from "../../src/services/verifier.js";
import { SettlerService } from "../../src/services/settler.js";
import { MemorySettlementStorage } from "../../src/storage/memory_storage.js";
import { SqliteSettlementStorage } from "../../src/storage/sqlite_storage.js";
import { buildEsdtTransferData } from "../../src/utils/data_parser.js";

describe("SettlerService (x402 Payment Settlement)", () => {
  let userMnemonic: Mnemonic;
  let userSigner: UserSigner;
  let userAddress: Address;

  let receiverMnemonic: Mnemonic;
  let receiverSigner: UserSigner;
  let receiverAddress: Address;

  let relayerPool: RelayerPoolManager;
  let relayerAddressForUser: string;
  let relayerSignerForUser: UserSigner;

  let memoryStorage: MemorySettlementStorage;
  let tc: TransactionComputer;

  let mockNetworkProvider: INetworkProvider;
  let broadcastedTransactions: Transaction[];

  beforeEach(() => {
    tc = new TransactionComputer();
    memoryStorage = new MemorySettlementStorage();
    broadcastedTransactions = [];

    // Setup User (Sender)
    userMnemonic = Mnemonic.generate();
    userSigner = new UserSigner(userMnemonic.deriveKey(0));
    userAddress = Address.newFromBech32(userSigner.getAddress().bech32());

    // Setup Receiver (payTo)
    receiverMnemonic = Mnemonic.generate();
    receiverSigner = new UserSigner(receiverMnemonic.deriveKey(0));
    receiverAddress = Address.newFromBech32(receiverSigner.getAddress().bech32());

    // Setup Relayer Pool
    const relayerMnemonic = Mnemonic.generate();
    relayerPool = RelayerPoolManager.fromMnemonic(relayerMnemonic.toString());
    relayerAddressForUser = relayerPool.getRelayerAddressForUser(userAddress.toBech32());
    relayerSignerForUser = relayerPool.getRelayerForAddress(userAddress.toBech32());

    mockNetworkProvider = {
      simulateTransaction: async (): Promise<ISimulationResult> => ({
        status: "success",
        returnCode: "ok",
      }),
      sendTransaction: async (tx: Transaction): Promise<string> => {
        broadcastedTransactions.push(tx);
        return "0xdeadbeef1234567890abcdef" + broadcastedTransactions.length;
      },
      getTransaction: async () => ({}),
      getAccount: async () => ({}),
    };
  });

  async function createSignedTransaction(params: {
    value?: bigint;
    receiver?: Address;
    data?: string;
    chainID?: string;
    version?: number;
    options?: number;
    nonce?: bigint;
    gasPrice?: bigint;
    gasLimit?: bigint;
    relayer?: Address;
    validAfter?: number;
    validBefore?: number;
    signer?: UserSigner;
    relayerSigner?: UserSigner;
  }) {
    const sender = params.signer
      ? Address.newFromBech32(params.signer.getAddress().bech32())
      : userAddress;
    const signerToUse = params.signer ?? userSigner;

    const tx = new Transaction({
      nonce: params.nonce ?? 0n,
      value: params.value ?? 0n,
      sender: sender,
      receiver: params.receiver ?? receiverAddress,
      gasPrice: params.gasPrice ?? 1000000000n,
      gasLimit: params.gasLimit ?? (params.relayer ? 120000n : 70000n),
      data: params.data ? Buffer.from(params.data) : Buffer.from(""),
      chainID: params.chainID ?? "D",
      version: params.version ?? (params.relayer ? 2 : 1),
      options: params.options ?? 0,
      relayer: params.relayer,
    });

    const bytesToSign = tc.computeBytesForSigning(tx);
    const signature = await signerToUse.sign(bytesToSign);
    tx.signature = signature;

    let relayerSig: Uint8Array | undefined;
    if (params.relayerSigner && params.relayer) {
      relayerSig = await params.relayerSigner.sign(bytesToSign);
      tx.relayerSignature = relayerSig;
    }

    return {
      nonce: Number(tx.nonce),
      value: tx.value.toString(),
      receiver: tx.receiver.toBech32(),
      sender: tx.sender.toBech32(),
      gasPrice: Number(tx.gasPrice),
      gasLimit: Number(tx.gasLimit),
      data: params.data,
      chainID: tx.chainID,
      version: tx.version,
      options: tx.options,
      signature: Buffer.from(tx.signature).toString("hex"),
      relayer: params.relayer ? params.relayer.toBech32() : undefined,
      relayerSignature: relayerSig ? Buffer.from(relayerSig).toString("hex") : undefined,
      validAfter: params.validAfter,
      validBefore: params.validBefore,
    };
  }

  it("1. should successfully settle a standard direct EGLD payment transaction", async () => {
    const amount = "1000000000000000000";
    const txPayload = await createSignedTransaction({
      value: BigInt(amount),
      receiver: receiverAddress,
    });

    const requirements = {
      scheme: "exact" as const,
      network: "multiversx:D",
      asset: "EGLD",
      amount: amount,
      payTo: receiverAddress.toBech32(),
      maxTimeoutSeconds: 60,
    };

    const settleReq: SettleRequest = {
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: txPayload,
      },
      paymentRequirements: requirements,
    };

    const verifier = new VerifierService({ relayerPool });
    const settler = new SettlerService({
      storage: memoryStorage,
      networkProvider: mockNetworkProvider,
      verifier,
      relayerPool,
    });

    const response = await settler.settle(settleReq);

    expect(response.success).toBe(true);
    expect(response.transaction).toBe("0xdeadbeef1234567890abcdef1");
    expect(response.network).toBe("multiversx:D");
    expect(response.payer).toBe(userAddress.toBech32());
    expect(broadcastedTransactions.length).toBe(1);

    // Verify storage record is completed
    const record = await memoryStorage.list();
    expect(record.length).toBe(1);
    expect(record[0].status).toBe("completed");
    expect(record[0].txHash).toBe("0xdeadbeef1234567890abcdef1");
    expect(record[0].payer).toBe(userAddress.toBech32());
  });

  it("2. should successfully settle an ESDT payment transaction", async () => {
    const tokenIdentifier = "USDC-c76f1f";
    const amount = "10000000";
    const data = buildEsdtTransferData(tokenIdentifier, amount);

    const txPayload = await createSignedTransaction({
      data: data,
      receiver: receiverAddress,
    });

    const requirements = {
      scheme: "exact" as const,
      network: "multiversx:D",
      asset: tokenIdentifier,
      amount: amount,
      payTo: receiverAddress.toBech32(),
      maxTimeoutSeconds: 60,
    };

    const settleReq: SettleRequest = {
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: txPayload,
      },
      paymentRequirements: requirements,
    };

    const settler = new SettlerService({
      storage: memoryStorage,
      networkProvider: mockNetworkProvider,
      relayerPool,
    });

    const response = await settler.settle(settleReq);

    expect(response.success).toBe(true);
    expect(response.transaction).toBe("0xdeadbeef1234567890abcdef1");
    expect(broadcastedTransactions.length).toBe(1);
  });

  it("3. should sign missing relayer signature in Relayed V3 transactions automatically", async () => {
    const amount = "500000000000000000";
    // User signs Relayed V3 transaction with relayer address specified, but without relayerSignature
    const txPayload = await createSignedTransaction({
      value: BigInt(amount),
      receiver: receiverAddress,
      relayer: Address.newFromBech32(relayerAddressForUser),
      version: 2,
      // No relayerSigner passed, so relayerSignature is undefined
    });

    expect(txPayload.relayerSignature).toBeUndefined();

    const requirements = {
      scheme: "exact" as const,
      network: "multiversx:D",
      asset: "EGLD",
      amount: amount,
      payTo: receiverAddress.toBech32(),
      maxTimeoutSeconds: 60,
    };

    const settleReq: SettleRequest = {
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: txPayload,
      },
      paymentRequirements: requirements,
    };

    const settler = new SettlerService({
      storage: memoryStorage,
      networkProvider: mockNetworkProvider,
      relayerPool,
    });

    const response = await settler.settle(settleReq);

    expect(response.success).toBe(true);
    expect(broadcastedTransactions.length).toBe(1);

    // Verify broadcasted transaction has a valid relayer signature
    const sentTx = broadcastedTransactions[0];
    expect(sentTx.relayerSignature).toBeDefined();
    expect(sentTx.relayerSignature!.length).toBe(64);
  });

  it("4. should enforce idempotency and return cached txHash without re-broadcasting", async () => {
    const amount = "1000000000000000000";
    const txPayload = await createSignedTransaction({
      value: BigInt(amount),
      receiver: receiverAddress,
    });

    const requirements = {
      scheme: "exact" as const,
      network: "multiversx:D",
      asset: "EGLD",
      amount: amount,
      payTo: receiverAddress.toBech32(),
      maxTimeoutSeconds: 60,
    };

    const settleReq: SettleRequest = {
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: txPayload,
      },
      paymentRequirements: requirements,
    };

    const settler = new SettlerService({
      storage: memoryStorage,
      networkProvider: mockNetworkProvider,
      relayerPool,
    });

    // First settlement
    const res1 = await settler.settle(settleReq);
    expect(res1.success).toBe(true);
    expect(broadcastedTransactions.length).toBe(1);
    const firstTxHash = res1.transaction;

    // Second settlement with exact same payload
    const res2 = await settler.settle(settleReq);
    expect(res2.success).toBe(true);
    expect(res2.transaction).toBe(firstTxHash);
    // Crucial: No second broadcast happened!
    expect(broadcastedTransactions.length).toBe(1);
  });

  it("5. should reject settlement and mark record failed when payment verification fails", async () => {
    const amount = "1000000000000000000";
    const txPayload = await createSignedTransaction({
      value: BigInt(amount),
      receiver: receiverAddress,
    });

    // Requirements require 2 EGLD, but payload only sent 1 EGLD
    const requirements = {
      scheme: "exact" as const,
      network: "multiversx:D",
      asset: "EGLD",
      amount: "2000000000000000000",
      payTo: receiverAddress.toBech32(),
      maxTimeoutSeconds: 60,
    };

    const settleReq: SettleRequest = {
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: txPayload,
      },
      paymentRequirements: requirements,
    };

    const settler = new SettlerService({
      storage: memoryStorage,
      networkProvider: mockNetworkProvider,
      relayerPool,
    });

    const response = await settler.settle(settleReq);

    expect(response.success).toBe(false);
    expect(response.errorCode).toBe(PaymentErrorCode.PAYMENT_UNFUNDED);
    expect(broadcastedTransactions.length).toBe(0);

    // Verify storage record is saved as failed
    const records = await memoryStorage.list();
    expect(records.length).toBe(1);
    expect(records[0].status).toBe("failed");
    expect(records[0].errorCode).toBe(PaymentErrorCode.PAYMENT_UNFUNDED);
  });

  it("6. should fail settlement when pre-broadcast simulation fails", async () => {
    const failingProvider: INetworkProvider = {
      simulateTransaction: async (): Promise<ISimulationResult> => ({
        status: "fail",
        failReason: "insufficient funds for transfer",
      }),
      sendTransaction: async () => "hash",
      getTransaction: async () => ({}),
      getAccount: async () => ({}),
    };

    const amount = "1000000000000000000";
    const txPayload = await createSignedTransaction({
      value: BigInt(amount),
      receiver: receiverAddress,
    });

    const requirements = {
      scheme: "exact" as const,
      network: "multiversx:D",
      asset: "EGLD",
      amount: amount,
      payTo: receiverAddress.toBech32(),
      maxTimeoutSeconds: 60,
    };

    const settleReq: SettleRequest = {
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: txPayload,
      },
      paymentRequirements: requirements,
    };

    const settler = new SettlerService({
      storage: memoryStorage,
      networkProvider: failingProvider,
      simulateBeforeBroadcast: true,
      relayerPool,
    });

    const response = await settler.settle(settleReq);

    expect(response.success).toBe(false);
    expect(response.errorCode).toBe(PaymentErrorCode.PAYMENT_UNFUNDED);
    expect(response.errorReason).toContain("insufficient funds");

    // Storage should record failure
    const records = await memoryStorage.list();
    expect(records.length).toBe(1);
    expect(records[0].status).toBe("failed");
  });

  it("7. should fail settlement and record failure when networkProvider.sendTransaction throws", async () => {
    const errorProvider: INetworkProvider = {
      simulateTransaction: async (): Promise<ISimulationResult> => ({
        status: "success",
      }),
      sendTransaction: async () => {
        throw new Error("RPC gateway connection timeout");
      },
      getTransaction: async () => ({}),
      getAccount: async () => ({}),
    };

    const amount = "1000000000000000000";
    const txPayload = await createSignedTransaction({
      value: BigInt(amount),
      receiver: receiverAddress,
    });

    const requirements = {
      scheme: "exact" as const,
      network: "multiversx:D",
      asset: "EGLD",
      amount: amount,
      payTo: receiverAddress.toBech32(),
      maxTimeoutSeconds: 60,
    };

    const settleReq: SettleRequest = {
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: txPayload,
      },
      paymentRequirements: requirements,
    };

    const settler = new SettlerService({
      storage: memoryStorage,
      networkProvider: errorProvider,
      relayerPool,
    });

    const response = await settler.settle(settleReq);

    expect(response.success).toBe(false);
    expect(response.errorReason).toContain("RPC gateway connection timeout");

    const records = await memoryStorage.list();
    expect(records.length).toBe(1);
    expect(records[0].status).toBe("failed");
    expect(records[0].errorReason).toContain("RPC gateway connection timeout");
  });

  it("8. should work seamlessly with SQLite storage backend", async () => {
    const sqliteStorage = new SqliteSettlementStorage(":memory:");
    const amount = "1000000000000000000";
    const txPayload = await createSignedTransaction({
      value: BigInt(amount),
      receiver: receiverAddress,
    });

    const requirements = {
      scheme: "exact" as const,
      network: "multiversx:D",
      asset: "EGLD",
      amount: amount,
      payTo: receiverAddress.toBech32(),
      maxTimeoutSeconds: 60,
    };

    const settleReq: SettleRequest = {
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: txPayload,
      },
      paymentRequirements: requirements,
    };

    const settler = new SettlerService({
      storage: sqliteStorage,
      networkProvider: mockNetworkProvider,
      relayerPool,
    });

    const response = await settler.settle(settleReq);
    expect(response.success).toBe(true);

    const records = await sqliteStorage.list();
    expect(records.length).toBe(1);
    expect(records[0].status).toBe("completed");
    expect(records[0].txHash).toBe("0xdeadbeef1234567890abcdef1");

    await sqliteStorage.close();
  });
});
