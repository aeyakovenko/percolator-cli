//! Devnet-only mock price feed for the percolator-lean OracleAdapter suite.
//! accounts: [feed (writable, owned by this program), authority (signer)]
//! data: bytes written verbatim at feed[0..data.len()] (max 32).
//! feed[32..64] holds the authority; the first write claims it.
use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult,
    program_error::ProgramError, pubkey::Pubkey,
};

entrypoint!(process);

fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let [feed, auth, ..] = accounts else { return Err(ProgramError::NotEnoughAccountKeys) };
    if feed.owner != program_id { return Err(ProgramError::IllegalOwner); }
    if !auth.is_signer { return Err(ProgramError::MissingRequiredSignature); }
    if data.len() > 32 { return Err(ProgramError::InvalidInstructionData); }
    let mut d = feed.try_borrow_mut_data()?;
    if d.len() < 64 { return Err(ProgramError::AccountDataTooSmall); }
    if d[32..64].iter().all(|b| *b == 0) {
        d[32..64].copy_from_slice(auth.key.as_ref());
    } else if &d[32..64] != auth.key.as_ref() {
        return Err(ProgramError::IllegalOwner);
    }
    d[..data.len()].copy_from_slice(data);
    Ok(())
}
