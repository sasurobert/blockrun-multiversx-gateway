import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ISettlementStorage, SettlementRecord } from "../../src/storage/types.js";
import { MemorySettlementStorage } from "../../src/storage/memory_storage.js";
import { SqliteSettlementStorage } from "../../src/storage/sqlite_storage.js";
import { PaymentErrorCode } from "../../src/domain/types.js";
import fs from "fs";
import path from "path";
import os from "os";

function runStorageTestSuite(name: string, createStorage: () => Promise<ISettlementStorage> | ISettlementStorage) {
  describe(`Storage Implementation: ${name}`, () => {
    let storage: ISettlementStorage;

    beforeEach(async () => {
      storage = await createStorage();
    });

    afterEach(async () => {
      await storage.close();
    });

    it("should save and retrieve a settlement record by id", async () => {
      const record: SettlementRecord = {
        id: "settle-1",
        signatureHash: "sig-hash-1",
        payer: "erd1qqqqqqqqqqqqqpgqhe8t5jewej70zupmh44eurgn29psua5l2jps3ntjj3",
        receiver: "erd1spyavw0956vq68xj8ymmxtxws2ah0mgr2ww05nv2gl35dp9xnseq6lvd30",
        asset: "EGLD",
        amount: "1000000000000000000",
        status: "pending",
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
        validBefore: 1700003600,
      };

      await storage.save(record);
      const retrieved = await storage.getById("settle-1");

      expect(retrieved).not.toBeNull();
      expect(retrieved).toEqual(record);
    });

    it("should retrieve a settlement record by signatureHash", async () => {
      const record: SettlementRecord = {
        id: "settle-2",
        signatureHash: "unique-sig-hash-2",
        payer: "erd1qqqqqqqqqqqqqpgqhe8t5jewej70zupmh44eurgn29psua5l2jps3ntjj3",
        receiver: "erd1spyavw0956vq68xj8ymmxtxws2ah0mgr2ww05nv2gl35dp9xnseq6lvd30",
        asset: "USDC-c76f1f",
        amount: "5000000",
        status: "completed",
        txHash: "0x1234567890abcdef",
        createdAt: 1700000000000,
        updatedAt: 1700000001000,
      };

      await storage.save(record);
      const retrieved = await storage.getBySignatureHash("unique-sig-hash-2");

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe("settle-2");
      expect(retrieved?.txHash).toBe("0x1234567890abcdef");
      expect(retrieved?.status).toBe("completed");
    });

    it("should return null for non-existent id and signatureHash", async () => {
      const byId = await storage.getById("non-existent-id");
      expect(byId).toBeNull();

      const bySig = await storage.getBySignatureHash("non-existent-sig");
      expect(bySig).toBeNull();
    });

    it("should update settlement status to completed with txHash", async () => {
      const record: SettlementRecord = {
        id: "settle-3",
        signatureHash: "sig-hash-3",
        payer: "erd1payer",
        receiver: "erd1receiver",
        asset: "EGLD",
        amount: "100",
        status: "pending",
        createdAt: 1000,
        updatedAt: 1000,
      };

      await storage.save(record);
      await storage.updateStatus("settle-3", "completed", {
        txHash: "tx-hash-success-3",
      });

      const updated = await storage.getById("settle-3");
      expect(updated?.status).toBe("completed");
      expect(updated?.txHash).toBe("tx-hash-success-3");
      expect(updated?.updatedAt).toBeGreaterThanOrEqual(1000);
    });

    it("should update settlement status to failed with errorReason and errorCode", async () => {
      const record: SettlementRecord = {
        id: "settle-4",
        signatureHash: "sig-hash-4",
        payer: "erd1payer",
        receiver: "erd1receiver",
        asset: "EGLD",
        amount: "100",
        status: "pending",
        createdAt: 1000,
        updatedAt: 1000,
      };

      await storage.save(record);
      await storage.updateStatus("settle-4", "failed", {
        errorReason: "Transaction reverted on chain",
        errorCode: PaymentErrorCode.PAYMENT_INVALID,
      });

      const updated = await storage.getById("settle-4");
      expect(updated?.status).toBe("failed");
      expect(updated?.errorReason).toBe("Transaction reverted on chain");
      expect(updated?.errorCode).toBe(PaymentErrorCode.PAYMENT_INVALID);
    });

    it("should query records with filters, limit, and offset", async () => {
      const payerA = "erd1qqqqqqqqqqqqqpgqhe8t5jewej70zupmh44eurgn29psua5l2jps3ntjj3";
      const payerB = "erd1spyavw0956vq68xj8ymmxtxws2ah0mgr2ww05nv2gl35dp9xnseq6lvd30";

      const records: SettlementRecord[] = [
        {
          id: "r1",
          signatureHash: "s1",
          payer: payerA,
          receiver: "erd1rec",
          asset: "EGLD",
          amount: "1",
          status: "completed",
          createdAt: 100,
          updatedAt: 100,
        },
        {
          id: "r2",
          signatureHash: "s2",
          payer: payerA,
          receiver: "erd1rec",
          asset: "EGLD",
          amount: "2",
          status: "pending",
          createdAt: 200,
          updatedAt: 200,
        },
        {
          id: "r3",
          signatureHash: "s3",
          payer: payerB,
          receiver: "erd1rec",
          asset: "EGLD",
          amount: "3",
          status: "completed",
          createdAt: 300,
          updatedAt: 300,
        },
        {
          id: "r4",
          signatureHash: "s4",
          payer: payerB,
          receiver: "erd1rec",
          asset: "EGLD",
          amount: "4",
          status: "failed",
          createdAt: 400,
          updatedAt: 400,
        },
      ];

      for (const r of records) {
        await storage.save(r);
      }

      // Filter by payer
      const forPayerA = await storage.list({ payer: payerA });
      expect(forPayerA.length).toBe(2);
      expect(forPayerA.map((r) => r.id).sort()).toEqual(["r1", "r2"]);

      // Filter by status
      const completed = await storage.list({ status: "completed" });
      expect(completed.length).toBe(2);
      expect(completed.map((r) => r.id).sort()).toEqual(["r1", "r3"]);

      // Filter by payer AND status
      const payerBFailed = await storage.list({ payer: payerB, status: "failed" });
      expect(payerBFailed.length).toBe(1);
      expect(payerBFailed[0].id).toBe("r4");

      // Limit and offset
      const paged = await storage.list({ limit: 2, offset: 1 });
      expect(paged.length).toBe(2);
    });

    it("should handle updating non-existent record gracefully without throwing", async () => {
      await expect(
        storage.updateStatus("missing-id", "completed", { txHash: "0x123" })
      ).resolves.not.toThrow();
    });
  });
}

