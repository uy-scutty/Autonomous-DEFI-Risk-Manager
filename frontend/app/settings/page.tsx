// frontend/app/settings/page.tsx
'use client';

import { useAccount } from 'wagmi';
import { motion } from 'framer-motion';
import { ThresholdEditor } from '@/components/ThresholdEditor';
import { TelegramConnect } from '@/components/TelegramConnect';
import { Card } from '@/components/ui/Card';

export default function SettingsPage() {
  const { address, isConnected } = useAccount();

  if (!isConnected) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center py-20"
        >
          <h1 className="text-4xl font-heading font-bold mb-4">Agent Settings</h1>
          <p className="text-cyber-muted font-mono">
            Connect your wallet to configure your guardian agent
          </p>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="mb-8"
      >
        <h1 className="text-3xl font-heading font-bold mb-2">
          Agent Configuration
        </h1>
        <p className="text-cyber-muted font-mono text-sm">
          Customize your guardian agent's behavior and risk parameters
        </p>
      </motion.div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ThresholdEditor />
        
        <div className="space-y-6">
          <TelegramConnect />
          
          <Card>
            <h3 className="text-lg font-heading font-bold mb-4">Agent Preferences</h3>
            <div className="space-y-4">
              <div className="flex items-center justify-between bg-cyber-bg rounded-lg p-3 border border-cyber-border">
                <div>
                  <p className="text-cyber-text font-medium">Auto-Repay</p>
                  <p className="text-xs text-cyber-muted">Automatically repay debt when health factor drops</p>
                </div>
                <div className="w-12 h-6 rounded-full bg-cyber-green/20 border border-cyber-green/40 flex items-center">
                  <div className="w-5 h-5 rounded-full bg-cyber-green ml-5 transition-all duration-300" />
                </div>
              </div>

              <div className="flex items-center justify-between bg-cyber-bg rounded-lg p-3 border border-cyber-border">
                <div>
                  <p className="text-cyber-text font-medium">Auto-Borrow</p>
                  <p className="text-xs text-cyber-muted">Automatically borrow when rates are favorable</p>
                </div>
                <div className="w-12 h-6 rounded-full bg-cyber-muted/20 border border-cyber-border flex items-center">
                  <div className="w-5 h-5 rounded-full bg-cyber-muted ml-1 transition-all duration-300" />
                </div>
              </div>

              <div className="flex items-center justify-between bg-cyber-bg rounded-lg p-3 border border-cyber-border">
                <div>
                  <p className="text-cyber-text font-medium">Notifications</p>
                  <p className="text-xs text-cyber-muted">Receive alerts for all agent actions</p>
                </div>
                <div className="w-12 h-6 rounded-full bg-cyber-green/20 border border-cyber-green/40 flex items-center">
                  <div className="w-5 h-5 rounded-full bg-cyber-green ml-5 transition-all duration-300" />
                </div>
              </div>
            </div>
          </Card>

          <Card>
            <h3 className="text-lg font-heading font-bold mb-4">Contract Info</h3>
            <div className="space-y-3">
              <div className="bg-cyber-bg rounded-lg p-3 border border-cyber-border">
                <p className="text-cyber-muted text-xs mb-1">Aave Adapter</p>
                <p className="font-mono text-sm text-cyber-text truncate">
                  {process.env.NEXT_PUBLIC_AAVE_ADAPTER_ADDRESS || '0x0000...0000'}
                </p>
              </div>
              <div className="bg-cyber-bg rounded-lg p-3 border border-cyber-border">
                <p className="text-cyber-muted text-xs mb-1">Agent Registry</p>
                <p className="font-mono text-sm text-cyber-text truncate">
                  {process.env.NEXT_PUBLIC_AGENT_REGISTRY_ADDRESS || '0x0000...0000'}
                </p>
              </div>
              <div className="bg-cyber-bg rounded-lg p-3 border border-cyber-border">
                <p className="text-cyber-muted text-xs mb-1">Network</p>
                <p className="font-mono text-sm text-cyber-cyan">Arbitrum One</p>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}