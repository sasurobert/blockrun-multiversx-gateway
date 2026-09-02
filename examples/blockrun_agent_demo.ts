/**
 * BlockRun AI + MultiversX x402 v2 Autonomous Agent Demo
 *
 * Demonstrates:
 * 1. Autonomous HTTP 402 challenge negotiation.
 * 2. Gasless Relayed V3 USDC micropayments (0 EGLD gas needed by agent).
 * 3. Multi-shard relayer execution and instant settlement receipts.
 * 4. OpenAI & Anthropic API completions with per-request spot billing.
 * 5. Smart routing with model optimization and cost savings.
 *
 * Usage:
 *   npm run example
 *   or: npx tsx examples/blockrun_agent_demo.ts
 */

import http from "http";
import { Address, Transaction, TransactionComputer } from "@multiversx/sdk-core";
import { Mnemonic, UserSigner } from "@multiversx/sdk-wallet";
import { BlockRunMvxClient } from "../src/client/blockrun_mvx_client.js";
import { INetworkProvider, ISimulationResult } from "../src/domain/network.js";
import { RelayerPoolManager } from "../src/services/relayer_pool.js";
import { VerifierService } from "../src/services/verifier.js";
import { SettlerService } from "../src/services/settler.js";
import { SettlementQueue } from "../src/services/settlement_queue.js";
import { MemorySettlementStorage } from "../src/storage/memory_storage.js";
import { createBlockRunGateway } from "../src/gateway/blockrun_gateway.js";

function printBanner() {
  console.log("\n================================================================================");
  console.log("   🚀 BLOCKRUN AI + MULTIVERSX x402 v2 AUTONOMOUS AGENT PAYMENT DEMO 🚀");
  console.log("================================================================================\n");
}

function printSection(title: string) {
  console.log(`\n--------------------------------------------------------------------------------`);
  console.log(`  🔹 ${title}`);
  console.log(`--------------------------------------------------------------------------------`);
}

