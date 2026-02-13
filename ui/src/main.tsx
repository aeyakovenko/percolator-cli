import { Buffer } from "buffer";
(window as any).Buffer = Buffer;

import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";

// Test: render something minimal first
try {
  const { ConnectionProvider, WalletProvider } = await import("@solana/wallet-adapter-react");
  const { WalletModalProvider } = await import("@solana/wallet-adapter-react-ui");
  const { PhantomWalletAdapter } = await import("@solana/wallet-adapter-phantom");

  await import("@solana/wallet-adapter-react-ui/styles.css");

  const { App } = await import("./App");

  const DEFAULT_RPC = "https://api.devnet.solana.com";
  const params = new URLSearchParams(window.location.search);
  const rpcUrl = params.get("rpc") || DEFAULT_RPC;

  function Root() {
    const wallets = useMemo(() => [new PhantomWalletAdapter()], []);
    return (
      <StrictMode>
        <ConnectionProvider endpoint={rpcUrl}>
          <WalletProvider wallets={wallets} autoConnect>
            <WalletModalProvider>
              <App />
            </WalletModalProvider>
          </WalletProvider>
        </ConnectionProvider>
      </StrictMode>
    );
  }

  createRoot(document.getElementById("root")!).render(<Root />);
} catch (err) {
  console.error("PROVENANCE BOOT ERROR:", err);
  document.getElementById("root")!.innerHTML =
    `<pre style="color:red;padding:2rem;font-size:14px">${err}\n\n${(err as any)?.stack || ""}</pre>`;
}
