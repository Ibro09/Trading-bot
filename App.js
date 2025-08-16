const fetch = require("node-fetch");
const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const bs58 = require("bs58");
const axios = require("axios");
// Replace with your real Telegram bot token
const token = process.env.BOT_TOKEN;
require("dotenv").config();
const solanaWeb3 = require("@solana/web3.js");
const connection = new solanaWeb3.Connection(
  solanaWeb3.clusterApiUrl("mainnet-beta"),
  "confirmed"
);
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => res.send("Bot is alive"));
app.listen(PORT, () => console.log(`Listening on ${PORT}`));

const {
  VersionedTransaction,
  VersionedMessage,
  Transaction,
  Keypair,
  PublicKey,
  Connection,
} = solanaWeb3;

// Polling mode
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// Replace with your MongoDB URI
const MONGODB_URI = process.env.MONGODB_URI;
// Connect to MongoDB
mongoose
  .connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => {
    console.log("✅ MongoDB connected");
  })
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err);
  });

// Wallet schema
const panelSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  privateKey: { type: String, required: true, unique: true },
  address: { type: String, required: true, unique: true },
  wallets: [
    {
      privateKey: { type: String, required: true },
      address: { type: String, required: true },
    },
  ],
});
const Panel = mongoose.model("Panel", panelSchema);
bot.onText(/^\/start$/, async (msg) => {
  const userId = msg.from.id.toString();

  // Check if panel already exists
  let panel = await Panel.findOne({ userId });

  if (!panel) {
    const allWallets = [];

    // Create 11 wallets
    for (let i = 0; i < 26; i++) {
      const keypair = solanaWeb3.Keypair.generate();
      allWallets.push({
        address: keypair.publicKey.toBase58(),
        privateKey: Buffer.from(keypair.secretKey).toString("hex"),
      });
    }

    // Use the first one as the main wallet, rest as the array
    const mainWallet = allWallets[0];
    const extraWallets = allWallets.slice(1); // wallets[1] to wallets[10]

    // Save to DB
    panel = new Panel({
      userId,
      address: mainWallet.address,
      privateKey: mainWallet.privateKey,
      wallets: extraWallets,
    });

    await panel.save();
  }

  const helpMessage = `
👋 *Welcome, ${msg.from.first_name || "User"}!*

🔐 *Your main wallet info:*  
📬 *Address:* \`${panel.address}\`  
🔑 *Private Key:* \`${panel.privateKey}\`

Keep your private keys safe and secure.

Here’s all you can do with this bot: 

💸 /split – Evenly split the funds in the panel across 25 wallets  
📊 /panel – View and share panel information, including wallet details  
🛒 /buy <tokenaddress> – Instantly buy a token using all 25 connected wallets  
🛒 /sell <tokenaddress> – Instantly sell a token using all 25 connected wallets  
🗑️ /delete – Remove all wallets and reset your panel configuration  

Let’s start trading! 🚀
`;

  bot.sendMessage(msg.chat.id, helpMessage, { parse_mode: "Markdown" });
});