// 1. In-Memory Storage Test Suite
runStorageTestSuite("MemorySettlementStorage", () => new MemorySettlementStorage());

// 2. SQLite In-Memory Storage Test Suite
runStorageTestSuite("SqliteSettlementStorage (Memory)", () => new SqliteSettlementStorage(":memory:"));

// 3. SQLite File-Based Persistence Test Suite
describe("SqliteSettlementStorage File Persistence", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "settlement-sqlite-test-"));
    dbPath = path.join(tmpDir, "settlements.db");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should persist records across multiple database instances", async () => {
    const storage1 = new SqliteSettlementStorage(dbPath);
    const record: SettlementRecord = {
      id: "persist-1",
      signatureHash: "hash-persist-1",
      payer: "erd1qqqqqqqqqqqqqpgqhe8t5jewej70zupmh44eurgn29psua5l2jps3ntjj3",
      receiver: "erd1spyavw0956vq68xj8ymmxtxws2ah0mgr2ww05nv2gl35dp9xnseq6lvd30",
      asset: "EGLD",
      amount: "1000",
      status: "completed",
      txHash: "tx-persist-hash",
      createdAt: 1700000000000,
      updatedAt: 1700000001000,
      validBefore: 1700005000,
    };

    await storage1.save(record);
    await storage1.close();

    // Reopen with new instance
    const storage2 = new SqliteSettlementStorage(dbPath);
    const retrieved = await storage2.getById("persist-1");

    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe("persist-1");
    expect(retrieved?.signatureHash).toBe("hash-persist-1");
    expect(retrieved?.status).toBe("completed");
    expect(retrieved?.txHash).toBe("tx-persist-hash");
    expect(retrieved?.validBefore).toBe(1700005000);

    await storage2.close();
  });
});
