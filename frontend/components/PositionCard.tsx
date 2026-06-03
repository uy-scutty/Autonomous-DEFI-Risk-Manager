// frontend/components/PositionCard.tsx
'use client';

import { motion } from 'framer-motion';
import { formatUSD, formatPercentage } from '@/lib/formatters';
import { Card, CardSkeleton } from './ui/Card';

interface PositionCardProps {
  position: any;
  isLoading: boolean;
  isError: boolean;
}

export const PositionCard = ({ position, isLoading, isError }: PositionCardProps) => {
  if (isLoading) return <CardSkeleton />;

  if (isError) {
    return (
      <Card className="border-cyber-red/30">
        <div className="text-center py-8">
          <span className="text-4xl mb-4 block">⚠</span>
          <p className="text-cyber-red font-mono">Failed to load position data</p>
          <button className="cyber-button mt-4">Retry</button>
        </div>
      </Card>
    );
  }

  if (!position) {
    return (
      <Card>
        <div className="text-center py-8">
          <span className="text-4xl mb-4 block">📊</span>
          <p className="text-cyber-muted font-mono mb-2">No Active Position</p>
          <p className="text-cyber-muted text-sm">Connect your wallet and open an Aave position to get started</p>
        </div>
      </Card>
    );
  }

  const [collateral, debt, availableBorrows, liquidationThreshold, ltv, healthFactor] = position;
  const ltvPercentage = Number(formatPercentage(ltv));
  
  // Fix: Convert bigint subtraction to number for display
  const netWorthValue = (collateral as bigint) - (debt as bigint);
  // Use a separate function or inline formatting for the number
  const formatUSDNumber = (value: bigint): string => {
    const num = Number(value) / 1e8; // Adjust decimals based on your token
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(num);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.1 }}
    >
      <Card className="h-full">
        <h3 className="text-xl font-heading font-bold mb-6">Position Overview</h3>
        
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-cyber-bg rounded-lg p-4 border border-cyber-border">
              <p className="text-cyber-muted text-sm mb-2">Collateral</p>
              <p className="text-2xl font-mono font-bold text-cyber-text">
                {formatUSD(collateral)}
              </p>
            </div>
            
            <div className="bg-cyber-bg rounded-lg p-4 border border-cyber-border">
              <p className="text-cyber-muted text-sm mb-2">Debt</p>
              <p className="text-2xl font-mono font-bold text-cyber-text">
                {formatUSD(debt)}
              </p>
            </div>
          </div>

          <div>
            <div className="flex justify-between text-sm mb-2">
              <span className="text-cyber-muted">LTV</span>
              <span className={`font-mono font-bold ${
                ltvPercentage > 75 ? 'text-cyber-red' : 'text-cyber-green'
              }`}>
                {ltvPercentage}%
              </span>
            </div>
            <div className="w-full bg-cyber-bg rounded-full h-3 border border-cyber-border">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${ltvPercentage}%` }}
                transition={{ duration: 1, ease: "easeOut" }}
                className="h-full rounded-full"
                style={{
                  background: `linear-gradient(90deg, #00e676, ${
                    ltvPercentage > 75 ? '#ff1744' : ltvPercentage > 50 ? '#ffea00' : '#00e676'
                  })`,
                }}
              />
            </div>
            <div className="flex justify-between mt-2 text-xs font-mono text-cyber-muted">
              <span>0%</span>
              <span className="text-cyber-yellow">50%</span>
              <span className="text-cyber-red">75%</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="bg-cyber-bg rounded-lg p-4 border border-cyber-border">
              <p className="text-cyber-muted text-sm mb-2">Net Worth</p>
              <p className="text-xl font-mono font-bold text-cyber-cyan">
                {formatUSD(netWorthValue)}
              </p>
            </div>
            
            <div className="bg-cyber-bg rounded-lg p-4 border border-cyber-border">
              <p className="text-cyber-muted text-sm mb-2">Liq. Threshold</p>
              <p className="text-xl font-mono font-bold text-cyber-text">
                {formatPercentage(liquidationThreshold)}
              </p>
            </div>
          </div>

          <div className="bg-cyber-bg rounded-lg p-4 border border-cyber-border">
            <div className="flex justify-between items-center">
              <span className="text-cyber-muted text-sm">Available to Borrow</span>
              <span className="font-mono font-bold text-cyber-green text-lg">
                {formatUSD(availableBorrows)}
              </span>
            </div>
          </div>
        </div>
      </Card>
    </motion.div>
  );
};