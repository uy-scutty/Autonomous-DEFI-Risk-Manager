"use client";

import "./globals.css";
import "@rainbow-me/rainbowkit/styles.css";

import { ReactNode }             from "react";
import { WagmiProvider }         from "wagmi";
import { RainbowKitProvider }    from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { wagmiConfig }           from "@/lib/wagmiConfig";
import Navbar                    from "@/components/Navbar";

const queryClient = new QueryClient();

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <title>DeFi Risk Manager — Aave Guardian</title>
        <meta name="description" content="Autonomous AI agent protecting your Aave positions on Arbitrum" />
        <meta name="viewport"    content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
      </head>
      <body className="bg-void text-ink font-body antialiased">
        <WagmiProvider config={wagmiConfig}>
          <QueryClientProvider client={queryClient}>
            <RainbowKitProvider>
              <div className="min-h-screen flex flex-col">
                <Navbar />
                <main className="flex-1 max-w-6xl mx-auto w-full px-4 py-8">
                  {children}
                </main>
                <footer className="border-t border-border py-4 text-center text-faint text-xs font-mono">
                  AUTONOMOUS DEFI RISK MANAGER · ARBITRUM · AAVE GUARDIAN
                </footer>
              </div>
            </RainbowKitProvider>
          </QueryClientProvider>
        </WagmiProvider>
      </body>
    </html>
  );
}
