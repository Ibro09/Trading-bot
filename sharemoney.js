import * as web3 from "@solana/web3.js";

// Connect to Solana devnet
const connection = new web3.Connection(
  web3.clusterApiUrl("devnet"),
  "confirmed"
);

// Base64 encoded private key
const base64SecretKey =
  "8FRrViunmsJwsJzz1REG+1bLPFq/tZMD1D7ErrZIcYrwqQLLPRqVu62mcnSWuQyIqQIdHUdD78BCFxYbva9vag==";

// Decode it to a Uint8Array
const secretKey = Uint8Array.from(Buffer.from(base64SecretKey, "base64"));

// Create Keypair from secret key
const mainKeypair = web3.Keypair.fromSecretKey(secretKey);
// Or use this for a public key only version (no transfer will work without secret key)
const mainPublicKey = mainKeypair.publicKey;

console.log("Main Wallet Address:", mainPublicKey.toBase58());
console.log(
  "Private Key (base64):",
  Buffer.from(mainKeypair.secretKey).toString("base64")
);

console.log("Waiting for deposit...");
let initialBalance = await connection.getBalance(mainPublicKey);

const checkDeposit = setInterval(async () => {
  const newBalance = await connection.getBalance(mainPublicKey);

  if (newBalance > initialBalance + 0.1 * web3.LAMPORTS_PER_SOL) {
    clearInterval(checkDeposit);

    console.log(
      `Deposit detected! New Balance: ${newBalance / web3.LAMPORTS_PER_SOL} SOL`
    );

    // Estimate fee ONCE outside the loop
    const dummyTx = new web3.Transaction().add(
      web3.SystemProgram.transfer({
        fromPubkey: mainPublicKey,
        toPubkey: web3.Keypair.generate().publicKey,
        lamports: 1,
      })
    );

    const { blockhash } = await connection.getLatestBlockhash();
    dummyTx.recentBlockhash = blockhash;
    dummyTx.feePayer = mainPublicKey;

    const message = dummyTx.compileMessage();
    const feeInfo = await connection.getFeeForMessage(message);
    const feePerTx = feeInfo.value ?? 5000; // fallback if null

    const totalFee = feePerTx * 10;
    const distributable = newBalance - totalFee;

    if (distributable <= 0) {
      console.log("❌ Insufficient balance to cover fees.");
      return;
    }

    const amountToSend = Math.floor(distributable / 10);

    // Distribute SOL
    for (let i = 0; i < 10; i++) {
      const newWallet = web3.Keypair.generate();
      console.log(
        `\nNew Wallet ${i + 1} Address: ${newWallet.publicKey.toBase58()}`
      );
      console.log(
        `New Wallet ${i + 1} Private Key: ${Buffer.from(
          newWallet.secretKey
        ).toString("base64")}`
      );

      const tx = new web3.Transaction().add(
        web3.SystemProgram.transfer({
          fromPubkey: mainPublicKey,
          toPubkey: newWallet.publicKey,
          lamports: amountToSend,
        })
      );

      tx.recentBlockhash = blockhash;
      tx.feePayer = mainPublicKey;

      try {
        const signature = await web3.sendAndConfirmTransaction(connection, tx, [
          mainKeypair,
        ]);
        console.log(
          `✅ Sent ${(amountToSend / web3.LAMPORTS_PER_SOL).toFixed(
            4
          )} SOL | Tx: ${signature}`
        );
      } catch (err) {
        console.error(`❌ Failed to send to Wallet ${i + 1}:`, err.message);
      }
    }

    const finalBalance = await connection.getBalance(mainPublicKey);
    console.log(
      `\nRemaining in main wallet: ${(
        finalBalance / web3.LAMPORTS_PER_SOL
      ).toFixed(4)} SOL`
    );
  }
}, 5000);
 // Poll every 5 seconds


