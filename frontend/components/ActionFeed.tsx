// frontend/components/ActionFeed.tsx
'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { useAgentActivity } from '@/hooks/useAgentActivity';
import { formatTimestamp, formatAddress } from '@/lib/formatters';
import { Card } from './ui/Card';

const getActionIcon = (type: string) => {
  const icons = {
    REPAY: '↗️',
    BORROW: '↙️',
    WITHDRAW: '↘️',
    DEPOSIT: '↖️',
    WARNING: '⚠️',
    ALERT: '🚨',
  };
  return icons[type as keyof typeof icons] || '•';
};

const getStatusColor = (status: string) => {
  const colors = {
    SUCCESS: '#00e676',
    PENDING: '#ffea00',
    FAILED: '#ff1744',
  };
  return colors[status as keyof typeof colors] || '#6b6b8a';
};

export const ActionFeed = () => {
  const { data: activities, isLoading, isError } = useAgentActivity();

  if (isLoading) {
    return (
      <Card>
        <h3 className="text-xl font-heading font-bold mb-4">Recent Actions</h3>
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-20 w-full" />
          ))}
        </div>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card className="border-cyber-red/30">
        <div className="text-center py-8">
          <span className="text-4xl mb-4 block">⚠</span>
          <p className="text-cyber-red font-mono">Failed to load activity feed</p>
        </div>
      </Card>
    );
  }

  if (!activities || activities.length === 0) {
    return (
      <Card>
        <div className="text-center py-8">
          <span className="text-4xl mb-4 block">📭</span>
          <p className="text-cyber-muted font-mono mb-2">No Activity Yet</p>
          <p className="text-cyber-muted text-sm">
            Your agent's actions will appear here once it starts managing your position
          </p>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <AnimatePresence>
        {activities.slice(0, 10).map((activity, index) => (
          <motion.div
            key={activity.id}
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: index * 0.05 }}
            className="bg-cyber-surface border border-cyber-border rounded-lg p-4 
                       hover:border-cyber-cyan/30 transition-all duration-300"
          >
            <div className="flex items-start justify-between">
              <div className="flex items-start space-x-3">
                <span className="text-2xl">{getActionIcon(activity.type)}</span>
                <div>
                  <div className="flex items-center space-x-2">
                    <span className="font-heading font-bold text-cyber-text">
                      {activity.type}
                    </span>
                    <span 
                      className="px-2 py-0.5 rounded-full text-xs font-mono"
                      style={{
                        backgroundColor: `${getStatusColor(activity.status)}20`,
                        color: getStatusColor(activity.status),
                      }}
                    >
                      {activity.status}
                    </span>
                  </div>
                  <p className="text-cyber-muted text-sm mt-1">
                    {activity.amount} {activity.asset}
                  </p>
                  <div className="flex items-center space-x-2 mt-2 text-xs font-mono text-cyber-muted">
                    <span>{formatTimestamp(activity.timestamp)}</span>
                    <span>•</span>
                    <a 
                      href={`https://arbiscan.io/tx/${activity.txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-cyber-cyan hover:underline"
                    >
                      {formatAddress(activity.txHash)}
                    </a>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
};