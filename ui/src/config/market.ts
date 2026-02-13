import { PublicKey } from "@solana/web3.js";

/**
 * Devnet market addresses — single source of truth for the UI.
 * From devnet-market.json and verified-matcher.json.
 */

// Percolator program (risk engine)
export const PROGRAM_ID = new PublicKey("2SSnp35m7FQ7cRLNKGdW5UzjYFF6RBUNq7d3m5mqNByp");

// Passive matcher program (Toly's)
export const PASSIVE_MATCHER_PROGRAM = new PublicKey("4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy");

// Credibility matcher program (Provenance)
export const CREDIBILITY_MATCHER_PROGRAM = new PublicKey("3Yg6brhpvLt7enU4rzvMkzexCexA1LFfAQqT3CSmGAH2");

// Market slab account
export const SLAB = new PublicKey("75h2kF58m3ms77c8WwzQh6h4iT2XMA1F5Mk13FZ6CCUs");

// Collateral mint (wrapped SOL)
export const MINT = new PublicKey("So11111111111111111111111111111111111111112");

// Token vault
export const VAULT = new PublicKey("8yVk7ULLjErxGAUDU6a4LGpLmCvD7K69Z7dkSBvz74Th");

// Vault PDA (authority over vault)
export const VAULT_PDA = new PublicKey("2CvrKJj3J44zu5Q7T3BRtrAod31mheXzH5JL5rmrbAoW");

// Oracle (Chainlink price feed)
export const ORACLE = new PublicKey("99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR");

// Credibility matcher context account
export const MATCHER_CTX = new PublicKey("HhgsX4E5czJpkDbhLUMMYPweSweudCXdNeYURwCD8eif");

// Credibility matcher LP index
export const LP_INDEX = 3;

// Credibility matcher LP PDA
export const LP_PDA = new PublicKey("FaTZfNsKp4iKgSwdQPBJ18YhGpBxjU1dJpe4N9cpAnP4");

// System program (burned admin sentinel)
export const SYSTEM_PROGRAM_STR = "11111111111111111111111111111111";

// Build verification hash (from solana-verify)
export const VERIFIED_BUILD_HASH = "4a524f9ea594af53033314af9a1bad139aee6bb50727983615557ddd75fda2df";

// Dead instructions — admin-gated instructions that are unusable after burn
export const DEAD_INSTRUCTIONS = [
  { tag: 11, name: "SetRiskThreshold" },
  { tag: 12, name: "UpdateAdmin" },
  { tag: 13, name: "CloseSlab" },
  { tag: 14, name: "UpdateConfig" },
  { tag: 15, name: "SetMaintenanceFee" },
  { tag: 16, name: "SetOracleAuthority" },
  { tag: 18, name: "SetOraclePriceCap" },
  { tag: 19, name: "ResolveMarket" },
  { tag: 20, name: "WithdrawInsurance" },
] as const;