bot.onText(/^\/split$/, async (msg) => {
  const userId = msg.from.id.toString();
  const chatId = msg.chat.id;

  try {
    const panel = await Panel.findOne({ userId });
    if (!panel) {
      return bot.sendMessage(
        chatId,
        "❌ No panel found. Please use /start to set up your panel."
      );
    }

    await bot.sendMessage(
      chatId,
      "🔄 Splitting funds to 25 wallets in one (or fallback) transactions... Please wait..."
    );

    const mainKeypair = solanaWeb3.Keypair.fromSecretKey(
      Buffer.from(panel.privateKey, "hex")
    );
    const mainPublicKey = mainKeypair.publicKey;

    const balance = await connection.getBalance(mainPublicKey);
    if (balance === 0) {
      return bot.sendMessage(
        chatId,
        "💸 Main wallet has no SOL. Please deposit SOL."
      );
    }

    // MUST be exactly 25 wallets
    const walletsToUse = panel.wallets.slice(0, 25);
    if (walletsToUse.length < 25) {
      return bot.sendMessage(
        chatId,
        "❌ You must have at least 25 wallets in your panel."
      );
    }

    // Validate addresses
    const validWallets = [];
    for (const w of walletsToUse) {
      try {
        new solanaWeb3.PublicKey(w.address);
        validWallets.push(w);
      } catch (err) {
        await bot.sendMessage(
          chatId,
          `❌ Invalid wallet address: ${w.address}`
        );
      }
    }
    if (validWallets.length < 25) {
      return bot.sendMessage(
        chatId,
        "❌ Some wallet addresses are invalid. Please fix them."
      );
    }

    // --- Fee estimation (build a minimal tx, set blockhash & feePayer, then compileMessage) ---
    const feeSampleTx = new solanaWeb3.Transaction();
    feeSampleTx.add(
      solanaWeb3.SystemProgram.transfer({
        fromPubkey: mainPublicKey,
        toPubkey: new solanaWeb3.PublicKey(validWallets[0].address),
        lamports: 1,
      })
    );
    const { blockhash: feeBlockhash } = await connection.getLatestBlockhash(
      "confirmed"
    );
    feeSampleTx.recentBlockhash = feeBlockhash;
    feeSampleTx.feePayer = mainPublicKey;
    const feeForOneResp = await connection.getFeeForMessage(
      feeSampleTx.compileMessage()
    );
    const feeForOne =
      feeForOneResp && feeForOneResp.value ? feeForOneResp.value : 5000;
    const feeBuffer = Math.ceil(feeForOne * 0.2);
    const rentExemptLamports =
      await connection.getMinimumBalanceForRentExemption(0);

    // amount available for distribution
    const totalFeesEstimate = feeForOne * 2;
    const distributable =
      balance - totalFeesEstimate - feeBuffer - rentExemptLamports * 30;
    const amountToSend = Math.floor(distributable / 25);

    if (amountToSend <= 0) {
      return bot.sendMessage(
        chatId,
        `❌ Not enough SOL to split to 25 wallets.\nAvailable: ${(
          balance / solanaWeb3.LAMPORTS_PER_SOL
        ).toFixed(6)} SOL\nNeed more to cover fees.`
      );
    }

    await bot.sendMessage(
      chatId,
      `🔎 Distributing ${(
        (amountToSend * 25) /
        solanaWeb3.LAMPORTS_PER_SOL
      ).toFixed(6)} SOL total — ${(
        amountToSend / solanaWeb3.LAMPORTS_PER_SOL
      ).toFixed(6)} SOL each. Reserves: ${
        (totalFeesEstimate + feeBuffer) / solanaWeb3.LAMPORTS_PER_SOL
      } SOL for fees.`
    );

    // Helper: attempt to send a transaction with retries (refresh blockhash up to tries)
    async function sendWithRetries(tx, signers = [mainKeypair], tries = 3) {
      for (let attempt = 1; attempt <= tries; attempt++) {
        try {
          // refresh blockhash each attempt
          const { blockhash } = await connection.getLatestBlockhash(
            "confirmed"
          );
          tx.recentBlockhash = blockhash;
          tx.feePayer = mainPublicKey;
          // Use sendAndConfirmTransaction which signs with provided signers
          const sig = await solanaWeb3.sendAndConfirmTransaction(
            connection,
            tx,
            signers,
            { commitment: "confirmed", skipPreflight: false }
          );
          return { success: true, sig };
        } catch (err) {
          // if last attempt, return error
          const message = err && err.message ? err.message : String(err);
          // If it's a size error, bubble up specially
          if (
            message.toLowerCase().includes("transaction too large") ||
            message.toLowerCase().includes("exceeds maximum")
          ) {
            return { success: false, error: new Error("TX_TOO_LARGE") };
          }
          if (attempt === tries) {
            return { success: false, error: err };
          }
          // otherwise retry after short delay
          await new Promise((r) => setTimeout(r, 400 + attempt * 200));
        }
      }
      return { success: false, error: new Error("unknown") };
    }

    // Build single tx with 25 transfer instructions
    const buildTxForWallets = (walletsArray) => {
      const tx = new solanaWeb3.Transaction();
      for (const w of walletsArray) {
        tx.add(
          solanaWeb3.SystemProgram.transfer({
            fromPubkey: mainPublicKey,
            toPubkey: new solanaWeb3.PublicKey(w.address),
            lamports: amountToSend,
          })
        );
      }
      return tx;
    };

    // First try: single tx containing 25 transfers
    let tx = buildTxForWallets(validWallets);
    let res = await sendWithRetries(tx, [mainKeypair], 3);

    // If transaction too large, fall back to 2 transactions (13 + 12)
    if (!res.success && res.error && res.error.message === "TX_TOO_LARGE") {
      await bot.sendMessage(
        chatId,
        "⚠️ Single transaction too large. Falling back to two transactions (13 + 12)."
      );

      const firstSlice = validWallets.slice(0, 13);
      const secondSlice = validWallets.slice(13);

      const tx1 = buildTxForWallets(firstSlice);
      const tx2 = buildTxForWallets(secondSlice);

      const r1 = await sendWithRetries(tx1, [mainKeypair], 3);
      if (!r1.success) {
        await bot.sendMessage(
          chatId,
          `❌ First fallback transaction failed: ${
            r1.error && r1.error.message ? r1.error.message : String(r1.error)
          }`
        );
      } else {
        await bot.sendMessage(
          chatId,
          `✅ First fallback tx confirmed: https://solscan.io/tx/${r1.sig}`
        );
      }

      const r2 = await sendWithRetries(tx2, [mainKeypair], 3);
      if (!r2.success) {
        await bot.sendMessage(
          chatId,
          `❌ Second fallback transaction failed: ${
            r2.error && r2.error.message ? r2.error.message : String(r2.error)
          }`
        );
      } else {
        await bot.sendMessage(
          chatId,
          `✅ Second fallback tx confirmed: https://solscan.io/tx/${r2.sig}`
        );
      }

      // final status
      const finalBalance = await connection.getBalance(mainPublicKey);
      return bot.sendMessage(
        chatId,
        `🔚 Done (fallback). Remaining balance: ${(
          finalBalance / solanaWeb3.LAMPORTS_PER_SOL
        ).toFixed(6)} SOL`
      );
    }

    // If single tx succeeded
    if (res.success) {
      await bot.sendMessage(
        chatId,
        `✅ Split complete!\n🔗 https://solscan.io/tx/${res.sig}`
      );
      const finalBalance = await connection.getBalance(mainPublicKey);
      return bot.sendMessage(
        chatId,
        `Remaining balance: ${(
          finalBalance / solanaWeb3.LAMPORTS_PER_SOL
        ).toFixed(6)} SOL`
      );
    } else {
      // generic failure
      await bot.sendMessage(
        chatId,
        `❌ Split failed: ${
          res.error && res.error.message ? res.error.message : String(res.error)
        }`
      );
    }
  } catch (err) {
    console.error("Split error:", err);
    await bot.sendMessage(
      msg.chat.id,
      `❌ Unexpected error: ${err && err.message ? err.message : String(err)}`
    );
  }
});

