import { describe, it, expect } from "vitest";
import { MultiversXGasCalculator } from "../../src/services/gas_calculator";

describe("MultiversXGasCalculator", () => {
  it("should calculate exact gas for a plain native EGLD transfer without data", () => {
    const result = MultiversXGasCalculator.calculate({
      data: "",
      isRelayed: false,
    });

    expect(result.dataByteLength).toBe(0);
    expect(result.dataGas).toBe(0n);
    expect(result.moveGas).toBe(50_000n);
    expect(result.executionGas).toBe(0n);
    expect(result.gasLimit).toBe(50_000n);
    expect(result.feeInWei).toBe(50_000n * 1_000_000_000n);
  });

  it("should calculate exact gas for native EGLD transfer with data and relayed", () => {
    const data = "hello multiversx";
    const result = MultiversXGasCalculator.calculate({
      data,
      isRelayed: true,
    });

    const expectedDataGas = BigInt(data.length) * 1_500n;
    const expectedMoveGas = 50_000n + expectedDataGas + 50_000n; // min + data + relayed

    expect(result.dataByteLength).toBe(data.length);
    expect(result.dataGas).toBe(expectedDataGas);
    expect(result.moveGas).toBe(expectedMoveGas);
    expect(result.executionGas).toBe(0n);
    expect(result.gasLimit).toBe(expectedMoveGas);
  });

  it("should calculate exact gas for Relayed V3 ESDTTransfer (USDC payment)", () => {
    // 0.50 USDC = 500,000 micro = 0x07a120
    const result = MultiversXGasCalculator.forEsdtTransfer("USDC-350c4e", 500_000n, true);

    // data: "ESDTTransfer@555344432d333530633465@07a120" (42 bytes)
    expect(result.dataByteLength).toBe(42);
    expect(result.dataGas).toBe(42n * 1_500n); // 63,000
    expect(result.moveGas).toBe(50_000n + 63_000n + 50_000n); // 163,000
    expect(result.executionGas).toBe(200_000n); // 200,000
    expect(result.gasLimit).toBe(363_000n); // 163,000 + 200,000
    expect(result.feeInWei).toBe(363_000n * 1_000_000_000n); // 363,000 Gwei = 0.000363 EGLD
  });

  it("should calculate exact gas for direct (non-relayed) ESDT transfer", () => {
    const result = MultiversXGasCalculator.forEsdtTransfer("USDC-350c4e", 500_000n, false);

    // Without extra 50,000 relayed gas
    expect(result.moveGas).toBe(50_000n + 63_000n); // 113,000
    expect(result.executionGas).toBe(200_000n);
    expect(result.gasLimit).toBe(313_000n);
  });

  it("should dynamically adjust gas limit when amount hex length changes", () => {
    // 10,000 USDC = 10,000,000,000 micro = 0x02540be400 (10 chars = 2 chars longer than 07a120)
    const result = MultiversXGasCalculator.forEsdtTransfer("USDC-350c4e", 10_000_000_000n, true);

    // 46 bytes (10 hex chars amount vs 6 hex chars = +4 chars)
    expect(result.dataByteLength).toBe(46);
    expect(result.dataGas).toBe(46n * 1_500n); // 69,000
    expect(result.moveGas).toBe(50_000n + 69_000n + 50_000n); // 169,000
    expect(result.executionGas).toBe(200_000n);
    expect(result.gasLimit).toBe(369_000n);
  });

  it("should calculate gas for MultiESDTNFTTransfer with multiple tokens", () => {
    const result = MultiversXGasCalculator.forMultiEsdtTransfer(3, 100, true);

    expect(result.executionGas).toBe(200_000n * 3n); // 600,000
    expect(result.dataGas).toBe(100n * 1_500n); // 150,000
    expect(result.moveGas).toBe(50_000n + 150_000n + 50_000n); // 250,000
    expect(result.gasLimit).toBe(850_000n);
  });
});
