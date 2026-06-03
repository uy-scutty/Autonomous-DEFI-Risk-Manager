// frontend/app/activity/page.tsx
'use client';

import { useAccount } from 'wagmi';
import { motion } from 'framer-motion';
import { ActionFeed } from '@/components/ActionFeed';
import { Card } from '@/components/ui/Card';

export default function ActivityPage() {
  const { address, isConnected } = useAccount();

  if (!isConnected) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center py-20"
        >
          <h1 className="text-4xl font-heading font-bold mb-4">Activity Feed</h1>
          <p className="text-cyber-muted font-mono">
            Connect your wallet to view agent activity
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
          Agent Activity
        </h1>
        <p className="text-cyber-muted font-mono text-sm">
          Real-time action log & transaction history
        </p>
      </motion.div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <ActionFeed />
        </div>
        
        <div className="space-y-6">
          <Card>
            <h3 className="text-lg font-heading font-bold mb-4">Statistics</h3>
            <div className="space-y-3">
              <div className="bg-cyber-bg rounded-lg p-3 border border-cyber-border">
                <p className="text-cyber-muted text-sm">Total Actions</p>
                <p className="text-2xl font-mono font-bold text-cyber-cyan">247</p>
              </div>
              <div className="bg-cyber-bg rounded-lg p-3 border border-cyber-border">
                <p className="text-cyber-muted text-sm">Success Rate</p>
                <p className="text-2xl font-mono font-bold text-cyber-green">98.5%</p>
              </div>
              <div className="bg-cyber-bg rounded-lg p-3 border border-cyber-border">
                <p className="text-cyber-muted text-sm">Gas Saved</p>
                <p className="text-2xl font-mono font-bold text-cyber-cyan">Ξ 0.42</p>
              </div>
            </div>
          </Card>

          <Card>
            <h3 className="text-lg font-heading font-bold mb-4">Action Types</h3>
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-cyber-muted">Auto-Repay</span>
                <span className="font-mono text-cyber-text">89</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-cyber-muted">Auto-Borrow</span>
                <span className="font-mono text-cyber-text">67</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-cyber-muted">Deposits</span>
                <span className="font-mono text-cyber-text">45</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-cyber-muted">Alerts</span>
                <span className="font-mono text-cyber-red">12</span>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}