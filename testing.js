const fetch = require("node-fetch");
const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
// Replace with your real Telegram bot token
const token = "7844180208:AAG0bIWlehBfyahpDpu3VvANwse43qhaLkc";
require("dotenv").config();
const solanaWeb3 = require("@solana/web3.js");
const axios = require("axios"); // Add at the top if not present
const connection = new solanaWeb3.Connection(
  solanaWeb3.clusterApiUrl("mainnet-beta"),
  "confirmed"
);

const { VersionedTransaction, VersionedMessage } = solanaWeb3;
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
    for (let i = 0; i < 11; i++) {
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

💸 /split – Evenly split the funds in the panel across 10 wallets  
📊 /panel – View and share panel information, including wallet details  
🛒 /buy <tokenaddress> – Instantly buy a token using all 10 connected wallets  
🗑️ /delete – Remove all wallets and reset your panel configuration  

Let’s start trading! 🚀
`;

  bot.sendMessage(msg.chat.id, helpMessage, { parse_mode: "Markdown" });
});

// /split command
bot.onText(/^\/split$/, async (msg) => {
  const userId = msg.from.id.toString();
  const chatId = msg.chat.id;

  const panel = await Panel.findOne({ userId });
  if (!panel) {
    return bot.sendMessage(
      chatId,
      "❌ No panel found. Please use /start to set up your panel."
    );
  }

  const mainKeypair = solanaWeb3.Keypair.fromSecretKey(
    Buffer.from(panel.privateKey, "hex")
  );
  const mainPublicKey = mainKeypair.publicKey;

  const balance = await connection.getBalance(mainPublicKey);
  if (balance === 0) {
    return bot.sendMessage(
      chatId,
      "💸 Main wallet has no SOL. Please deposit SOL to proceed with splitting."
    );
  }

  const MAX_SPLIT_WALLETS = 15;
  const walletsToUse = panel.wallets.slice(0, MAX_SPLIT_WALLETS);
  const walletCount = walletsToUse.length;

  if (walletCount === 0) {
    return bot.sendMessage(
      chatId,
      "❌ No wallets found in your panel. Please add wallets to split funds."
    );
  }

  // Validate wallet addresses
  const validWallets = [];
  for (const wallet of walletsToUse) {
    try {
      new solanaWeb3.PublicKey(wallet.address);
      validWallets.push(wallet);
    } catch (err) {
      await bot.sendMessage(
        chatId,
        `❌ Invalid wallet address: ${wallet.address}. Please check and update your panel.`
      );
    }
  }
  if (validWallets.length !== walletCount) {
    return bot.sendMessage(
      chatId,
      `❌ Found ${
        walletCount - validWallets.length
      } invalid wallet addresses. Please fix your panel and try again.`
    );
  }

  // Estimate transaction fee
  const dummyTx = new solanaWeb3.Transaction().add(
    solanaWeb3.SystemProgram.transfer({
      fromPubkey: mainPublicKey,
      toPubkey: new solanaWeb3.PublicKey(validWallets[0].address),
      lamports: 1,
    })
  );

  let { blockhash } = await connection.getLatestBlockhash();
  dummyTx.recentBlockhash = blockhash;
  dummyTx.feePayer = mainPublicKey;

  const message = dummyTx.compileMessage();
  const feeInfo = await connection.getFeeForMessage(message);
  const feePerTx = feeInfo.value ?? 5000; // Default to 5000 lamports
  console.log(`Estimated fee per transaction: ${feePerTx} lamports`);

  // Estimate rent-exempt balance
  const rentExemptBalance = await connection.getMinimumBalanceForRentExemption(
    0
  );
  console.log(`Rent-exempt balance: ${rentExemptBalance} lamports`);

  // Check for non-existent wallets
  let newWalletCount = 0;
  const walletsToCreate = [];
  for (const wallet of walletsToUse) {
    const toPubkey = new solanaWeb3.PublicKey(wallet.address);
    const accountInfo = await connection.getAccountInfo(toPubkey);
    if (!accountInfo) {
      newWalletCount++;
      walletsToCreate.push(wallet.address);
    }
  }

  // Calculate fees
  const feeBuffer = Math.ceil(feePerTx * 0.2); // 20% buffer
  const totalTxFees = feePerTx * (walletCount + newWalletCount); // Fees for transfers + account creation
  const totalRentFees = rentExemptBalance * newWalletCount;
  const totalFees = totalTxFees + totalRentFees + feeBuffer;

  // FIX: Subtract only the transfer fees (not account creation) before splitting
  const distributable = balance - totalFees;

  // Calculate amount to send per wallet, ensuring enough left for all transfer fees
  const amountToSend = Math.floor(
    (balance - totalTxFees - totalRentFees - feeBuffer) / walletCount
  );

  if (amountToSend <= 0) {
    return bot.sendMessage(
      chatId,
      `❌ Available SOL too small to split evenly.\n` +
        `🪙 Available: ${(distributable / solanaWeb3.LAMPORTS_PER_SOL).toFixed(
          6
        )} SOL\n` +
        `💡 Please deposit more SOL to cover all wallets.`
    );
  }

  await bot.sendMessage(
    chatId,
    `🔄 Splitting ${(
      (amountToSend * walletCount) /
      solanaWeb3.LAMPORTS_PER_SOL
    ).toFixed(6)} SOL ` +
      `among ${walletCount} wallets (reserved: ${(
        totalFees / solanaWeb3.LAMPORTS_PER_SOL
      ).toFixed(6)} SOL for fees and ${newWalletCount} new accounts)...`
  );

  let successfulTxs = 0;

  // Step 1: Create accounts for non-existent wallets
  for (const walletAddress of walletsToCreate) {
    const toPubkey = new solanaWeb3.PublicKey(walletAddress);
    const tx = new solanaWeb3.Transaction().add(
      solanaWeb3.SystemProgram.createAccount({
        fromPubkey: mainPublicKey,
        newAccountPubkey: toPubkey,
        lamports: rentExemptBalance,
        space: 0,
        programId: solanaWeb3.SystemProgram.programId,
      })
    );

    ({ blockhash } = await connection.getLatestBlockhash());
    tx.recentBlockhash = blockhash;
    tx.feePayer = mainPublicKey;

    try {
      const sig = await solanaWeb3.sendAndConfirmTransaction(connection, tx, [
        mainKeypair,
      ]);
      await bot.sendMessage(
        chatId,
        `✅ Created account for wallet ${
          validWallets.findIndex((w) => w.address === walletAddress) + 1
        }: ` +
          `${(rentExemptBalance / solanaWeb3.LAMPORTS_PER_SOL).toFixed(
            6
          )} SOL\n` +
          `🔗 https://solscan.io/tx/${sig}?cluster=devnet`
      );
    } catch (err) {
      let errorMessage = "Unknown error";
      if (err.message.includes("Signature verification failed")) {
        errorMessage =
          "Failed to sign transaction. Please check the main wallet’s private key.";
      } else if (err.message.includes("insufficient funds")) {
        errorMessage = `Not enough SOL to create account. Need ${(
          rentExemptBalance / solanaWeb3.LAMPORTS_PER_SOL
        ).toFixed(6)} SOL.`;
      } else if (err.message.includes("Account already exists")) {
        errorMessage = "Account already exists. Skipping creation.";
      } else {
        errorMessage = `Transaction failed: ${err.message}`;
      }
      await bot.sendMessage(
        chatId,
        `❌ Failed to create account for wallet ${
          validWallets.findIndex((w) => w.address === walletAddress) + 1
        }: ${errorMessage}`
      );
    }
  }

  // Step 2: Distribute funds to all wallets
  for (let i = 0; i < walletCount; i++) {
    const wallet = walletsToUse[i];
    const toPubkey = new solanaWeb3.PublicKey(wallet.address);

    const tx = new solanaWeb3.Transaction().add(
      solanaWeb3.SystemProgram.transfer({
        fromPubkey: mainPublicKey,
        toPubkey: toPubkey,
        lamports: amountToSend,
      })
    );

    ({ blockhash } = await connection.getLatestBlockhash());
    tx.recentBlockhash = blockhash;
    tx.feePayer = mainPublicKey;

    try {
      const sig = await solanaWeb3.sendAndConfirmTransaction(connection, tx, [
        mainKeypair,
      ]);
      successfulTxs++;
      await bot.sendMessage(
        chatId,
        `✅ Wallet ${i + 1} funded: ${(
          amountToSend / solanaWeb3.LAMPORTS_PER_SOL
        ).toFixed(6)} SOL\n` + `🔗 https://solscan.io/tx/${sig}?cluster=devnet`
      );
    } catch (err) {
      let errorMessage = "Unknown error";
      if (err.message.includes("insufficient funds for rent")) {
        errorMessage = `Account needs to be created first. Please deposit ${(
          rentExemptBalance / solanaWeb3.LAMPORTS_PER_SOL
        ).toFixed(6)} SOL for account creation.`;
      } else if (err.message.includes("Signature verification failed")) {
        errorMessage =
          "Failed to sign transaction. Please check the main wallet’s private key.";
      } else if (err.message.includes("insufficient funds")) {
        errorMessage = `Not enough SOL in main wallet. Need at least ${(
          amountToSend / solanaWeb3.LAMPORTS_PER_SOL
        ).toFixed(6)} SOL.`;
      } else if (err.message.includes("blockhash")) {
        errorMessage =
          "Transaction failed due to network issues. Please try again later.";
      } else {
        errorMessage = `Transaction failed: ${err.message}`;
      }
      await bot.sendMessage(
        chatId,
        `❌ Wallet ${i + 1} failed: ${errorMessage}`
      );
    }
  }

  const finalBalance = await connection.getBalance(mainPublicKey);
  await bot.sendMessage(
    chatId,
    `✅ Split complete! ${successfulTxs}/${walletCount} wallets funded.\n` +
      `Remaining balance: ${(
        finalBalance / solanaWeb3.LAMPORTS_PER_SOL
      ).toFixed(6)} SOL`
  );
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

  let message = `📊 *Your Panel Details*\n\n`;

  message += `🔐 *Main Wallet*\n`;
  message += `📬 Address: \`${panel.address}\`\n`;
  message += `🔑 Private Key: \`${panel.privateKey}\`\n\n`;

  if (panel.wallets && panel.wallets.length > 0) {
    message += `🧩 *Secondary Wallets (${panel.wallets.length})*\n`;

    panel.wallets.forEach((wallet, index) => {
      message += `\n\n${index + 1}. 📬 \`${
        wallet.address
      }\`\n\n  🔑Private Key: \`${wallet.privateKey}\``;
    });
  } else {
    message += `No secondary wallets found.`;
  }

  bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
});