bot.onText(/^\/panel$/, async (msg) => {
  const userId = msg.from.id.toString();
  const chatId = msg.chat.id;

  const panel = await Panel.findOne({ userId });

  if (!panel) {
    return bot.sendMessage(
      chatId,
      "❌ No panel found. Use /start to create your wallets."
    );
  }

  // 1. Main wallet info (Message 1)
  const mainWalletMsg =
    `🔐 *Main Wallet*\n` +
    `📬 Address: \`${panel.address}\`\n` +
    `🔑 Private Key: \`${panel.privateKey}\``;
  await bot.sendMessage(chatId, mainWalletMsg, { parse_mode: "Markdown" });

  // 2. Secondary wallets info (Messages 2-9, 5 wallets per message)
  if (panel.wallets && panel.wallets.length > 0) {
    const batchSize = Math.ceil(panel.wallets.length / 8); // Split into 8 batches
    for (let batch = 0; batch < 8; batch++) {
      let secondaryMsg = `🧩 *Secondary Wallets Batch ${batch + 1}*`;
      const start = batch * batchSize;
      const end = Math.min(start + batchSize, panel.wallets.length);
      for (let i = start; i < end; i++) {
        const wallet = panel.wallets[i];
        secondaryMsg += `\n\n${i + 1}. 📬 \`${
          wallet.address
        }\`\n🔑 Private Key: \`${wallet.privateKey}\``;
      }
      await bot.sendMessage(chatId, secondaryMsg, { parse_mode: "Markdown" });
    }
  } else {
    await bot.sendMessage(chatId, "No secondary wallets found.", {
      parse_mode: "Markdown",
    });
  }

  // 3. Summary message (Message 10)
  await bot.sendMessage(
    chatId,
    "📊 Panel info sent above. Keep your private keys safe!",
    { parse_mode: "Markdown" }
  );
});

