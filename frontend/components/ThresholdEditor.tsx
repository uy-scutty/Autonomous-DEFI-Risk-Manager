// frontend/components/ThresholdEditor.tsx
'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { useAgentConfig } from '@/hooks/useAgentConfig';
import { Card } from './ui/Card';
import { parseUnits } from 'viem';

export const ThresholdEditor = () => {
  const { config, isLoading, updateConfig, isUpdating } = useAgentConfig();
  const [minHF, setMinHF] = useState('2.0');
  const [maxLTV, setMaxLTV] = useState('65');
  const [telegramId, setTelegramId] = useState('');

  const handleSave = () => {
    const hfBigInt = parseUnits(minHF, 18);
    const ltvBigInt = parseUnits((Number(maxLTV) / 100).toFixed(18), 18);
    updateConfig(hfBigInt, ltvBigInt, telegramId);
  };

  if (isLoading) {
    return (
      <Card>
        <div className="space-y-4">
          <div className="skeleton h-8 w-48" />
          <div className="skeleton h-12 w-full" />
          <div className="skeleton h-12 w-full" />
          <div className="skeleton h-12 w-full" />
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <h3 className="text-xl font-heading font-bold mb-6">Risk Thresholds</h3>
      
      <div className="space-y-6">
        <div>
          <label className="block text-sm text-cyber-muted mb-2 font-mono">
            Minimum Health Factor
          </label>
          <div className="flex items-center space-x-2">
            <input
              type="number"
              value={minHF}
              onChange={(e) => setMinHF(e.target.value)}
              step="0.1"
              min="1.0"
              max="5.0"
              className="cyber-input w-full"
              placeholder="2.0"
            />
            <span className="text-cyber-muted font-mono text-sm">HF</span>
          </div>
          <p className="text-xs text-cyber-muted mt-2">
            Agent will take action if health factor drops below this value
          </p>
        </div>

        <div>
          <label className="block text-sm text-cyber-muted mb-2 font-mono">
            Maximum LTV (%)
          </label>
          <div className="flex items-center space-x-2">
            <input
              type="number"
              value={maxLTV}
              onChange={(e) => setMaxLTV(e.target.value)}
              step="1"
              min="1"
              max="90"
              className="cyber-input w-full"
              placeholder="65"
            />
            <span className="text-cyber-muted font-mono text-sm">%</span>
          </div>
          <p className="text-xs text-cyber-muted mt-2">
            Agent will reduce debt if LTV exceeds this percentage
          </p>
        </div>

        <div>
          <label className="block text-sm text-cyber-muted mb-2 font-mono">
            Risk Bands
          </label>
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-cyber-bg rounded-lg p-3 border border-cyber-green/30">
              <span className="text-cyber-green text-sm font-mono">SAFE</span>
              <p className="text-cyber-text font-bold">HF ≥ 3.0</p>
            </div>
            <div className="bg-cyber-bg rounded-lg p-3 border border-cyber-yellow/30">
              <span className="text-cyber-yellow text-sm font-mono">WARNING</span>
              <p className="text-cyber-text font-bold">HF ≥ 1.6</p>
            </div>
            <div className="bg-cyber-bg rounded-lg p-3 border border-cyber-orange/30">
              <span className="text-cyber-orange text-sm font-mono">ACTION</span>
              <p className="text-cyber-text font-bold">HF ≥ 1.0</p>
            </div>
            <div className="bg-cyber-bg rounded-lg p-3 border border-cyber-red/30">
              <span className="text-cyber-red text-sm font-mono">CRITICAL</span>
              <p className="text-cyber-text font-bold">HF &lt; 1.0</p>
            </div>
          </div>
        </div>

        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={handleSave}
          disabled={isUpdating}
          className="cyber-button w-full"
        >
          {isUpdating ? 'Saving...' : 'Save Configuration'}
        </motion.button>
      </div>
    </Card>
  );
};