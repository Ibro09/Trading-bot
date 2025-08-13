const fetch = require("node-fetch");
const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const bs58 = require("bs58");
const axios = require("axios");
// Replace with your real Telegram bot token
const token = "7844180208:AAG0bIWlehBfyahpDpu3VvANwse43qhaLkc";
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
} = solanaWeb3;
// Polling mode
const bot = new TelegramBot(token, { polling: true });

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
          `✅ First fallback tx confirmed: https://solscan.io/tx/${r1.sig}?cluster=devnet`
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
          `✅ Second fallback tx confirmed: https://solscan.io/tx/${r2.sig}?cluster=devnet`
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
        `✅ Split complete!\n🔗 https://solscan.io/tx/${res.sig}?cluster=devnet`
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

const JUPITER_API = "https://lite-api.jup.ag";

bot.onText(/^\/buy(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const panel = await Panel.findOne({ userId });

  if (!panel)
    return bot.sendMessage(
      chatId,
      "❌ No panel found. Please use /start to set up your panel."
    );
  if (!match[1])
    return bot.sendMessage(
      chatId,
      "Please provide the token address to buy. Example: /buy <tokenaddress>"
    );

  const tokenAddress = match[1].trim();
  try {
    new solanaWeb3.PublicKey(tokenAddress);
  } catch {
    return bot.sendMessage(chatId, "❌ Invalid token address.");
  }

  const inputMint = "So11111111111111111111111111111111111111112"; // SOL
  const outputMint = tokenAddress;
  const wallets = panel.wallets.slice(0, 25); // limit to 25

  // Build a transaction and collect signers
  let transaction = new Transaction();
  const signers = []; // keypairs that must sign (all wallets that will swap)
  let anyInstructionsAdded = false;

  // Get a fresh blockhash (we'll refresh before final send)
  let blockhashInfo = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = blockhashInfo.blockhash;

  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    try {
      const keypair = Keypair.fromSecretKey(Buffer.from(w.privateKey, "hex"));
      const balance = await connection.getBalance(keypair.publicKey);
      const rentExempt = await connection.getMinimumBalanceForRentExemption(0);
      const feeBuffer = 5000;
      const amount =
        balance > rentExempt + feeBuffer ? balance - rentExempt - feeBuffer : 0;

      if (amount <= 0) {
        await bot.sendMessage(
          chatId,
          `❌ Wallet ${i + 1} (${w.address}) has insufficient SOL.`
        );
        continue;
      }

      // 1) Get a quote
      try {
        const quoteResp = await axios.get(
          `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=100`
        );
        const quoteData = quoteResp.data;
        if (
          !quoteData ||
          (!quoteData.routePlan && !quoteData.data && !quoteData.bestQuote)
        ) {
          await bot.sendMessage(
            chatId,
            `❌ Wallet ${i + 1} failed to get quote.`
          );
          continue;
        }
      } catch (err) {
        // Handle Jupiter API errors
        if (err.response && err.response.status === 400) {
          await bot.sendMessage(
            chatId,
            `❌ Wallet ${i + 1} (${
              w.address
            }) Jupiter quote API rejected the request. Likely too little SOL or unsupported token.`
          );
        } else {
          await bot.sendMessage(
            chatId,
            `❌ Wallet ${i + 1} (${w.address}) failed to get quote: ${
              err.message
            }`
          );
        }
        continue;
      }

      // 2) Ask for swap-instructions (preferred) - endpoint may vary, adjust if your Jupiter version differs
      let instResp;
      try {
        instResp = await axios.post(
          `https://quote-api.jup.ag/v6/swap-instructions`,
          {
            quoteResponse: quoteData,
            userPublicKey: keypair.publicKey.toBase58(),
            wrapUnwrapSOL: true,
          },
          { headers: { "Content-Type": "application/json" } }
        );
      } catch (err) {
        // If swap-instructions endpoint failed, log and fallback to per-wallet swap later
        console.error(
          "swap-instructions error",
          err.response ? err.response.data : err.message
        );
        await bot.sendMessage(
          chatId,
          `⚠️ Wallet ${
            i + 1
          }: swap-instructions failed — will fallback to per-wallet sending later.`
        );
        continue;
      }

      // -- DEBUG: inspect the returned shape when things fail --
      // If you run into problems, uncomment the next line to see exactly what Jupiter returned
      // console.log("Jupiter swap-instructions response:", JSON.stringify(instResp.data, null, 2));

      const instData = instResp.data;

      // Cases:
      // - instData.swapInstruction may be an array of instruction objects
      // - instData.swapInstructions (plural)
      // - instData.swapTransaction (base64): can't batch easily (it's a full txn), so skip here
      let instructionsArray = null;
      if (Array.isArray(instData.swapInstruction))
        instructionsArray = instData.swapInstruction;
      else if (Array.isArray(instData.swapInstructions))
        instructionsArray = instData.swapInstructions;
      else if (
        instData.swapInstruction &&
        !Array.isArray(instData.swapInstruction)
      )
        instructionsArray = [instData.swapInstruction];

      if (instructionsArray) {
        // Add each instruction (robustly handle object shapes)
        for (const inst of instructionsArray) {
          // inst might be { programId, keys, data } or similar; build TransactionInstruction
          if (inst.programId && inst.keys) {
            const keys = inst.keys.map((k) => ({
              pubkey: new PublicKey(
                k.pubkey || k.pubkeyString || k.pubkeyAddress || k
              ),
              isSigner: !!k.isSigner,
              isWritable: !!k.isWritable,
            }));
            const data = inst.data
              ? Buffer.from(inst.data, "base64")
              : Buffer.alloc(0);
            transaction.add(
              new TransactionInstruction({
                keys,
                programId: new PublicKey(inst.programId),
                data,
              })
            );
            anyInstructionsAdded = true;
          } else {
            // Unexpected shape — log and skip
            console.warn("Unexpected instruction shape:", inst);
            await bot.sendMessage(
              chatId,
              `⚠️ Wallet ${
                i + 1
              }: Jupiter returned an unsupported instruction shape. Skipping this wallet.`
            );
            continue;
          }
        }

        // keep this wallet's keypair to sign later
        signers.push(keypair);
      } else if (instData.swapTransaction) {
        // Jupiter returned a full transaction (base64). You cannot merge pre-built serialized transactions easily.
        // Best option: fall back to per-wallet send for this wallet.
        console.warn("swapTransaction returned for wallet", w.address);
        await bot.sendMessage(
          chatId,
          `⚠️ Wallet ${
            i + 1
          }: Jupiter returned a full transaction for this quote — cannot batch. Will fallback to per-wallet send for this wallet.`
        );
        continue;
      } else {
        // Nothing usable returned
        console.warn(
          "No usable instructions returned for wallet",
          w.address,
          instData
        );
        await bot.sendMessage(
          chatId,
          `⚠️ Wallet ${
            i + 1
          }: no usable instructions returned (see console). Will fallback later.`
        );
        continue;
      }
    } catch (err) {
      console.error("wallet loop error", err);
      await bot.sendMessage(
        chatId,
        `❌ Wallet ${i + 1} failed: ${err.message || String(err)}`
      );
      continue;
    }
  } // end wallets loop

  // If we added no instructions suitable for batching, fallback to original per-wallet approach
  if (!anyInstructionsAdded) {
    return bot.sendMessage(
      chatId,
      "❌ No instructions collected for batching. Falling back to per-wallet swaps (not implemented in this branch)."
    );
  }

  // Set fee payer (must be one of the signers)
  transaction.feePayer = signers[0].publicKey;

  // Refresh blockhash right before signing and sending
  blockhashInfo = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = blockhashInfo.blockhash;

  try {
    // Sign with all wallet keypairs that contributed instructions
    transaction.sign(...signers);

    // Send the batched transaction
    const txid = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
    });
    await connection.confirmTransaction(txid, "finalized");
    await bot.sendMessage(
      chatId,
      `✅ Batched buys sent in one transaction!\n🔗 https://solscan.io/tx/${txid}`
    );
  } catch (err) {
    console.error("Batched transaction error:", err);

    // If tx too large or other irreversible issue, inform user and optionally fallback
    const msg = err && err.message ? err.message : String(err);
    if (
      msg.toLowerCase().includes("transaction too large") ||
      msg.toLowerCase().includes("exceeds maximum")
    ) {
      await bot.sendMessage(
        chatId,
        `❌ Batched transaction too large. You must fallback to smaller batches or per-wallet transactions.`
      );
    } else {
      await bot.sendMessage(
        chatId,
        `❌ Failed to send batched transaction: ${msg}`
      );
    }
  }
});

