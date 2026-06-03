// frontend/components/AgentStatusBadge.tsx
'use client';

import { motion } from 'framer-motion';
import { useAgentHealth } from '@/hooks/useAgentHealth';
import { Card } from './ui/Card';

export const AgentStatusBadge = () => {
  const { data: health, isLoading, isError } = useAgentHealth();

  const getStatusDisplay = () => {
    if (isLoading) {
      return {
        icon: '⏳',
        color: '#6b6b8a',
        glowColor: '#6b6b8a',
        text: 'Connecting...',
        subtext: 'Checking agent server',
      };
    }

    if (isError || !health) {
      return {
        icon: '🔴',
        color: '#ff1744',
        glowColor: '#ff1744',
        text: 'Offline',
        subtext: 'Agent server unreachable',
      };
    }

    return {
      icon: '🟢',
      color: '#00e676',
      glowColor: '#00e676',
      text: 'Active',
      subtext: `Last checked: ${new Date().toLocaleTimeString()}`,
    };
  };

  const status = getStatusDisplay();

  return (
    <Card glow glowColor={status.glowColor}>
      <h3 className="text-xl font-heading font-bold mb-4">Agent Status</h3>
      
      <div className="flex items-center space-x-4 mb-4">
        <motion.span
          animate={{ scale: [1, 1.2, 1] }}
          transition={{ duration: 2, repeat: Infinity }}
          className="text-4xl"
        >
          {status.icon}
        </motion.span>
        
        <div>
          <p className="text-lg font-heading font-bold" style={{ color: status.color }}>
            {status.text}
          </p>
          <p className="text-sm text-cyber-muted font-mono">{status.subtext}</p>
        </div>
      </div>

      {health && (
        <div className="space-y-2">
          <div className="bg-cyber-bg rounded-lg p-3 border border-cyber-border">
            <div className="flex justify-between text-sm">
              <span className="text-cyber-muted">Uptime</span>
              <span className="font-mono text-cyber-text">
                {health.uptime || 'N/A'}
              </span>
            </div>
          </div>
          
          <div className="bg-cyber-bg rounded-lg p-3 border border-cyber-border">
            <div className="flex justify-between text-sm">
              <span className="text-cyber-muted">Active Agents</span>
              <span className="font-mono text-cyber-text">
                {health.activeAgents || '0'}
              </span>
            </div>
          </div>
        </div>
      )}

      <motion.button
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        className="w-full mt-4 cyber-button text-sm"
        onClick={() => window.location.reload()}
      >
        Refresh Status
      </motion.button>
    </Card>
  );
};