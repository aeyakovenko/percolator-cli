import { Signal } from "../components/Signal";
import { useProgramTrust } from "../hooks/use-program-trust";
import { shortAddr } from "../lib/format";
import type { SlabSnapshot } from "../hooks/use-slab";
import {
  PROGRAM_ID,
  PASSIVE_MATCHER_PROGRAM,
  CREDIBILITY_MATCHER_PROGRAM,
  SLAB,
  SYSTEM_PROGRAM_STR,
  VERIFIED_BUILD_HASH,
  DEAD_INSTRUCTIONS,
} from "../config/market";
import styles from "./Verify.module.css";

interface VerifyProps {
  data: SlabSnapshot;
  rpcUrl: string;
}

const EXPLORER_BASE = "https://explorer.solana.com";
const CLUSTER_PARAM = "?cluster=devnet";

export function Verify({ data, rpcUrl }: VerifyProps) {
  const { header } = data;
  const adminBurned = header.admin.toBase58() === SYSTEM_PROGRAM_STR;

  const { programs } = useProgramTrust(rpcUrl, [
    PROGRAM_ID.toBase58(),
    PASSIVE_MATCHER_PROGRAM.toBase58(),
    CREDIBILITY_MATCHER_PROGRAM.toBase58(),
  ]);

  const credMatcher = programs.find(
    (p) => p.programId === CREDIBILITY_MATCHER_PROGRAM.toBase58()
  );

  return (
    <div className={styles.root}>
      <h2 className={styles.heading}>Verification</h2>
      <p className={styles.description}>
        Everything on this page is read directly from chain. Nothing is cached,
        nothing is self-reported.
      </p>

      {/* Section A: Admin burned */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>A. Admin Key</h3>
        <Signal
          label={adminBurned ? "Admin key burned" : "Admin key active"}
          healthy={adminBurned}
          detail={header.admin.toBase58()}
        />
        {adminBurned && (
          <p className={styles.note}>
            Admin is set to the system program ({SYSTEM_PROGRAM_STR.slice(0, 8)}...).
            No private key exists for this address. All admin-gated instructions
            are permanently disabled.
          </p>
        )}
        <a
          className={styles.link}
          href={`${EXPLORER_BASE}/address/${SLAB.toBase58()}${CLUSTER_PARAM}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          View slab on Explorer
        </a>
      </section>

      {/* Section B: Credibility matcher immutability */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>B. Credibility Matcher</h3>
        {credMatcher ? (
          <>
            <Signal
              label={
                credMatcher.upgradeable
                  ? "Upgrade authority active"
                  : "Upgrade authority burned"
              }
              healthy={!credMatcher.upgradeable}
              detail={
                credMatcher.upgradeable
                  ? `authority: ${credMatcher.upgradeAuthority ?? "unknown"}`
                  : "no authority — program is immutable"
              }
            />
            <a
              className={styles.link}
              href={`${EXPLORER_BASE}/address/${CREDIBILITY_MATCHER_PROGRAM.toBase58()}${CLUSTER_PARAM}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              View program on Explorer
            </a>
          </>
        ) : (
          <span className={styles.loading}>Checking program authority...</span>
        )}
      </section>

      {/* Section C: Dead instructions */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>C. Dead Instructions</h3>
        <p className={styles.note}>
          These instructions require the admin key as signer.
          Since admin = system program, they can never execute.
        </p>
        <div className={styles.deadList}>
          {DEAD_INSTRUCTIONS.map((ix) => (
            <div key={ix.tag} className={styles.deadItem}>
              <span className={styles.deadTag}>ix {ix.tag}</span>
              <span className={styles.deadName}>{ix.name}</span>
              <span className={styles.deadStatus}>
                {adminBurned ? "permanently disabled" : "active (admin required)"}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* Section D: Verified build */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>D. Verified Build</h3>
        <p className={styles.note}>
          The credibility matcher binary was verified with{" "}
          <code>solana-verify</code>. Anyone can reproduce the build from source.
        </p>
        <div className={styles.hashBlock}>
          <span className={styles.hashLabel}>Build hash</span>
          <code className={styles.hashValue}>{VERIFIED_BUILD_HASH}</code>
        </div>
        <div className={styles.codeBlock}>
          <code>
            solana-verify verify-from-repo
            --program-id {CREDIBILITY_MATCHER_PROGRAM.toBase58()}{" "}
            https://github.com/milla-provenance/provenance
            --mount-path matcher/credibility
            --library-name credibility_matcher
            -u devnet
          </code>
        </div>
        <a
          className={styles.link}
          href="https://github.com/milla-provenance/provenance/tree/master/matcher/credibility"
          target="_blank"
          rel="noopener noreferrer"
        >
          View source on GitHub
        </a>
      </section>

      {/* Section E: Program trust overview */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>E. Program Trust</h3>
        <p className={styles.note}>
          The market depends on these three programs. Immutability of all three
          is required for full trustlessness.
        </p>
        {programs.length === 0 && (
          <span className={styles.loading}>Checking program authorities...</span>
        )}
        {programs.map((p) => {
          const label =
            p.programId === PROGRAM_ID.toBase58()
              ? "percolator-prog (risk engine)"
              : p.programId === PASSIVE_MATCHER_PROGRAM.toBase58()
              ? "percolator-match (passive LP)"
              : "credibility-matcher (Provenance)";

          return (
            <div key={p.programId} className={styles.programRow}>
              <Signal
                label={`${label}: ${p.upgradeable ? "upgradeable" : "immutable"}`}
                healthy={!p.upgradeable}
                detail={
                  p.upgradeable
                    ? `authority: ${p.upgradeAuthority ? shortAddr(p.upgradeAuthority) : "unknown"}`
                    : "upgrade authority burned"
                }
              />
              <a
                className={styles.link}
                href={`${EXPLORER_BASE}/address/${p.programId}${CLUSTER_PARAM}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {shortAddr(p.programId)}
              </a>
            </div>
          );
        })}
        {programs.some((p) => p.upgradeable) && (
          <div className={styles.warningBox}>
            <strong>Honest disclosure:</strong> Some upstream programs are still
            upgradeable by a single key. Market-level immutability protects
            against parameter changes, but program logic could theoretically be
            altered by the upgrade authority holder.
          </div>
        )}
      </section>
    </div>
  );
}