bot.onText(/^\/sell(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const panel = await Panel.findOne({ userId });
  if (!panel) {
    return bot.sendMessage(
      chatId,
      "❌ No panel found. Please use /start to set up your panel."
    );
  }

  // If no token address, ask for it
  if (!match[1]) {
    return bot.sendMessage(
      chatId,
      "Please provide the token address to sell. Example: /sell <tokenaddress>"
    );
  }
  const tokenAddress = match[1].trim();
  try {
    new solanaWeb3.PublicKey(tokenAddress);
  } catch (err) {
    return bot.sendMessage(
      chatId,
      "❌ Invalid token address. Please provide a valid Solana token address."
    );
  }

  // Ask for percentage
  const options = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Sell 50%", callback_data: `sell_50_${tokenAddress}` },
          { text: "Sell 100%", callback_data: `sell_100_${tokenAddress}` },
        ],
      ],
    },
  };
  bot.sendMessage(chatId, "Choose how much to sell:", options);
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
    const pubkey = keypair.publicKey;

    try {
      const balance = await connection.getBalance(pubkey);
      const rentExempt = await connection.getMinimumBalanceForRentExemption(0);
      const feeBuffer = 15000;
      const amount =
        balance > rentExempt + feeBuffer
          ? balance - rentExempt - feeBuffer
          : 0;

      if (amount <= 0) {
        await bot.sendMessage(
          chatId,
          `❌ Wallet ${i + 1} (${walletInfo.address}) has insufficient SOL to withdraw.`
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
        `❌ Wallet ${i + 1} (${walletInfo.address}) failed to withdraw: ${err.message}`
      );
      failCount++;
    }
  }

  await bot.sendMessage(
    chatId,
    `🏦 Withdraw complete!\n✅ Success: ${successCount}\n❌ Failed: ${failCount}`
  );
});