bot.onText(/^\/buy\s+(.+)$/, async (msg, match) => {
  const userId = msg.from.id.toString();
  const chatId = msg.chat.id;

  const panel = await Panel.findOne({ userId });
  if (!panel) {
    return bot.sendMessage(
      chatId,
      "❌ No panel found. Please use /start to set up your panel."
    );
  }

  const {
    Connection,
    Keypair,
    VersionedTransaction,
  } = require("@solana/web3.js");
  const axios = require("axios");

  const RPC_URL = "https://api.mainnet-beta.solana.com";
  const connection = new Connection(RPC_URL, "confirmed");

  const inputMint = "So11111111111111111111111111111111111111112"; // wSOL
  const outputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC
  const slippageBps = 50;


  function hexToKeypair(hex) {
    return Keypair.fromSecretKey(Uint8Array.from(Buffer.from(hex, "hex")));
  }
    const wallets = panel.wallets
      .slice(0, 25)
      .map((w) =>
        solanaWeb3.Keypair.fromSecretKey(Buffer.from(w.privateKey, "hex"))
      );
  async function getBalanceLamports(pubkey) {
    return await connection.getBalance(pubkey);
  }

  async function swapForWallet(wallet, quote) {
    try {
      const swapPayload = {
        userPublicKey: wallet.publicKey.toBase58(),
        quoteResponse: quote,
        prioritizationFeeLamports: {
          priorityLevelWithMaxLamports: {
            maxLamports: 10000000,
            priorityLevel: "veryHigh",
          },
        },
        dynamicComputeUnitLimit: true,
      };

      const { data: swapResponse } = await axios.post(
        "https://lite-api.jup.ag/swap/v1/swap",
        swapPayload,
        {
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
        }
      );

      const txBuffer = Buffer.from(swapResponse.swapTransaction, "base64");
      const transaction = VersionedTransaction.deserialize(txBuffer);

      transaction.sign([wallet]);

      const sig = await connection.sendTransaction(transaction);
      return { success: true, sig };
    } catch (err) {
      return {
        success: false,
        error: err.response?.data?.error || err.message || "Unknown error",
      };
    }
  }

  async function main() {
    const firstWalletBalance = await getBalanceLamports(wallets[0].publicKey);
    // const firstWalletBalance = Math.floor(0.005196678 * LAMPORTS_PER_SOL);
    if (firstWalletBalance <= 0) {
      await bot.sendMessage(
        chatId,
        "❌ First wallet has no balance. Cannot proceed."
      );
      return;
    }

    const swapAmount = Math.floor(firstWalletBalance * 0.85);

    let quote;
    try {
      const { data } = await axios.get(
        "https://lite-api.jup.ag/swap/v1/quote",
        {
          params: { inputMint, outputMint, amount: swapAmount, slippageBps },
          headers: { Accept: "application/json" },
        }
      );
      quote = data;
    } catch (err) {
      await bot.sendMessage(
        chatId,
        `❌ Failed to get swap quote: ${err.message}`
      );
      return;
    }

    let successCount = 0;
    let failCount = 0;

    // Process in batches of 5
    for (let i = 0; i < wallets.length; i += 5) {
      const batch = wallets.slice(i, i + 5);
      await bot.sendMessage(
        chatId,
        `🚀 Sending batch ${i / 5 + 1} of ${Math.ceil(wallets.length / 5)}...`
      );

      const results = await Promise.all(
        batch.map((wallet) => swapForWallet(wallet, quote))
      );

      for (let j = 0; j < results.length; j++) {
        const res = results[j];
        const wallet = batch[j];

        if (res.success) {
          successCount++;
          await bot.sendMessage(
            chatId,
            `✅ ${wallet.publicKey.toBase58()} swapped: https://solscan.io/tx/${
              res.sig
            }`
          );
        } else {
          failCount++;
          await bot.sendMessage(
            chatId,
            `❌ ${wallet.publicKey.toBase58()} failed: ${res.error}`
          );
        }
      }

      // Delay to avoid rate limits
      await new Promise((res) => setTimeout(res, 500));
    }

    await bot.sendMessage(
      chatId,
      `🛒 Buy complete!\n✅ Success: ${successCount}\n❌ Failed: ${failCount}`
    );
  }

  main().catch(async (err) => {
    console.error(err);
    await bot.sendMessage(chatId, `❌ Unexpected error: ${err.message}`);
  });
});

