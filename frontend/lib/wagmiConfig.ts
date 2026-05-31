"use client";

import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { arbitrum, arbitrumSepolia } from "wagmi/chains";

// Robinhood Chain testnet — added for hackathon Robinhood track
const robinhoodChain = {
  id:   7472,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://testnet.rpc.robinhood.com"] },
    public:  { http: ["https://testnet.rpc.robinhood.com"] },
  },
  blockExplorers: {
    default: { name: "Explorer", url: "https://testnet.explorer.robinhood.com" },
  },
  testnet: true,
} as const;

export const wagmiConfig = getDefaultConfig({
  appName:   "Autonomous DeFi Risk Manager",
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "demo",
  chains:    [arbitrumSepolia, arbitrum, robinhoodChain],
  ssr:       true,
});

export { arbitrum, arbitrumSepolia };