const JUPITER_API = "https://lite-api.jup.ag";
bot.onText(/^\/buy(?:\s+(.+))?$/, async (msg, match) => {
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
      "Please provide the token address to buy. Example: /buy <tokenaddress>"
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

  const inputMint = "So11111111111111111111111111111111111111112"; // SOL
  const outputMint = tokenAddress;
  const slippage = 1;

  // ...existing code...
  let successCount = 0;
  let failCount = 0;

  const buyPromises = panel.wallets.map(async (walletInfo, i) => {
    // Add a stagger delay (e.g., 500ms per wallet)
    await new Promise((res) => setTimeout(res, i * 500));

    try {
      const keypair = solanaWeb3.Keypair.fromSecretKey(
        Buffer.from(walletInfo.privateKey, "hex")
      );

      // Get wallet balance
      const balance = await connection.getBalance(keypair.publicKey);

      // Estimate rent-exempt minimum and fee buffer
      const rentExemptBalance =
        await connection.getMinimumBalanceForRentExemption(0);
      const feeBuffer = 4700000;

      const amount =
        balance > rentExemptBalance + feeBuffer
          ? balance - rentExemptBalance - feeBuffer
          : 0;

      if (amount <= 0) {
        await bot.sendMessage(
          chatId,
          `❌ Wallet ${i + 1} (${
            walletInfo.address
          }) has insufficient SOL after reserving for rent and fees.`
        );
        throw new Error("Insufficient SOL");
      }

      // 1. Get Quote from Jupiter (with timeout)
      const quotePromise = axios.get(
        `https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${Number(
          amount
        )}&slippageBps=100&dynamicSlippage=true`
      );
      const quoteResponse = (
        await Promise.race([
          quotePromise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Quote timeout")), 5000)
          ),
        ])
      ).data;

      if (!quoteResponse || !quoteResponse.routePlan) {
        throw new Error("Invalid quote response");
      }

      // 2. Get swap transaction (with timeout)
      const swapPromise = axios.post(
        "https://lite-api.jup.ag/swap/v1/swap",
        {
          quoteResponse,
          userPublicKey: keypair.publicKey.toBase58(),
          wrapUnwrapSOL: true,
          dynamicSlippage: true,
        },
        { headers: { "Content-Type": "application/json" } }
      );
      const swapJson = (
        await Promise.race([
          swapPromise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Swap timeout")), 5000)
          ),
        ])
      ).data;

      if (!swapJson.swapTransaction) throw new Error("No swap transaction");

      // 3. Sign & send (with timeout)
      const txBuffer = Buffer.from(swapJson.swapTransaction, "base64");
      const transaction = VersionedTransaction.deserialize(txBuffer);
      transaction.sign([keypair]);
      const signed = transaction.serialize();

      const txid = await Promise.race([
        connection.sendRawTransaction(signed, { skipPreflight: false }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Send timeout")), 5000)
        ),
      ]);

      await connection.confirmTransaction(txid, "finalized");

      await bot.sendMessage(
        chatId,
        `✅ Wallet ${i + 1} (${
          walletInfo.address
        }) purchased!\n🔗 https://solscan.io/tx/${txid}`
      );
      return true;
    } catch (err) {
      await bot.sendMessage(
        chatId,
        `❌ Wallet ${i + 1} (${
          walletInfo.address
        }) failed to swap for token: ${outputMint}\n${err.message}`
      );
      return false;
    }
  });

  const results = await Promise.allSettled(buyPromises);
  successCount = results.filter(
    (r) => r.status === "fulfilled" && r.value === true
  ).length;
  failCount = panel.wallets.length - successCount;

  await bot.sendMessage(
    chatId,
    `🛒 Buy complete!\n✅ Success: ${successCount}\n❌ Failed: ${failCount}`
  );
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
      "Please provide the token address to buy. Example: /buy <tokenaddress>"
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

  const inputMint = tokenAddress; // SOL
  const outputMint = "So11111111111111111111111111111111111111112";
  const slippage = 1;

  // ...existing code...
  let successCount = 0;
  let failCount = 0;

  const buyPromises = panel.wallets.map(async (walletInfo, i) => {
    // Add a stagger delay (e.g., 500ms per wallet)
    await new Promise((res) => setTimeout(res, i * 500));

    try {
      const keypair = solanaWeb3.Keypair.fromSecretKey(
        Buffer.from(walletInfo.privateKey, "hex")
      );

      // Get wallet balance
      const balance = await connection.getBalance(keypair.publicKey);

      // Estimate rent-exempt minimum and fee buffer
      const rentExemptBalance =
        await connection.getMinimumBalanceForRentExemption(0);
      const feeBuffer = 4700000;

      // Get SPL token balance for the tokenAddress
      const tokenAccount = await connection.getParsedTokenAccountsByOwner(
        keypair.publicKey,
        { mint: new solanaWeb3.PublicKey(tokenAddress) }
      );
      const tokenBalance =
        tokenAccount.value[0]?.account.data.parsed.info.tokenAmount.uiAmount;
      const decimals =
        tokenAccount.value[0]?.account.data.parsed.info.tokenAmount.decimals ||
        0;

      if (!tokenBalance || tokenBalance === 0) {
        await bot.sendMessage(
          chatId,
          `❌ Wallet ${i + 1} (${
            walletInfo.address
          }) has no balance of this token.`
        );
        throw new Error("No token balance");
      }

      const amount = Math.floor(tokenBalance * Math.pow(10, decimals));
      if (amount <= 0) {
        await bot.sendMessage(
          chatId,
          `❌ Wallet ${i + 1} (${
            walletInfo.address
          }) has insufficient SOL after reserving for rent and fees.`
        );
        throw new Error("Insufficient SOL");
      }

      // 1. Get Quote from Jupiter (with timeout)
      const quotePromise = axios.get(
        `https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${Number(
          amount
        )}&slippageBps=150&dynamicSlippage=true`
      );
      const quoteResponse = (
        await Promise.race([
          quotePromise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Quote timeout")), 5000)
          ),
        ])
      ).data;

      if (!quoteResponse || !quoteResponse.routePlan) {
        throw new Error("Invalid quote response");
      }

      // 2. Get swap transaction (with timeout)
      const swapPromise = axios.post(
        "https://lite-api.jup.ag/swap/v1/swap",
        {
          quoteResponse,
          userPublicKey: keypair.publicKey.toBase58(),
          wrapUnwrapSOL: true,
          dynamicSlippage: true,
        },
        { headers: { "Content-Type": "application/json" } }
      );
      const swapJson = (
        await Promise.race([
          swapPromise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Swap timeout")), 5000)
          ),
        ])
      ).data;

      if (!swapJson.swapTransaction) throw new Error("No swap transaction");

      // 3. Sign & send (with timeout)
      const txBuffer = Buffer.from(swapJson.swapTransaction, "base64");
      const transaction = VersionedTransaction.deserialize(txBuffer);
      transaction.sign([keypair]);
      const signed = transaction.serialize();

      const txid = await Promise.race([
        connection.sendRawTransaction(signed, { skipPreflight: false }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Send timeout")), 5000)
        ),
      ]);

      await connection.confirmTransaction(txid, "finalized");

      await bot.sendMessage(
        chatId,
        `✅ Wallet ${i + 1} (${
          walletInfo.address
        }) purchased!\n🔗 https://solscan.io/tx/${txid}`
      );
      return true;
    } catch (err) {
      await bot.sendMessage(
        chatId,
        `❌ Wallet ${i + 1} (${
          walletInfo.address
        }) failed to swap for token: ${outputMint}\n${err.message}`
      );
      return false;
    }
  });

  const results = await Promise.allSettled(buyPromises);
  successCount = results.filter(
    (r) => r.status === "fulfilled" && r.value === true
  ).length;
  failCount = panel.wallets.length - successCount;

  await bot.sendMessage(
    chatId,
    `🛒 Buy complete!\n✅ Success: ${successCount}\n❌ Failed: ${failCount}`
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
