import { describe, it, expect } from "vitest";
import { FleetService } from "../../src/services/fleet_service.js";

describe("FleetService", () => {
  it("should initialize 3 bots across Shards 0, 1, and 2", () => {
    const service = new FleetService();
    const bots = service.getAllBots();

    expect(bots).toHaveLength(3);
    expect(bots.map((b) => b.shard).sort()).toEqual([0, 1, 2]);

    const bot0 = service.getBotConfig("bot-shard0");
    expect(bot0?.name).toBe("DeFi Yield & Arbitrage Bot");

    const bot1 = service.getBotConfig("bot-shard1");
    expect(bot1?.name).toBe("Smart Contract Security Sentinel");

    const bot2 = service.getBotConfig("bot-shard2");
    expect(bot2?.name).toBe("Protocol Research Synthesizer");
  });

  it("should return null for non-existent bot", async () => {
    const service = new FleetService();
    const st = await service.getBotStatus("invalid-bot");
    expect(st).toBeNull();
  });

  it("should return bot status structure with 0.000000 EGLD", async () => {
    const service = new FleetService({ walletsDir: "/tmp/non-existent-wallets" });
    const st = await service.getBotStatus("bot-shard0");

    expect(st).toBeDefined();
    expect(st?.id).toBe("bot-shard0");
    expect(st?.egldBalance).toBe("0.000000");
    expect(st?.usdcBalance).toBe(0);
  });
});
