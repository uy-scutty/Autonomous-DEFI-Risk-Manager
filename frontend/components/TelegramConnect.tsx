// frontend/components/TelegramConnect.tsx
'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { Card } from './ui/Card';

export const TelegramConnect = () => {
  const [telegramId, setTelegramId] = useState('');
  const [isConnected, setIsConnected] = useState(false);

  const handleConnect = () => {
    if (telegramId) {
      setIsConnected(true);
      // In production, this would initiate Telegram bot connection
    }
  };

  return (
    <Card>
      <h3 className="text-xl font-heading font-bold mb-4">Telegram Alerts</h3>
      
      <div className="space-y-4">
        <div className="flex items-center space-x-2 mb-4">
          <span className="text-2xl">🤖</span>
          <div>
            <p className="text-cyber-text font-medium">Guardian Bot</p>
            <p className="text-sm text-cyber-muted">@AaveGuardianBot</p>
          </div>
          <span className={`ml-auto w-2 h-2 rounded-full ${isConnected ? 'bg-cyber-green' : 'bg-cyber-muted'}`} />
        </div>

        {!isConnected ? (
          <>
            <input
              type="text"
              value={telegramId}
              onChange={(e) => setTelegramId(e.target.value)}
              placeholder="Enter your Telegram ID"
              className="cyber-input w-full"
            />
            
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={handleConnect}
              disabled={!telegramId}
              className="cyber-button w-full"
            >
              Connect Telegram
            </motion.button>
          </>
        ) : (
          <div className="bg-cyber-bg rounded-lg p-4 border border-cyber-green/30">
            <div className="flex items-center justify-between mb-2">
              <span className="text-cyber-muted text-sm">Status</span>
              <span className="text-cyber-green font-mono font-bold">Connected</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-cyber-muted text-sm">Telegram ID</span>
              <span className="text-cyber-text font-mono">{telegramId}</span>
            </div>
            <motion.button
              whileHover={{ scale: 1.02 }}
              onClick={() => setIsConnected(false)}
              className="cyber-button-danger w-full mt-3 text-sm"
            >
              Disconnect
            </motion.button>
          </div>
        )}

        <div className="text-xs text-cyber-muted space-y-1">
          <p>• Get instant alerts for critical health factor drops</p>
          <p>• Receive automated action confirmations</p>
          <p>• Monitor your position 24/7</p>
        </div>
      </div>
    </Card>
  );
};