async function main() {
  printBanner();

  console.log("🔧 [1/4] Bootstrapping Multi-Shard Relayer Pool & Merchant Gateway...");

  // 1. Merchant Wallet (Receiver of USDC micropayments)
  const merchantMnemonic = Mnemonic.generate();
  const merchantSigner = new UserSigner(merchantMnemonic.deriveKey(0));
  const merchantAddress = Address.newFromBech32(merchantSigner.getAddress().bech32());
  console.log(`   Merchant Pay-To Address: ${merchantAddress.toBech32()}`);

  // 2. Multi-Shard Relayer Pool (Covers EGLD gas for all agent shards)
  const relayerMnemonic = Mnemonic.generate();
  const relayerPool = RelayerPoolManager.fromMnemonic(relayerMnemonic.toString(), {
    maxScanIndex: 200,
  });

  console.log("   Configured Relayers:");
  for (const shard of [0, 1, 2]) {
    try {
      const relayer = relayerPool.getRelayerForShard(shard);
      console.log(`     - Shard ${shard}: ${relayer.getAddress().bech32()}`);
    } catch {
      // Shard relayer not derived yet
    }
  }

  // 3. Mock High-Throughput Blockchain Network Provider
  let onChainTxCounter = 0;
  const mockNetworkProvider: INetworkProvider = {
    simulateTransaction: async (): Promise<ISimulationResult> => ({
      status: "success",
      returnCode: "ok",
    }),
    sendTransaction: async (_tx: Transaction): Promise<string> => {
      onChainTxCounter++;
      const randomHash = Buffer.from(
        Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))
      ).toString("hex");
      return randomHash;
    },
    getTransaction: async () => ({ status: "success" }),
    getAccount: async () => ({ nonce: 1, balance: "5000000000000000000" }),
  };

  const storage = new MemorySettlementStorage();
  const verifier = new VerifierService({
    relayerPool,
    networkProvider: mockNetworkProvider,
  });
  const settler = new SettlerService({
    storage,
    networkProvider: mockNetworkProvider,
    relayerPool,
    verifier,
  });
  const settlementQueue = new SettlementQueue({
    settler,
    relayerPool,
    maxRetries: 2,
    baseDelayMs: 5,
  });

  // 4. Start BlockRun AI Gateway Proxy on local ephemeral port
  const gatewayApp = createBlockRunGateway({
    verifier,
    settlementQueue,
    relayerPool,
    payTo: merchantAddress.toBech32(),
    network: "multiversx:1",
    asset: "USDC-c76f1f",
    rateLimit: { enabled: false },
  });

  let server!: http.Server;
  await new Promise<void>((resolve) => {
    server = gatewayApp.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as any).port;
  const gatewayUrl = `http://127.0.0.1:${port}`;
  console.log(`   Gateway online: ${gatewayUrl}`);

  // 5. Initialize Autonomous AI Agent Client
  console.log("\n🤖 [2/4] Initializing Autonomous AI Agent Client Wallet...");
  const agentMnemonic = Mnemonic.generate();
  const agentClient = new BlockRunMvxClient({
    mnemonic: agentMnemonic.toString(),
    gatewayUrl,
    network: "multiversx:1",
    tokenIdentifier: "USDC-c76f1f",
    maxCostPerCall: 0.10, // $0.10 max budget per call
    maxSessionCost: 2.00, // $2.00 max session spend limit
    verbose: false,
  });

  console.log(`   Agent Address: ${agentClient.getWalletAddress()}`);
  console.log(`   Spend Limits: Max $0.10/call, Max $2.00/session`);
  console.log(`   Gas Balance Required: 0 EGLD (Relayed V3 Gasless Mode active)`);

  // --- DEMO 1: OpenAI Chat Completion (openai/gpt-5.4) ---
  printSection("DEMO 1: OpenAI-Compatible Chat Completion (openai/gpt-5.4)");
  console.log("➡️  Sending unpaid request to /api/v1/chat/completions...");
  console.log("⚡ Autonomous 402 challenge flow initiated:");

  const startTime1 = Date.now();
  const response1 = await agentClient.chat("openai/gpt-5.4", [
    { role: "system", content: "You are a cutting-edge autonomous AI agent on MultiversX." },
    { role: "user", content: "Explain the benefit of paying per request with x402 micro-USDC." },
  ]);
  const duration1 = Date.now() - startTime1;

  console.log(`✅ Completion Received in ${duration1}ms:`);
  console.log(`   Model: ${response1.model}`);
  console.log(`   Tokens: ${response1.usage.prompt_tokens} prompt + ${response1.usage.completion_tokens} completion = ${response1.usage.total_tokens} total`);
  console.log(`   AI Output: "${response1.choices[0].message.content}"`);
  console.log(`   🧾 On-Chain Settlement TX: ${response1.paymentReceipt}`);
  console.log(`   💰 Session Total Spend: $${agentClient.getSessionSpend().toFixed(6)} USD`);

  // --- DEMO 2: Anthropic Messages Completion (anthropic/claude-sonnet-4.6) ---
  printSection("DEMO 2: Anthropic-Compatible Messages Completion (anthropic/claude-sonnet-4.6)");
  console.log("➡️  Sending request to /api/v1/messages...");

  const startTime2 = Date.now();
  const response2 = await agentClient.messages("anthropic/claude-sonnet-4.6", [
    { role: "user", content: "What makes MultiversX Relayed V3 ideal for high-frequency AI agents?" },
  ]);
  const duration2 = Date.now() - startTime2;

  console.log(`✅ Completion Received in ${duration2}ms:`);
  console.log(`   Model: ${response2.model}`);
  console.log(`   Tokens: ${response2.usage.input_tokens} input + ${response2.usage.output_tokens} output`);
  console.log(`   AI Output: "${response2.content[0].text}"`);
  console.log(`   🧾 On-Chain Settlement TX: ${response2.paymentReceipt}`);
  console.log(`   💰 Session Total Spend: $${agentClient.getSessionSpend().toFixed(6)} USD`);

  // --- DEMO 3: Smart Chat Routing with Cost Optimization ---
  printSection("DEMO 3: Intelligent Smart Chat Routing (Eco / Auto Cost Optimizer)");
  console.log("➡️  Running agent.smartChat() with auto cost routing profile...");

  const startTime3 = Date.now();
  const response3 = await agentClient.smartChat(
    "Calculate the square root of 65536 and verify with 256 * 256.",
    "auto"
  );
  const duration3 = Date.now() - startTime3;

  console.log(`✅ Completion Received in ${duration3}ms:`);
  console.log(`   Selected Model: ${response3.model} (Tier: ${response3.routing.tier})`);
  console.log(`   Cost Savings: ${response3.routing.savings} vs top-tier flagship model!`);
  console.log(`   AI Output: "${response3.choices[0].message.content}"`);
  console.log(`   🧾 On-Chain Settlement TX: ${response3.paymentReceipt}`);
  console.log(`   💰 Final Session Total Spend: $${agentClient.getSessionSpend().toFixed(6)} USD`);

  // Teardown
  server.close();

  console.log("\n================================================================================");
  console.log("   🎉 ALL BLOCKRUN MULTIVERSX x402 INTEGRATION DEMOS COMPLETED SUCCESSFULLY! 🎉");
  console.log("================================================================================\n");
}

main().catch((err) => {
  console.error("❌ Error running BlockRun demo:", err);
  process.exit(1);
});
