/**
 * Verify binary market instruction encoding
 * This test validates that the new ResolveMarket and WithdrawInsurance
 * instructions are properly encoded without needing devnet SOL.
 */
import { PublicKey } from '@solana/web3.js';
import {
  encodeResolveMarket, encodeWithdrawInsurance, IX_TAG,
} from '../src/abi/instructions.js';
import {
  ACCOUNTS_RESOLVE_MARKET, ACCOUNTS_WITHDRAW_INSURANCE, buildAccountMetas,
} from '../src/abi/accounts.js';

console.log('Binary Market Instruction Verification');
console.log('======================================\n');

// Test 1: ResolveMarket encoding
console.log('1. ResolveMarket instruction:');
const resolveData = encodeResolveMarket();
console.log(`   Tag: ${IX_TAG.ResolveMarket} (expected: 19)`);
console.log(`   Data: [${Array.from(resolveData).join(', ')}]`);
console.log(`   Length: ${resolveData.length} bytes (expected: 1)`);
console.log(`   Accounts: ${ACCOUNTS_RESOLVE_MARKET.length} (expected: 2)`);
for (const acc of ACCOUNTS_RESOLVE_MARKET) {
  console.log(`     - ${acc.name}: signer=${acc.signer}, writable=${acc.writable}`);
}

// Test 2: WithdrawInsurance encoding
console.log('\n2. WithdrawInsurance instruction:');
const withdrawInsData = encodeWithdrawInsurance();
console.log(`   Tag: ${IX_TAG.WithdrawInsurance} (expected: 20)`);
console.log(`   Data: [${Array.from(withdrawInsData).join(', ')}]`);
console.log(`   Length: ${withdrawInsData.length} bytes (expected: 1)`);
console.log(`   Accounts: ${ACCOUNTS_WITHDRAW_INSURANCE.length} (expected: 6)`);
for (const acc of ACCOUNTS_WITHDRAW_INSURANCE) {
  console.log(`     - ${acc.name}: signer=${acc.signer}, writable=${acc.writable}`);
}

// Test 3: Account meta building
console.log('\n3. Account meta building:');
const dummyKeys = [
  new PublicKey('11111111111111111111111111111111'),
  new PublicKey('22222222222222222222222222222222222222222222'),
];
const resolveMetas = buildAccountMetas(ACCOUNTS_RESOLVE_MARKET, dummyKeys);
console.log(`   ResolveMarket metas: ${resolveMetas.length} accounts built`);

const withdrawKeys = [
  new PublicKey('11111111111111111111111111111111'),
  new PublicKey('22222222222222222222222222222222222222222222'),
  new PublicKey('33333333333333333333333333333333333333333333'),
  new PublicKey('44444444444444444444444444444444444444444444'),
  new PublicKey('55555555555555555555555555555555555555555555'),
  new PublicKey('66666666666666666666666666666666666666666666'),
];
const withdrawMetas = buildAccountMetas(ACCOUNTS_WITHDRAW_INSURANCE, withdrawKeys);
console.log(`   WithdrawInsurance metas: ${withdrawMetas.length} accounts built`);

// Verify
const allPassed =
  IX_TAG.ResolveMarket === 19 &&
  IX_TAG.WithdrawInsurance === 20 &&
  resolveData.length === 1 &&
  resolveData[0] === 19 &&
  withdrawInsData.length === 1 &&
  withdrawInsData[0] === 20 &&
  ACCOUNTS_RESOLVE_MARKET.length === 2 &&
  ACCOUNTS_WITHDRAW_INSURANCE.length === 6;

console.log('\n======================================');
if (allPassed) {
  console.log('✓ All binary market instructions verified!');
  console.log('\nCLI support for binary markets is ready.');
  console.log('Full integration test requires ~7 SOL for slab rent.');
} else {
  console.log('✗ Verification FAILED');
  process.exit(1);
}