bot.onText(/^\/sell(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const tokenAddress = match[1] ? match[1].trim() : null;

  if (!tokenAddress) {
    return bot.sendMessage(
      chatId,
      "❌ Please provide the token address to sell. Example:\n`/sell <tokenaddress>`",
      { parse_mode: "Markdown" }
    );
  }

  try {
    new solanaWeb3.PublicKey(tokenAddress);
  } catch (err) {
    return bot.sendMessage(
      chatId,
      "❌ Invalid token address. Please provide a valid Solana token address."
    );
  }
  bot.sendMessage(chatId, `How much of this token do you want to sell?`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "50%", callback_data: `sell_50|${tokenAddress}` }],
        [{ text: "100%", callback_data: `sell_100|${tokenAddress}` }],
      ],
    },
  });
});

bot.onText(/^\/withdraw$/, async (msg) => {
  const userId = msg.from.id.toString();
  const chatId = msg.chat.id;

  const panel = await Panel.findOne({ userId });
  if (!panel) {
    return bot.sendMessage(
      chatId,
      "❌ No panel found. Please use /start to set up your panel."
    );
  }
  await bot.sendMessage(chatId, "🔄 Processing withdrawals... Please wait...");
  const mainAddress = panel.address;
  const mainPubkey = new solanaWeb3.PublicKey(mainAddress);

  // Only withdraw from the first 25 wallets
  const wallets = panel.wallets.slice(0, 25);


  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < wallets.length; i++) {
    const walletInfo = wallets[i];
    const keypair = solanaWeb3.Keypair.fromSecretKey(
      Buffer.from(walletInfo.privateKey, "hex")
    );
    // const keypair = solanaWeb3.Keypair.fromSecretKey(
    //   Buffer.from(walletInfo, "hex")
    // );
    const pubkey = keypair.publicKey;

    try {
      const balance = await connection.getBalance(pubkey);
      const rentExempt = await connection.getMinimumBalanceForRentExemption(0);
      const feeBuffer = 15000;
      const amount = Math.floor(balance * 0.8) - rentExempt - feeBuffer;

      if (amount <= 0) {
        await bot.sendMessage(
          chatId,
          `❌ Wallet ${i + 1} (${
            walletInfo.address
          }) has insufficient SOL to withdraw.`
        );
        failCount++;
        continue;
      }

      const tx = new solanaWeb3.Transaction().add(
        solanaWeb3.SystemProgram.transfer({
          fromPubkey: pubkey,
          toPubkey: mainPubkey,
          lamports: amount,
        })
      );

      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = pubkey;

      tx.sign(keypair);

      const sig = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
      });
      await connection.confirmTransaction(sig, "finalized");

      await bot.sendMessage(
        chatId,
        `✅ Wallet ${i + 1} (${walletInfo.address}) withdrew ${(
          amount / solanaWeb3.LAMPORTS_PER_SOL
        ).toFixed(6)} SOL to main wallet.\n🔗 https://solscan.io/tx/${sig}`
      );
      successCount++;
    } catch (err) {
      await bot.sendMessage(
        chatId,
        `❌ Wallet ${i + 1} (${walletInfo.address}) failed to withdraw: ${
          err.message
        }`
      );
      failCount++;
    }
  }

  await bot.sendMessage(
    chatId,
    `🏦 Withdraw complete!\n✅ Success: ${successCount}\n❌ Failed: ${failCount}`
  );
});

// /delete command
bot.onText(/^\/delete$/, (msg) => {
  const chatId = msg.chat.id;

  const confirmMessage = `⚠️ Are you sure you want to delete your panel and all associated wallets? This action cannot be undone.`;

  const options = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Yes, delete", callback_data: "confirm_delete" },
          { text: "❌ No, cancel", callback_data: "cancel_delete" },
        ],
      ],
    },
  };

  bot.sendMessage(chatId, confirmMessage, options);
});

const HELIUS_RPC = process.env.HELIUS_RPC 

