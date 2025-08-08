const axios = require('axios');

const userPublicKey = '6PaqT8Pj1E9Wcu8TkDsJDQA7ATKXybqMHyNsZn8stKfk'; // your wallet address
const inputMint = 'So11111111111111111111111111111111111111112'; // wSOL
const outputMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC
const amount = 1000000000; // 0.001 SOL in lamports
const slippageBps = 50; // 0.5% slippage

// Step 1: Get a quote
axios.get('https://lite-api.jup.ag/swap/v1/quote', {
  params: {
    inputMint,
    outputMint,
    amount, 
    slippageBps
  },
  headers: {
    'Accept': 'application/json'
  }
})
.then((quoteResponse) => {
  const quote = quoteResponse.data;

  // Step 2: Send swap request using the quote
  const swapPayload = {
    userPublicKey,
    quoteResponse: quote,
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: {
        maxLamports: 10000000,
        priorityLevel: 'veryHigh'
      }
    },
    dynamicComputeUnitLimit: true
  };

  return axios.post('https://lite-api.jup.ag/swap/v1/swap', swapPayload, {
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  });
})
.then((swapResponse) => {
  console.log('Swap Response:', JSON.stringify(swapResponse.data, null, 2));
})
.catch((error) => {
  console.error('Error:', error.response?.data || error.message);
});