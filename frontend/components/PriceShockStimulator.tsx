// frontend/components/PriceShockSimulator.tsx
'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { useReadContract } from 'wagmi';
import { useAccount } from 'wagmi';
import { AAVE_ADAPTER_ADDRESS, AAVE_ADAPTER_ABI } from '@/lib/contracts';
import { formatHealthFactor } from '@/lib/formatters';
import { Card } from './ui/Card';

export const PriceShockSimulator = () => {
  const { address } = useAccount();
  const [shockPercentage, setShockPercentage] = useState(0);
  const [debouncedShock, setDebouncedShock] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedShock(shockPercentage), 300);
    return () => clearTimeout(timer);
  }, [shockPercentage]);

  const { data: simulatedHF, isLoading } = useReadContract({
    address: AAVE_ADAPTER_ADDRESS as `0x${string}`,
    abi: AAVE_ADAPTER_ABI,
    functionName: 'simulateHFAfterPriceShock',
    args: address ? [address, BigInt(debouncedShock * 100)] : undefined,
    query: {
      enabled: !!address && debouncedShock !== 0,
    },
  });

  const getShockColor = (value: number) => {
    if (value <= -30) return '#ff1744';
    if (value <= -10) return '#ff6d00';
    if (value <= 10) return '#00e5ff';
    if (value <= 30) return '#ffea00';
    return '#00e676';
  };

  const getRiskColor = (hf: string) => {
    const num = parseFloat(hf);
    if (num >= 3.0) return '#00e676';
    if (num >= 1.6) return '#ffea00';
    if (num >= 1.0) return '#ff6d00';
    return '#ff1744';
  };

  return (
    <Card>
      <h3 className="text-xl font-heading font-bold mb-4">Price Shock Simulator</h3>
      
      <div className="mb-6">
        <div className="flex justify-between text-sm mb-2">
          <span className="text-cyber-muted font-mono">-50%</span>
          <span className="font-mono font-bold" style={{ color: getShockColor(shockPercentage) }}>
            {shockPercentage > 0 ? '+' : ''}{shockPercentage}%
          </span>
          <span className="text-cyber-muted font-mono">+50%</span>
        </div>
        
        <input
          type="range"
          min="-50"
          max="50"
          value={shockPercentage}
          onChange={(e) => setShockPercentage(Number(e.target.value))}
          className="w-full h-2 bg-cyber-bg rounded-lg appearance-none cursor-pointer 
                     border border-cyber-border accent-cyber-cyan"
        />
      </div>

      {simulatedHF && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="bg-cyber-bg rounded-lg p-4 border border-cyber-border"
        >
          <div className="flex justify-between items-center">
            <span className="text-cyber-muted text-sm">Simulated Health Factor</span>
            <span 
              className="text-2xl font-mono font-bold"
              style={{ color: getRiskColor(formatHealthFactor(simulatedHF)) }}
            >
              {formatHealthFactor(simulatedHF)}
            </span>
          </div>
        </motion.div>
      )}

      {isLoading && (
        <div className="bg-cyber-bg rounded-lg p-4 border border-cyber-border">
          <div className="flex justify-center">
            <div className="animate-spin rounded-full h-6 w-6 border-2 border-cyber-cyan border-t-transparent" />
          </div>
        </div>
      )}

      {!address && (
        <div className="text-center py-4">
          <p className="text-cyber-muted text-sm">Connect wallet to simulate price shocks</p>
        </div>
      )}
    </Card>
  );
};