bot.on("callback_query", async (query) => {
  const connection = new solanaWeb3.Connection(HELIUS_RPC, "confirmed");

  const data = query.data;
  const chatId = query.message.chat.id;
  const userId = query.from.id.toString();

  const [action, tokenAddress] = data.split("|");

  console.log("Action:", action); // sell_50 or sell_100
  console.log("Token Address:", tokenAddress); // The mint address

  if (data.includes("sell_")) {
    const panel = await Panel.findOne({ userId });
    if (!panel) {
      return bot.sendMessage(
        chatId,
        "❌ No panel found. Please use /start to set up your panel."
      );
    }

    const inputMint = tokenAddress; // USDC
    const outputMint = "So11111111111111111111111111111111111111112"; // wSOL
    const slippageBps = 50;

    const wallets = panel.wallets
      .slice(0, 25)
      .map((w) =>
        solanaWeb3.Keypair.fromSecretKey(Buffer.from(w.privateKey, "hex"))
      );

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < wallets.length; i += 5) {
      const batch = wallets.slice(i, i + 5);

      await bot.sendMessage(
        chatId,
        `🚀 Sending batch ${Math.floor(i / 5) + 1} of ${Math.ceil(
          wallets.length / 5
        )}...`
      );

      const results = await Promise.all(
        batch.map(async (wallet) => {
          try {
            const tokenAccounts = await connection.getTokenAccountsByOwner(
              wallet.publicKey,
              {
                mint: new solanaWeb3.PublicKey(inputMint),
              }
            );

            if (tokenAccounts.value.length === 0) {
              return { success: false, error: "No USDC balance", wallet };
            }

            const accountInfo = await connection.getTokenAccountBalance(
              tokenAccounts.value[0].pubkey
            );
            const balance =
              action === "sell_50"
                ? Number(accountInfo.value.amount) * 0.5
                : Number(accountInfo.value.amount);

            // Quote from Jupiter
            let quote;
            try {
              const resp = await axios.get(
                "https://lite-api.jup.ag/swap/v1/quote",
                {
                  params: {
                    inputMint,
                    outputMint,
                    amount: balance,
                    slippageBps,
                  },
                  headers: { Accept: "application/json" },
                }
              );
              quote = resp.data;
            } catch (err) {
              return { success: false, error: "Quote API error", wallet };
            }

            // Swap transaction from Jupiter
            let swapResponse;
            try {
              const swapPayload = {
                userPublicKey: wallet.publicKey.toBase58(),
                quoteResponse: quote,
                prioritizationFeeLamports: {
                  priorityLevelWithMaxLamports: {
                    maxLamports: 10000000,
                    priorityLevel: "veryHigh",
                  },
                },
                dynamicComputeUnitLimit: true,
              };

              const resp = await axios.post(
                "https://lite-api.jup.ag/swap/v1/swap",
                swapPayload,
                {
                  headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                  },
                }
              );
              swapResponse = resp.data;
            } catch (err) {
              return {
                success: false,
                error: `Swap API error: ${err.message}`,
                wallet,
              };
            }

            try {
              const txBuffer = Buffer.from(
                swapResponse.swapTransaction,
                "base64"
              );
              const transaction =
                solanaWeb3.VersionedTransaction.deserialize(txBuffer);

              transaction.sign([wallet]);
              const sig = await connection.sendTransaction(transaction);

              return { success: true, sig, wallet };
            } catch (err) {
              return {
                success: false,
                error: `Tx send error: ${err.message}`,
                wallet,
              };
            }
          } catch (err) {
            return {
              success: false,
              error: `Unexpected: ${err.message}`,
              wallet,
            };
          }
        })
      );

      for (const res of results) {
        if (res.success) {
          successCount++;
          await bot.sendMessage(
            chatId,
            `✅ ${res.wallet.publicKey.toBase58()} swapped token to SOL.\n🔗 https://solscan.io/tx/${
              res.sig
            }`
          );
        } else {
          failCount++;
          await bot.sendMessage(
            chatId,
            `❌ ${res.wallet.publicKey.toBase58()} failed: ${res.error}`
          );
        }
      }

      await new Promise((res) => setTimeout(res, 500));
    }

    await bot.sendMessage(
      chatId,
      `🛒 Sell complete!\n✅ Success: ${successCount}\n❌ Failed: ${failCount}`
    );
  }
  const msg = query.message;

  if (data === "confirm_delete") {
    try {
      const result = await Panel.findOneAndDelete({ userId });

      if (result) {
        bot.editMessageText(
          "🗑️ Your panel and all associated wallets have been deleted.",
          {
            chat_id: msg.chat.id,
            message_id: msg.message_id,
          }
        );
      } else {
        bot.editMessageText("ℹ️ No panel found to delete.", {
          chat_id: msg.chat.id,
          message_id: msg.message_id,
        });
      }
    } catch (err) {
      console.error(err);
      bot.editMessageText("❌ An error occurred while deleting your panel.", {
        chat_id: msg.chat.id,
        message_id: msg.message_id,
      });
    }
  } else if (data === "cancel_delete") {
    bot.editMessageText("❎ Deletion cancelled. Your panel is safe.", {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
    });
  }
});
