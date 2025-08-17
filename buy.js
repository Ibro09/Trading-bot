const axios = require("axios");
const { Connection, Keypair, VersionedTransaction } = require("@solana/web3.js");

const RPC_URL = "https://api.mainnet-beta.solana.com"; // Replace with your own RPC for higher limits
const connection = new Connection(RPC_URL, "confirmed");

const inputMint = "So11111111111111111111111111111111111111112"; // wSOL
const outputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC
const slippageBps = 50; // 0.5%

// 25 wallets (example hex private keys — replace with yours)
const privateKeysHex = [
];

function hexToKeypair(hex) {
  return Keypair.fromSecretKey(Uint8Array.from(Buffer.from(hex, "hex")));
}
const wallets = privateKeysHex.map(hexToKeypair);

async function getBalanceLamports(pubkey) {
  return await connection.getBalance(pubkey);
}

async function swapForWallet(wallet, quote) {
  try {
    const swapPayload = {
      userPublicKey: wallet.publicKey.toBase58(),
      quoteResponse: quote,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: { maxLamports: 10000000, priorityLevel: "veryHigh" }
      },
      dynamicComputeUnitLimit: true
    };

    const { data: swapResponse } = await axios.post(
      "https://lite-api.jup.ag/swap/v1/swap",
      swapPayload,
      { headers: { "Content-Type": "application/json", Accept: "application/json" } }
    );

    const txBuffer = Buffer.from(swapResponse.swapTransaction, "base64");
    const transaction = VersionedTransaction.deserialize(txBuffer);

    transaction.sign([wallet]);

    const sig = await connection.sendTransaction(transaction);
    console.log(`✅ Swap sent for ${wallet.publicKey.toBase58()}: https://solscan.io/tx/${sig}`);
  } catch (err) {
    console.error(`❌ Error swapping for ${wallet.publicKey.toBase58()}:`, err.response?.data || err.message);
  }
}

async function main() {
  const firstWalletBalance = await getBalanceLamports(wallets[0].publicKey);
  console.log("First wallet balance (lamports):", firstWalletBalance);

  const swapAmount = Math.floor(firstWalletBalance * 0.8);
  console.log("Swap amount (lamports):", swapAmount);

  const { data: quote } = await axios.get("https://lite-api.jup.ag/swap/v1/quote", {
    params: { inputMint, outputMint, amount: swapAmount, slippageBps },
    headers: { Accept: "application/json" }
  });

  // Process in batches of 5
  for (let i = 0; i < wallets.length; i += 5) {
    const batch = wallets.slice(i, i + 5);
    console.log(`🚀 Sending batch ${i / 5 + 1} of ${Math.ceil(wallets.length / 5)}`);
    await Promise.all(batch.map(wallet => swapForWallet(wallet, quote)));

    // Delay between batches (500ms to avoid rate limit)
    await new Promise(res => setTimeout(res, 500));
  }
}

main().catch(console.error);
