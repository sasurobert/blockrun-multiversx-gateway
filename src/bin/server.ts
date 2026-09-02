import "dotenv/config";
import fs from "fs";
import http from "http";
import { MvxApiNetworkProvider } from "../domain/network.js";
import { RelayerPoolManager } from "../services/relayer_pool.js";
import { VerifierService } from "../services/verifier.js";
import { SettlerService } from "../services/settler.js";
import { SettlementQueue } from "../services/settlement_queue.js";
import { SqliteSettlementStorage } from "../storage/sqlite_storage.js";
import { MemorySettlementStorage } from "../storage/memory_storage.js";
import { ISettlementStorage } from "../storage/types.js";
import { createFacilitatorServer } from "../server/facilitator_server.js";
import { createBlockRunGateway } from "../gateway/blockrun_gateway.js";
import { Mnemonic } from "@multiversx/sdk-wallet";

/**
 * Starts the BlockRun MultiversX Gateway and x402 Facilitator services.
 */
export async function startServers() {
  const gatewayPort = parseInt(process.env.PORT || process.env.GATEWAY_PORT || "3000", 10);
  const facilitatorPort = parseInt(process.env.FACILITATOR_PORT || "3402", 10);
  const network = process.env.MULTIVERSX_NETWORK || "multiversx:1";
  const apiUrl = process.env.MULTIVERSX_API_URL || "https://api.multiversx.com";
  const usdcToken = process.env.USDC_TOKEN_IDENTIFIER || "USDC-c76f1f";
  const sqliteDbPath = process.env.SQLITE_DB_PATH;
  const rateLimitEnabled = process.env.RATE_LIMIT_ENABLED !== "false";

  console.log("=================================================");
  console.log(" Starting BlockRun MultiversX Gateway & Facilitator");
  console.log("=================================================");
  console.log(`Network:           ${network}`);
  console.log(`MultiversX API:    ${apiUrl}`);
  console.log(`USDC Token ID:     ${usdcToken}`);
  console.log(`Gateway Port:      ${gatewayPort}`);
  console.log(`Facilitator Port:  ${facilitatorPort}`);

  // 1. Initialize Network Provider
  const networkProvider = new MvxApiNetworkProvider(apiUrl, {
    timeout: 10000,
    clientName: "blockrun-multiversx-gateway",
  });

  // 2. Initialize Relayer Pool
  let relayerPool: RelayerPoolManager;
  if (process.env.RELAYER_MNEMONIC) {
    console.log("Initializing Relayer Pool from mnemonic...");
    relayerPool = RelayerPoolManager.fromMnemonic(process.env.RELAYER_MNEMONIC.trim());
  } else if (process.env.RELAYER_PEM) {
    console.log("Initializing Relayer Pool from PEM string...");
    relayerPool = RelayerPoolManager.fromPem(process.env.RELAYER_PEM.trim());
  } else if (process.env.RELAYER_PEM_PATH && fs.existsSync(process.env.RELAYER_PEM_PATH)) {
    console.log(`Initializing Relayer Pool from PEM file: ${process.env.RELAYER_PEM_PATH}...`);
    const pemContent = fs.readFileSync(process.env.RELAYER_PEM_PATH, "utf8");
    relayerPool = RelayerPoolManager.fromPem(pemContent);
  } else {
    console.warn("WARNING: No RELAYER_MNEMONIC or RELAYER_PEM provided. Generating ephemeral relayer key for dev/test mode.");
    const devMnemonic = Mnemonic.generate();
    relayerPool = RelayerPoolManager.fromMnemonic(devMnemonic.toString());
  }

  const relayerMap = relayerPool.getAllRelayerAddresses();
  console.log("Relayers initialized for shards:");
  for (const [shard, addr] of Object.entries(relayerMap)) {
    console.log(`  - Shard ${shard}: ${addr}`);
  }

  // 3. Initialize Merchant PayTo Address
  let merchantPayTo = process.env.MERCHANT_PAY_TO;
  if (!merchantPayTo) {
    const shard1Addr = relayerPool.hasShard(1) ? relayerPool.getRelayerAddressForShard(1) : undefined;
    const shard0Addr = relayerPool.hasShard(0) ? relayerPool.getRelayerAddressForShard(0) : undefined;
    merchantPayTo = shard1Addr || shard0Addr || Object.values(relayerMap)[0];
    console.warn(`WARNING: No MERCHANT_PAY_TO provided. Defaulting to relayer address: ${merchantPayTo}`);
  }

  // 4. Initialize Settlement Storage
  let storage: ISettlementStorage;
  if (sqliteDbPath && sqliteDbPath !== ":memory:") {
    console.log(`Initializing SQLite settlement storage at: ${sqliteDbPath}`);
    storage = new SqliteSettlementStorage(sqliteDbPath);
  } else {
    console.log("Initializing In-Memory settlement storage");
    storage = new MemorySettlementStorage();
  }

  // 5. Initialize Services
  const verifier = new VerifierService({
    relayerPool,
    networkProvider,
  });

  const settler = new SettlerService({
    storage,
    networkProvider,
    relayerPool,
    verifier,
  });

  const settlementQueue = new SettlementQueue({
    settler,
    relayerPool,
  });

  // 6. Create Express Apps
  const facilitatorApp = createFacilitatorServer({
    verifier,
    settlementQueue,
    relayerPool,
    supportedNetworks: [network],
    rateLimit: { enabled: rateLimitEnabled },
  });

  const gatewayApp = createBlockRunGateway({
    verifier,
    settlementQueue,
    relayerPool,
    payTo: merchantPayTo,
    network,
    asset: usdcToken,
    rateLimit: { enabled: rateLimitEnabled },
  });

  // 7. Start HTTP Servers
  const facilitatorServer = http.createServer(facilitatorApp);
  const gatewayServer = http.createServer(gatewayApp);

  const startFacilitator = new Promise<void>((resolve) => {
    facilitatorServer.listen(facilitatorPort, () => {
      console.log(`x402 Facilitator listening at http://localhost:${facilitatorPort}`);
      console.log(`OpenAPI documentation at http://localhost:${facilitatorPort}/openapi.json`);
      resolve();
    });
  });

  const startGateway = new Promise<void>((resolve) => {
    gatewayServer.listen(gatewayPort, () => {
      console.log(`BlockRun AI Gateway listening at http://localhost:${gatewayPort}`);
      console.log(`OpenAI API endpoint: http://localhost:${gatewayPort}/api/v1/chat/completions`);
      console.log(`Anthropic API endpoint: http://localhost:${gatewayPort}/api/v1/messages`);
      resolve();
    });
  });

  await Promise.all([startFacilitator, startGateway]);
  console.log("All servers started successfully.\n");

  // 8. Graceful Shutdown Handlers
  const shutdown = async () => {
    console.log("\nShutting down gracefully...");
    await settlementQueue.drain();
    settlementQueue.clear();
    await new Promise<void>((resolve) => facilitatorServer.close(() => resolve()));
    await new Promise<void>((resolve) => gatewayServer.close(() => resolve()));
    storage.close();
    console.log("Shutdown complete.");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return {
    facilitatorServer,
    gatewayServer,
    settlementQueue,
    storage,
  };
}

// Auto-run if executed directly as CLI
if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("src/bin/server.ts") ||
  process.argv[1]?.endsWith("dist/bin/server.js")
) {
  startServers().catch((err) => {
    console.error("Fatal server error:", err);
    process.exit(1);
  });
}