// Handle sell percentage callback
bot.on("callback_query", async (query) => {
  const data = query.data;
  const chatId = query.message.chat.id;
  const userId = query.from.id.toString();

  if (data.startsWith("sell_")) {
    const [, percent, tokenAddress] = data.split("_");
    const panel = await Panel.findOne({ userId });

    if (!panel) return bot.sendMessage(chatId, "❌ No panel found.");

    const inputMint = tokenAddress; // selling this token
    const outputMint = "So11111111111111111111111111111111111111112"; // SOL
    const wallets = panel.wallets.slice(0, 25);

    let transaction = new Transaction();
    const signers = [];
    let anyInstructionsAdded = false;

    let blockhashInfo = await connection.getLatestBlockhash("confirmed");
    transaction.recentBlockhash = blockhashInfo.blockhash;

    for (let i = 0; i < wallets.length; i++) {
      try {
        const w = wallets[i];
        const keypair = Keypair.fromSecretKey(Buffer.from(w.privateKey, "hex"));

        // get token balance
        const tokenAccounts = await connection.getTokenAccountsByOwner(
          keypair.publicKey,
          { mint: new PublicKey(inputMint) }
        );
        if (tokenAccounts.value.length === 0) {
          await bot.sendMessage(
            chatId,
            `❌ Wallet ${i + 1} (${w.address}) has no ${inputMint} tokens.`
          );
          continue;
        }

        const tokenAccInfo = await connection.getParsedAccountInfo(
          tokenAccounts.value[0].pubkey
        );
        const balanceAmount =
          tokenAccInfo.value.data.parsed.info.tokenAmount.amount;
        const amount = Math.floor(
          Number(balanceAmount) * (parseInt(percent) / 100)
        );

        if (amount <= 0) {
          await bot.sendMessage(
            chatId,
            `❌ Wallet ${i + 1} has insufficient token balance.`
          );
          continue;
        }

        // Get quote
        const quoteResp = await axios.get(
          `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=100`
        );
        const quoteData = quoteResp.data;

        // Get swap instructions
        let instResp;
        try {
          instResp = await axios.post(
            `https://quote-api.jup.ag/v6/swap-instructions`,
            {
              quoteResponse: quoteData,
              userPublicKey: keypair.publicKey.toBase58(),
              wrapUnwrapSOL: true,
            },
            { headers: { "Content-Type": "application/json" } }
          );
        } catch (err) {
          console.error(
            "swap-instructions error",
            err.response ? err.response.data : err.message
          );
          await bot.sendMessage(
            chatId,
            `⚠️ Wallet ${i + 1}: swap-instructions failed — fallback later.`
          );
          continue;
        }

        // console.log("SELL swap-instructions response:", JSON.stringify(instResp.data, null, 2));

        const instData = instResp.data;
        let instructionsArray = null;
        if (Array.isArray(instData.swapInstruction))
          instructionsArray = instData.swapInstruction;
        else if (Array.isArray(instData.swapInstructions))
          instructionsArray = instData.swapInstructions;
        else if (
          instData.swapInstruction &&
          !Array.isArray(instData.swapInstruction)
        )
          instructionsArray = [instData.swapInstruction];

        if (instructionsArray) {
          for (const inst of instructionsArray) {
            if (inst.programId && inst.keys) {
              const keys = inst.keys.map((k) => ({
                pubkey: new PublicKey(
                  k.pubkey || k.pubkeyString || k.pubkeyAddress || k
                ),
                isSigner: !!k.isSigner,
                isWritable: !!k.isWritable,
              }));
              const dataBuf = inst.data
                ? Buffer.from(inst.data, "base64")
                : Buffer.alloc(0);
              transaction.add(
                new TransactionInstruction({
                  keys,
                  programId: new PublicKey(inst.programId),
                  data: dataBuf,
                })
              );
              anyInstructionsAdded = true;
            } else {
              // Unexpected shape — log and skip
              console.warn("Unexpected instruction shape:", inst);
              await bot.sendMessage(
                chatId,
                `⚠️ Wallet ${
                  i + 1
                }: Jupiter returned an unsupported instruction shape. Skipping this wallet.`
              );
              continue;
            }
          }
          signers.push(keypair);
        } else if (instData.swapTransaction) {
          console.warn("swapTransaction returned for wallet", w.address);
          await bot.sendMessage(
            chatId,
            `⚠️ Wallet ${i + 1}: Jupiter returned a full txn — will fallback.`
          );
          continue;
        } else {
          console.warn(
            "No usable instructions returned for wallet",
            w.address,
            instData
          );
          await bot.sendMessage(
            chatId,
            `⚠️ Wallet ${i + 1}: no usable instructions.`
          );
          continue;
        }
      } catch (err) {
        console.error("sell wallet loop error", err);
        await bot.sendMessage(
          chatId,
          `❌ Wallet ${i + 1} failed: ${err.message}`
        );
      }
    }

    if (!anyInstructionsAdded) {
      return bot.sendMessage(
        chatId,
        "❌ No sell instructions collected for batching."
      );
    }

    transaction.feePayer = signers[0].publicKey;
    blockhashInfo = await connection.getLatestBlockhash("confirmed");
    transaction.recentBlockhash = blockhashInfo.blockhash;

    try {
      transaction.sign(...signers);
      const txid = await connection.sendRawTransaction(
        transaction.serialize(),
        { skipPreflight: false }
      );
      await connection.confirmTransaction(txid, "finalized");
      await bot.sendMessage(
        chatId,
        `✅ Batched sell sent!\n🔗 https://solscan.io/tx/${txid}`
      );
    } catch (err) {
      console.error("Batched sell error:", err);
      await bot.sendMessage(
        chatId,
        `❌ Failed to send batched sell: ${err.message}`
      );
    }
  }
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

// Handle button response
bot.on("callback_query", async (callbackQuery) => {
  const data = callbackQuery.data;
  const msg = callbackQuery.message;
  const userId = callbackQuery.from.id.toString();

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
