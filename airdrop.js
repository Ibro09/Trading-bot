import * as web3 from "@solana/web3.js";

// Connect to Solana devnet
const connection = new web3.Connection(web3.clusterApiUrl('devnet'), 'confirmed');

// Airdrop for testing (remove this in mainnet)
async function requestAirdrop() {
  const publicKey = new web3.PublicKey('HCSKemTzeEQmKBHpFEngjtJmgmHvKe8sSboj5zLRMFHK');
  console.log('Requesting airdrop of 1 SOL to', publicKey.toBase58());

  const sig = await connection.requestAirdrop(publicKey, web3.LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, 'confirmed');

  console.log('Airdrop complete. Tx:', sig);
}

// Call inside an async IIFE
(async () => {
  await requestAirdrop();
})();
 