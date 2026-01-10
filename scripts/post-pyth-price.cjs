/**
 * Post fresh Pyth prices to devnet using the Pyth SDK
 *
 * Usage:
 *   source ~/.nvm/nvm.sh && nvm use 20 && node scripts/post-pyth-price.cjs [feed]
 *
 * Requires Node.js 20 (Node 24 has rpc-websockets compatibility issues)
 */

const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} = require("@solana/web3.js");
const fs = require("fs");

// Pyth feed IDs
const FEEDS = {
  btc: {
    id: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    name: "BTC/USD"
  },
  sol: {
    id: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    name: "SOL/USD"
  },
  eth: {
    id: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
    name: "ETH/USD"
  }
};

const HERMES_ENDPOINT = "https://hermes.pyth.network";

async function main() {
  const feedArg = (process.argv[2] || "btc").toLowerCase();
  const feed = FEEDS[feedArg];

  if (!feed) {
    console.log("Unknown feed. Available: btc, sol, eth");
    process.exit(1);
  }

  console.log(`\nPosting ${feed.name} price to devnet using Pyth SDK...\n`);

  // Check Node version
  const nodeVersion = parseInt(process.version.slice(1));
  if (nodeVersion > 22) {
    console.log(`WARNING: Node ${process.version} may have issues with Pyth SDK`);
    console.log("Recommended: source ~/.nvm/nvm.sh && nvm use 20\n");
  }

  // Load wallet
  const walletPath = process.env.WALLET_PATH || `${process.env.HOME}/.config/solana/id.json`;
  const wallet = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
  );
  console.log(`Wallet: ${wallet.publicKey.toBase58()}`);

  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const balance = await connection.getBalance(wallet.publicKey);
  console.log(`Balance: ${(balance / 1e9).toFixed(4)} SOL\n`);

  // Fetch price from Hermes
  console.log("Fetching price from Hermes...");
  const response = await fetch(
    `${HERMES_ENDPOINT}/v2/updates/price/latest?ids[]=${feed.id}&encoding=hex&parsed=true`
  );
  const priceUpdate = await response.json();

  if (!priceUpdate.parsed?.[0]) {
    console.log("ERROR: Could not fetch price from Hermes");
    process.exit(1);
  }

  const parsed = priceUpdate.parsed[0];
  const priceUsd = Number(parsed.price.price) * Math.pow(10, parsed.price.expo);
  const publishTime = new Date(parsed.price.publish_time * 1000);

  console.log(`\nHermes ${feed.name} price:`);
  console.log(`  Price: $${priceUsd.toFixed(2)}`);
  console.log(`  Confidence: ±$${(Number(parsed.price.conf) * Math.pow(10, parsed.price.expo)).toFixed(2)}`);
  console.log(`  Published: ${publishTime.toISOString()}`);
  console.log(`  Age: ${((Date.now() - publishTime.getTime()) / 1000).toFixed(1)}s\n`);

  const vaaHex = priceUpdate.binary?.data?.[0];
  if (!vaaHex) {
    console.log("ERROR: No binary VAA data");
    process.exit(1);
  }

  // Load Pyth SDK
  console.log("Loading Pyth SDK...");
  let PythSolanaReceiver, Wallet, AnchorProvider;
  try {
    const pythModule = require("@pythnetwork/pyth-solana-receiver/PythSolanaReceiver");
    PythSolanaReceiver = pythModule.PythSolanaReceiver;
    const anchorModule = require("@coral-xyz/anchor");
    Wallet = anchorModule.Wallet;
    AnchorProvider = anchorModule.AnchorProvider;
  } catch (err) {
    console.log(`ERROR loading SDK: ${err.message}`);
    console.log("\nTry: source ~/.nvm/nvm.sh && nvm use 20 && node scripts/post-pyth-price.cjs");
    process.exit(1);
  }

  console.log("Creating Pyth receiver instance...");
  const anchorWallet = new Wallet(wallet);
  const provider = new AnchorProvider(connection, anchorWallet, { commitment: "confirmed" });

  const pythReceiver = new PythSolanaReceiver({
    connection,
    wallet: anchorWallet,
  });

  console.log("Building post instructions...");

  try {
    const { postInstructions, priceFeedIdToPriceUpdateAccount, closeInstructions } =
      await pythReceiver.buildPostPriceUpdateAtomicInstructions([vaaHex]);

    const oracleAccount = priceFeedIdToPriceUpdateAccount[feed.id];
    console.log(`\nOracle account: ${oracleAccount?.toBase58()}`);
    console.log(`Post instructions: ${postInstructions.length}`);
    console.log(`Close instructions: ${closeInstructions.length}`);

    // Build transaction
    console.log("\nBuilding transaction...");
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 }));

    const signers = [wallet];
    for (const ix of postInstructions) {
      tx.add(ix.instruction);
      if (ix.signers && ix.signers.length > 0) {
        signers.push(...ix.signers);
      }
    }

    console.log(`Transaction has ${tx.instructions.length} instructions`);
    console.log(`Signers: ${signers.length}`);

    // Send
    console.log("\nSending transaction...");
    const sig = await sendAndConfirmTransaction(
      connection,
      tx,
      signers,
      { commitment: "confirmed", skipPreflight: true }
    );

    console.log(`\n${"=".repeat(60)}`);
    console.log("SUCCESS!");
    console.log("=".repeat(60));
    console.log(`\nTransaction: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
    console.log(`Oracle: ${oracleAccount?.toBase58()}`);

    // Verify the price was posted
    if (oracleAccount) {
      const info = await connection.getAccountInfo(oracleAccount);
      if (info) {
        console.log(`\nVerifying on-chain data:`);
        console.log(`  Account size: ${info.data.length} bytes`);
        console.log(`  Owner: ${info.owner.toBase58()}`);

        // Parse price
        if (info.data.length >= 102) {
          const price = info.data.readBigInt64LE(74);
          const expo = info.data.readInt32LE(90);
          const onChainPrice = Number(price) * Math.pow(10, expo);
          const pubTime = Number(info.data.readBigInt64LE(94));
          console.log(`  On-chain price: $${onChainPrice.toFixed(2)}`);
          console.log(`  Publish time: ${new Date(pubTime * 1000).toISOString()}`);
        }
      }
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log("You can now use this oracle for testing!");
    console.log(`Oracle pubkey: ${oracleAccount?.toBase58()}`);
    console.log("=".repeat(60));

    // Save for later use
    if (oracleAccount) {
      fs.writeFileSync(
        "scripts/last-oracle.json",
        JSON.stringify({
          pubkey: oracleAccount.toBase58(),
          feed: feed.name,
          price: priceUsd,
          timestamp: new Date().toISOString(),
        }, null, 2)
      );
      console.log("\nSaved oracle info to scripts/last-oracle.json");
    }

  } catch (err) {
    console.log(`\nERROR: ${err.message}`);
    if (err.logs) {
      console.log("\nTransaction logs:");
      for (const log of err.logs.slice(-10)) {
        console.log(`  ${log}`);
      }
    }
  }
}

main().catch(console.error);
