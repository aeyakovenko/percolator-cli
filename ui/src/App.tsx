import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Layout, type Screen } from "./components/Layout";
import { useSlab } from "./hooks/use-slab";
import { useMatcherCtx } from "./hooks/use-matcher-ctx";
import { Overview } from "./screens/Overview";
import { Insurance } from "./screens/Insurance";
import { Risk } from "./screens/Risk";
import { Verify } from "./screens/Verify";
import { Trade } from "./screens/Trade";
import styles from "./App.module.css";

// Defaults -- override with query params ?slab=...
const DEFAULT_SLAB = "75h2kF58m3ms77c8WwzQh6h4iT2XMA1F5Mk13FZ6CCUs";

function getParams(): { slab: string } {
  const params = new URLSearchParams(window.location.search);
  return {
    slab: params.get("slab") || DEFAULT_SLAB,
  };
}

export function App() {
  const [screen, setScreen] = useState<Screen>("overview");
  const { slab } = getParams();
  const { connection } = useConnection();
  const wallet = useWallet();
  const rpc = connection.rpcEndpoint;

  const { data, error, loading, history } = useSlab(rpc, slab, 5_000);
  const matcherCtx = useMatcherCtx(rpc);

  // No slab address configured
  if (!slab) {
    return (
      <Layout activeScreen={screen} onNavigate={setScreen}>
        <div className={styles.status}>
          <p className={styles.statusTitle}>No market configured</p>
          <p className={styles.statusDetail}>
            Pass the slab account address as a query parameter:
          </p>
          <code className={styles.code}>
            ?slab=YOUR_SLAB_ADDRESS&rpc=https://api.devnet.solana.com
          </code>
        </div>
      </Layout>
    );
  }

  // Loading state
  if (loading && !data) {
    return (
      <Layout activeScreen={screen} onNavigate={setScreen}>
        <div className={styles.status}>
          <p className={styles.statusDetail}>Fetching slab data...</p>
        </div>
      </Layout>
    );
  }

  // Error state
  if (error && !data) {
    return (
      <Layout activeScreen={screen} onNavigate={setScreen}>
        <div className={styles.status}>
          <p className={styles.statusTitle}>Error</p>
          <p className={styles.statusDetail}>{error}</p>
        </div>
      </Layout>
    );
  }

  if (!data) return null;

  return (
    <Layout activeScreen={screen} onNavigate={setScreen}>
      {screen === "overview" && <Overview data={data} rpcUrl={rpc} />}
      {screen === "insurance" && <Insurance data={data} history={history} />}
      {screen === "risk" && <Risk data={data} matcherCtx={matcherCtx} />}
      {screen === "verify" && <Verify data={data} rpcUrl={rpc} />}
      {screen === "trade" && (
        <Trade
          data={data}
          matcherCtx={matcherCtx}
          connection={connection}
          wallet={wallet}
        />
      )}
    </Layout>
  );
}
