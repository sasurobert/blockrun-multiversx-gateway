# BlockRun MultiversX Python Client SDK

Autonomous AI Agent Client SDK for interacting with the BlockRun AI Gateway using high-speed MultiversX x402 gasless micro-payments.

## Quickstart

```python
from blockrun_mvx import setup_agent_wallet

# Initialize agent client from MultiversX wallet PEM
client = setup_agent_wallet(
    pem_path="./wallet.pem",
    gateway_url="https://api.blockrun.ai",
    network="multiversx:1",
    max_cost_per_call=0.05,  # $0.05 safety cap per request
)

# 1. Standard OpenAI-compatible call
response = client.chat(
    model="openai/gpt-5.4",
    messages=[{"role": "user", "content": "Explain sharding in distributed systems"}],
)
print(response["choices"][0]["message"]["content"])
print("Payment receipt tx:", response["paymentReceipt"])

# 2. Anthropic-compatible call
response = client.messages(
    model="anthropic/claude-sonnet-4.6",
    messages=[{"role": "user", "content": "Write a concise summary"}],
)

# 3. Smart routing (auto selects DeepSeek vs GPT-5 based on complexity)
smart_res = client.smart_chat(
    "What is the capital of France?",
    profile="auto"
)
print("Routed model:", smart_res["routing"]["selectedModel"])
print("Savings:", smart_res["routing"]["estimatedSavings"])
```
