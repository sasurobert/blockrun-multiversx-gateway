import { describe, it, expect, beforeAll } from "vitest";
import { Address, Transaction, TransactionComputer } from "@multiversx/sdk-core";
import { Mnemonic, UserSigner } from "@multiversx/sdk-wallet";
import { PaymentErrorCode, VerifyRequest, X402PaymentPayload } from "../../src/domain/types.js";
import { INetworkProvider, ISimulationResult } from "../../src/domain/network.js";
import { RelayerPoolManager } from "../../src/services/relayer_pool.js";
import { VerifierService } from "../../src/services/verifier.js";
import { buildEsdtTransferData, buildMultiEsdtTransferData } from "../../src/utils/data_parser.js";

describe("VerifierService (x402 Payment Verification)", () => {
  let userMnemonic: Mnemonic;
  let userSigner: UserSigner;
  let userAddress: Address;

  let receiverMnemonic: Mnemonic;
  let receiverSigner: UserSigner;
  let receiverAddress: Address;

  let relayerPool: RelayerPoolManager;
  let relayerAddressForUser: string;
  let relayerSignerForUser: UserSigner;

  let tc: TransactionComputer;

  beforeAll(() => {
    tc = new TransactionComputer();

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
    const sender = params.signer ? Address.newFromBech32(params.signer.getAddress().bech32()) : userAddress;
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

  it("1. should verify valid EGLD exact payment payload successfully", async () => {
    const amount = "1000000000000000000"; // 1 EGLD
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

    const verifyReq: VerifyRequest = {
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: {
          signature: txPayload.signature,
          transaction: txPayload,
        },
      },
      paymentRequirements: requirements,
    };

    const verifier = new VerifierService({ relayerPool });
    const result = await verifier.verify(verifyReq);

    expect(result.isValid).toBe(true);
    expect(result.payer).toBe(userAddress.toBech32());
    expect(result.errorCode).toBeUndefined();
    expect(result.invalidReason).toBeUndefined();
  });

  it("2. should verify valid ESDTTransfer payload successfully (e.g. USDC-c76f1f)", async () => {
    const token = "USDC-c76f1f";
    const amount = "5000000"; // 5 USDC (6 decimals)
    const data = buildEsdtTransferData(token, amount);

    const txPayload = await createSignedTransaction({
      value: 0n,
      receiver: receiverAddress,
      data: data,
    });

    const requirements = {
      scheme: "exact" as const,
      network: "multiversx:D",
      asset: token,
      amount: amount,
      payTo: receiverAddress.toBech32(),
      maxTimeoutSeconds: 60,
    };

    const verifyReq: VerifyRequest = {
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: {
          signature: txPayload.signature,
          transaction: txPayload,
        },
      },
      paymentRequirements: requirements,
    };

    const verifier = new VerifierService({ relayerPool });
    const result = await verifier.verify(verifyReq);

    expect(result.isValid).toBe(true);
    expect(result.payer).toBe(userAddress.toBech32());
  });

  it("3. should verify valid MultiESDTNFTTransfer payload successfully", async () => {
    const token = "USDC-c76f1f";
    const amount = "10000000";
    const data = buildMultiEsdtTransferData(receiverAddress.toBech32(), [
      { tokenIdentifier: token, amount: amount },
    ]);

    // In MultiESDTNFTTransfer, tx.receiver is sender itself
    const txPayload = await createSignedTransaction({
      value: 0n,
      receiver: userAddress,
      data: data,
    });

    const requirements = {
      scheme: "exact" as const,
      network: "multiversx:D",
      asset: token,
      amount: amount,
      payTo: receiverAddress.toBech32(),
      maxTimeoutSeconds: 60,
    };

    const verifyReq: VerifyRequest = {
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: {
          signature: txPayload.signature,
          transaction: txPayload,
        },
      },
      paymentRequirements: requirements,
    };

    const verifier = new VerifierService({ relayerPool });
    const result = await verifier.verify(verifyReq);

    expect(result.isValid).toBe(true);
    expect(result.payer).toBe(userAddress.toBech32());
  });

  it("4. should verify Relayed V3 transaction with relayer signature & relayer address matching", async () => {
    const amount = "1000000000000000000";
    const relayerAddr = Address.newFromBech32(relayerAddressForUser);

    const txPayload = await createSignedTransaction({
      value: BigInt(amount),
      receiver: receiverAddress,
      relayer: relayerAddr,
      relayerSigner: relayerSignerForUser,
    });

    const requirements = {
      scheme: "exact" as const,
      network: "multiversx:D",
      asset: "EGLD",
      amount: amount,
      payTo: receiverAddress.toBech32(),
      maxTimeoutSeconds: 60,
    };

    const verifyReq: VerifyRequest = {
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: {
          signature: txPayload.signature,
          transaction: txPayload,
        },
      },
      paymentRequirements: requirements,
    };

    const verifier = new VerifierService({ relayerPool });
    const result = await verifier.verify(verifyReq);

    expect(result.isValid).toBe(true);
    expect(result.payer).toBe(userAddress.toBech32());
  });

  it("5. should reject transaction with invalid user signature -> PAYMENT_INVALID", async () => {
    const amount = "1000000000000000000";
    const txPayload = await createSignedTransaction({
      value: BigInt(amount),
      receiver: receiverAddress,
    });

    // Tamper with signature
    const corruptedSig = "0".repeat(128);
    txPayload.signature = corruptedSig;

    const requirements = {
      scheme: "exact" as const,
      network: "multiversx:D",
      asset: "EGLD",
      amount: amount,
      payTo: receiverAddress.toBech32(),
      maxTimeoutSeconds: 60,
    };

    const verifyReq: VerifyRequest = {
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: {
          signature: corruptedSig,
          transaction: txPayload,
        },
      },
      paymentRequirements: requirements,
    };

    const verifier = new VerifierService({ relayerPool });
    const result = await verifier.verify(verifyReq);

    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe(PaymentErrorCode.PAYMENT_INVALID);
    expect(result.invalidReason).toContain("signature");
  });

  it("6. should reject transaction with insufficient amount -> PAYMENT_UNFUNDED", async () => {
    const requestedAmount = "2000000000000000000"; // 2 EGLD required
    const actualAmount = "1000000000000000000";    // only 1 EGLD provided

    const txPayload = await createSignedTransaction({
      value: BigInt(actualAmount),
      receiver: receiverAddress,
    });

    const requirements = {
      scheme: "exact" as const,
      network: "multiversx:D",
      asset: "EGLD",
      amount: requestedAmount,
      payTo: receiverAddress.toBech32(),
      maxTimeoutSeconds: 60,
    };

    const verifyReq: VerifyRequest = {
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: {
          signature: txPayload.signature,
          transaction: txPayload,
        },
      },
      paymentRequirements: requirements,
    };

    const verifier = new VerifierService({ relayerPool });
    const result = await verifier.verify(verifyReq);

    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe(PaymentErrorCode.PAYMENT_UNFUNDED);
    expect(result.invalidReason).toContain("Insufficient");
  });

  it("7. should reject transaction with receiver mismatch -> PAYMENT_INVALID", async () => {
    const otherMnemonic = Mnemonic.generate();
    const otherAddress = Address.newFromBech32(
      new UserSigner(otherMnemonic.deriveKey(0)).getAddress().bech32()
    );

    const amount = "1000000000000000000";
    const txPayload = await createSignedTransaction({
      value: BigInt(amount),
      receiver: otherAddress, // Sending to wrong recipient
    });

    const requirements = {
      scheme: "exact" as const,
      network: "multiversx:D",
      asset: "EGLD",
      amount: amount,
      payTo: receiverAddress.toBech32(),
      maxTimeoutSeconds: 60,
    };

    const verifyReq: VerifyRequest = {
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: {
          signature: txPayload.signature,
          transaction: txPayload,
        },
      },
      paymentRequirements: requirements,
    };

    const verifier = new VerifierService({ relayerPool });
    const result = await verifier.verify(verifyReq);

    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe(PaymentErrorCode.PAYMENT_INVALID);
    expect(result.invalidReason).toContain("Receiver mismatch");
  });

  it("8. should reject transaction with asset mismatch -> PAYMENT_INVALID", async () => {
    const amount = "1000000";
    const data = buildEsdtTransferData("OTHER-token", amount);

    const txPayload = await createSignedTransaction({
      value: 0n,
      receiver: receiverAddress,
      data: data,
    });

    const requirements = {
      scheme: "exact" as const,
      network: "multiversx:D",
      asset: "USDC-c76f1f", // Expected USDC
      amount: amount,
      payTo: receiverAddress.toBech32(),
      maxTimeoutSeconds: 60,
    };

    const verifyReq: VerifyRequest = {
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: {
          signature: txPayload.signature,
          transaction: txPayload,
        },
      },
      paymentRequirements: requirements,
    };

    const verifier = new VerifierService({ relayerPool });
    const result = await verifier.verify(verifyReq);

    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe(PaymentErrorCode.PAYMENT_INVALID);
    expect(result.invalidReason).toContain("Asset mismatch");
  });

  it("9. should reject expired transaction (validBefore in past) -> PAYMENT_EXPIRED", async () => {
    const amount = "1000000000000000000";
    const pastTimestamp = Math.floor(Date.now() / 1000) - 300; // 5 mins ago

    const txPayload = await createSignedTransaction({
      value: BigInt(amount),
      receiver: receiverAddress,
      validBefore: pastTimestamp,
    });

    const requirements = {
      scheme: "exact" as const,
      network: "multiversx:D",
      asset: "EGLD",
      amount: amount,
      payTo: receiverAddress.toBech32(),
      maxTimeoutSeconds: 60,
    };

    const verifyReq: VerifyRequest = {
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: {
          signature: txPayload.signature,
          transaction: txPayload,
        },
      },
      paymentRequirements: requirements,
    };

    const verifier = new VerifierService({ relayerPool });
    const result = await verifier.verify(verifyReq);

    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe(PaymentErrorCode.PAYMENT_EXPIRED);
    expect(result.invalidReason).toContain("expired");
  });

  it("10. should reject premature transaction (validAfter in future) -> PAYMENT_INVALID", async () => {
    const amount = "1000000000000000000";
    const futureTimestamp = Math.floor(Date.now() / 1000) + 3600; // 1 hour in future

    const txPayload = await createSignedTransaction({
      value: BigInt(amount),
      receiver: receiverAddress,
      validAfter: futureTimestamp,
    });

    const requirements = {
      scheme: "exact" as const,
      network: "multiversx:D",
      asset: "EGLD",
      amount: amount,
      payTo: receiverAddress.toBech32(),
      maxTimeoutSeconds: 60,
    };

    const verifyReq: VerifyRequest = {
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: {
          signature: txPayload.signature,
          transaction: txPayload,
        },
      },
      paymentRequirements: requirements,
    };

    const verifier = new VerifierService({ relayerPool });
    const result = await verifier.verify(verifyReq);

    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe(PaymentErrorCode.PAYMENT_INVALID);
    expect(result.invalidReason).toContain("not yet valid");
  });

  it("11. should reject when network simulation fails -> PAYMENT_UNFUNDED or PAYMENT_INVALID", async () => {
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

    const verifyReq: VerifyRequest = {
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: {
          signature: txPayload.signature,
          transaction: txPayload,
        },
      },
      paymentRequirements: requirements,
    };

    // Mock network provider returning simulation failure
    const mockProvider: INetworkProvider = {
      simulateTransaction: async (): Promise<ISimulationResult> => ({
        status: "fail",
        failReason: "insufficient funds for transfer",
        returnCode: "insufficient funds",
      }),
      sendTransaction: async () => "hash",
      getTransaction: async () => ({}),
      getAccount: async () => ({}),
    };

    const verifier = new VerifierService({ relayerPool, networkProvider: mockProvider });
    const result = await verifier.verify(verifyReq);

    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe(PaymentErrorCode.PAYMENT_UNFUNDED);
    expect(result.invalidReason).toContain("insufficient funds");
  });

  it("12. should support direct transaction in payload container", async () => {
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

    const verifyReq: VerifyRequest = {
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: txPayload, // Direct transaction payload
      },
      paymentRequirements: requirements,
    };

    const verifier = new VerifierService({ relayerPool });
    const result = await verifier.verify(verifyReq);

    expect(result.isValid).toBe(true);
    expect(result.payer).toBe(userAddress.toBech32());
  });

  it("13. should verify MultiESDTNFTTransfer with multiple bundled transfers when target asset matches", async () => {
    const data = buildMultiEsdtTransferData(receiverAddress.toBech32(), [
      { tokenIdentifier: "OTHER-123456", amount: "500" },
      { tokenIdentifier: "USDC-c76f1f", amount: "2000000" },
    ]);

    const txPayload = await createSignedTransaction({
      value: 0n,
      receiver: userAddress,
      data: data,
    });

    const requirements = {
      scheme: "exact" as const,
      network: "multiversx:D",
      asset: "USDC-c76f1f",
      amount: "2000000",
      payTo: receiverAddress.toBech32(),
      maxTimeoutSeconds: 60,
    };

    const verifyReq: VerifyRequest = {
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: txPayload,
      },
      paymentRequirements: requirements,
    };

    const verifier = new VerifierService({ relayerPool });
    const result = await verifier.verify(verifyReq);

    expect(result.isValid).toBe(true);
    expect(result.payer).toBe(userAddress.toBech32());
  });

  it("14. should reject transaction with network chain ID mismatch", async () => {
    const amount = "1000000000000000000";
    const txPayload = await createSignedTransaction({
      value: BigInt(amount),
      receiver: receiverAddress,
      chainID: "1", // Mainnet chainID in tx
    });

    const requirements = {
      scheme: "exact" as const,
      network: "multiversx:D", // Devnet expected
      asset: "EGLD",
      amount: amount,
      payTo: receiverAddress.toBech32(),
      maxTimeoutSeconds: 60,
    };

    const verifyReq: VerifyRequest = {
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: txPayload,
      },
      paymentRequirements: requirements,
    };

    const verifier = new VerifierService({ relayerPool });
    const result = await verifier.verify(verifyReq);

    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe(PaymentErrorCode.PAYMENT_INVALID);
    expect(result.invalidReason).toContain("Network mismatch");
  });

  it("15. should reject Relayed V3 transaction with wrong relayer for user shard", async () => {
    const otherRelayerMnemonic = Mnemonic.generate();
    const otherRelayerAddress = Address.newFromBech32(
      new UserSigner(otherRelayerMnemonic.deriveKey(0)).getAddress().bech32()
    );

    const amount = "1000000000000000000";
    const txPayload = await createSignedTransaction({
      value: BigInt(amount),
      receiver: receiverAddress,
      relayer: otherRelayerAddress, // Unregistered / wrong relayer
    });

    const requirements = {
      scheme: "exact" as const,
      network: "multiversx:D",
      asset: "EGLD",
      amount: amount,
      payTo: receiverAddress.toBech32(),
      maxTimeoutSeconds: 60,
    };

    const verifyReq: VerifyRequest = {
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: txPayload,
      },
      paymentRequirements: requirements,
    };

    const verifier = new VerifierService({ relayerPool });
    const result = await verifier.verify(verifyReq);

    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe(PaymentErrorCode.PAYMENT_INVALID);
    expect(result.invalidReason).toContain("Relayer address mismatch");
  });

  it("16. should reject Relayed V3 transaction with corrupted relayer signature", async () => {
    const amount = "1000000000000000000";
    const relayerAddr = Address.newFromBech32(relayerAddressForUser);

    const txPayload = await createSignedTransaction({
      value: BigInt(amount),
      receiver: receiverAddress,
      relayer: relayerAddr,
      relayerSigner: relayerSignerForUser,
    });

    // Corrupt relayer signature
    txPayload.relayerSignature = "1".repeat(128);

    const requirements = {
      scheme: "exact" as const,
      network: "multiversx:D",
      asset: "EGLD",
      amount: amount,
      payTo: receiverAddress.toBech32(),
      maxTimeoutSeconds: 60,
    };

    const verifyReq: VerifyRequest = {
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: txPayload,
      },
      paymentRequirements: requirements,
    };

    const verifier = new VerifierService({ relayerPool });
    const result = await verifier.verify(verifyReq);

    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe(PaymentErrorCode.PAYMENT_INVALID);
    expect(result.invalidReason).toContain("relayer signature");
  });

  it("17. should succeed when simulation passes with status 'success' or 'executed'", async () => {
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

    const verifyReq: VerifyRequest = {
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: txPayload,
      },
      paymentRequirements: requirements,
    };

    const mockProvider: INetworkProvider = {
      simulateTransaction: async (): Promise<ISimulationResult> => ({
        status: "success",
        returnCode: "ok",
      }),
      sendTransaction: async () => "hash",
      getTransaction: async () => ({}),
      getAccount: async () => ({}),
    };

    const verifier = new VerifierService({ relayerPool, networkProvider: mockProvider });
    const result = await verifier.verify(verifyReq);

    expect(result.isValid).toBe(true);
    expect(result.payer).toBe(userAddress.toBech32());
  });

  it("18. should handle corrupted ESDT data gracefully and return PAYMENT_INVALID", async () => {
    const txPayload = await createSignedTransaction({
      data: "ESDTTransfer@invalidhex!@123",
      receiver: receiverAddress,
    });

    const requirements = {
      scheme: "exact" as const,
      network: "multiversx:D",
      asset: "USDC-c76f1f",
      amount: "1000000",
      payTo: receiverAddress.toBech32(),
      maxTimeoutSeconds: 60,
    };

    const verifyReq: VerifyRequest = {
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: txPayload,
      },
      paymentRequirements: requirements,
    };

    const verifier = new VerifierService({ relayerPool });
    const result = await verifier.verify(verifyReq);

    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe(PaymentErrorCode.PAYMENT_INVALID);
  });

  it("19. should handle invalid bech32 address in payload gracefully and return PAYMENT_INVALID", async () => {
    const txPayload = await createSignedTransaction({
      value: 1000000000000000000n,
      receiver: receiverAddress,
    });

    // Corrupt the sender address with invalid bech32 characters
    const corruptedPayload = {
      ...txPayload,
      sender: "erd1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq", // Invalid checksum / invalid address
    };

    const requirements = {
      scheme: "exact" as const,
      network: "multiversx:D",
      asset: "EGLD",
      amount: "1000000000000000000",
      payTo: receiverAddress.toBech32(),
      maxTimeoutSeconds: 60,
    };

    const verifyReq: VerifyRequest = {
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: corruptedPayload,
      },
      paymentRequirements: requirements,
    };

    const verifier = new VerifierService({ relayerPool });
    const result = await verifier.verify(verifyReq);

    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe(PaymentErrorCode.PAYMENT_INVALID);
  });

  it("20. should reject ESDTTransfer with injected smart contract endpoint arguments (SEC-01)", async () => {
    const asset = "USDC-c76f1f";
    const amount = "1000000";
    // Maliciously crafted data: ESDTTransfer@token@amount@drainFunction@arg1@arg2
    const maliciousData = `ESDTTransfer@${Buffer.from(asset).toString("hex")}@${BigInt(amount).toString(16)}@${Buffer.from("drainVault").toString("hex")}@01`;

    const txPayload = await createSignedTransaction({
      data: maliciousData,
      receiver: receiverAddress,
    });

    const requirements = {
      scheme: "exact" as const,
      network: "multiversx:D",
      asset: asset,
      amount: amount,
      payTo: receiverAddress.toBech32(),
      maxTimeoutSeconds: 60,
    };

    const verifyReq: VerifyRequest = {
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: txPayload,
      },
      paymentRequirements: requirements,
    };

    const verifier = new VerifierService({ relayerPool });
    const result = await verifier.verify(verifyReq);

    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe(PaymentErrorCode.PAYMENT_INVALID);
    expect(result.invalidReason).toContain("transfer");
  });

  it("21. should reject native EGLD transfer with injected contract data (SEC-01)", async () => {
    const amount = "1000000000000000000";
    // Malicious contract call data attached to EGLD transfer
    const maliciousData = "claimRewards@01";

    const txPayload = await createSignedTransaction({
      value: BigInt(amount),
      data: maliciousData,
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

    const verifyReq: VerifyRequest = {
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: txPayload,
      },
      paymentRequirements: requirements,
    };

    const verifier = new VerifierService({ relayerPool });
    const result = await verifier.verify(verifyReq);

    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe(PaymentErrorCode.PAYMENT_INVALID);
  });

  it("22. should reject transaction with gasPrice exceeding MAX_ALLOWED_GAS_PRICE (SEC-02)", async () => {
    const txPayload = await createSignedTransaction({
      value: 1000000000000000000n,
      receiver: receiverAddress,
      gasPrice: 5000000000n, // 5 Gwei (exceeds 2 Gwei maximum)
    });

    const requirements = {
      scheme: "exact" as const,
      network: "multiversx:D",
      asset: "EGLD",
      amount: "1000000000000000000",
      payTo: receiverAddress.toBech32(),
      maxTimeoutSeconds: 60,
    };

    const verifyReq: VerifyRequest = {
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: txPayload,
      },
      paymentRequirements: requirements,
    };

    const verifier = new VerifierService({ relayerPool });
    const result = await verifier.verify(verifyReq);

    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe(PaymentErrorCode.PAYMENT_INVALID);
    expect(result.invalidReason).toContain("gasPrice");
  });

  it("23. should reject Relayed V3 transaction with gasLimit exceeding MAX_ALLOWED_RELAYER_GAS_LIMIT (SEC-02)", async () => {
    const userAddrStr = userSigner.getAddress().bech32();
    const relayerSigner = relayerPool.getRelayerForAddress(userAddrStr);
    const relayerAddrStr = relayerSigner.getAddress().bech32();

    const txPayload = await createSignedTransaction({
      value: 1000000000000000000n,
      receiver: receiverAddress,
      relayer: Address.newFromBech32(relayerAddrStr),
      gasLimit: 5000000n, // 5M gas limit (exceeds 1M maximum for relayer payments)
    });

    const requirements = {
      scheme: "exact" as const,
      network: "multiversx:D",
      asset: "EGLD",
      amount: "1000000000000000000",
      payTo: receiverAddress.toBech32(),
      maxTimeoutSeconds: 60,
    };

    const verifyReq: VerifyRequest = {
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: txPayload,
      },
      paymentRequirements: requirements,
    };

    const verifier = new VerifierService({ relayerPool });
    const result = await verifier.verify(verifyReq);

    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe(PaymentErrorCode.PAYMENT_INVALID);
    expect(result.invalidReason).toContain("gasLimit");
  });

  it("24. should verify valid guardian signature and reject invalid guardian signature (SEC-04)", async () => {
    const guardianMnemonic = Mnemonic.generate();
    const guardianSigner = new UserSigner(guardianMnemonic.deriveKey(0));
    const guardianAddress = Address.newFromBech32(guardianSigner.getAddress().bech32());

    const amount = "1000000000000000000";
    const tx = new Transaction({
      nonce: 1n,
      value: BigInt(amount),
      sender: userAddress,
      receiver: receiverAddress,
      gasPrice: 1000000000n,
      gasLimit: 50000n,
      data: Buffer.from(""),
      chainID: "D",
      version: 2,
      options: 0,
      guardian: guardianAddress,
    });

    const bytesToSign = tc.computeBytesForSigning(tx);
    const userSig = await userSigner.sign(bytesToSign);
    tx.signature = userSig;

    const bytesToVerify = tc.computeBytesForVerifying(tx);
    const guardianSig = await guardianSigner.sign(bytesToVerify);
    tx.guardianSignature = guardianSig;

    const validPayload: MvxTransactionPayload = {
      nonce: Number(tx.nonce),
      value: tx.value.toString(),
      receiver: tx.receiver.toBech32(),
      sender: tx.sender.toBech32(),
      gasPrice: Number(tx.gasPrice),
      gasLimit: Number(tx.gasLimit),
      data: "",
      chainID: tx.chainID,
      version: tx.version,
      options: tx.options,
      signature: userSig.toString("hex"),
      guardian: guardianAddress.toBech32(),
      guardianSignature: guardianSig.toString("hex"),
    };

    const requirements = {
      scheme: "exact" as const,
      network: "multiversx:D",
      asset: "EGLD",
      amount: amount,
      payTo: receiverAddress.toBech32(),
      maxTimeoutSeconds: 60,
    };

    const verifier = new VerifierService({ relayerPool });

    // 1. Valid guardian signature -> true
    const validResult = await verifier.verify({
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: validPayload,
      },
      paymentRequirements: requirements,
    });
    expect(validResult.isValid).toBe(true);

    // 2. Corrupted guardian signature -> false
    const corruptedPayload = {
      ...validPayload,
      guardianSignature: "00".repeat(64),
    };
    const invalidResult = await verifier.verify({
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: corruptedPayload,
      },
      paymentRequirements: requirements,
    });
    expect(invalidResult.isValid).toBe(false);
    expect(invalidResult.errorCode).toBe(PaymentErrorCode.PAYMENT_INVALID);
    expect(invalidResult.invalidReason).toContain("guardian signature");
  });
});

