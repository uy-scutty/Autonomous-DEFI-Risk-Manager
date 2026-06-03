// frontend/lib/formatters.ts
import { formatUnits } from 'viem';

export const formatHealthFactor = (hf: bigint): string => {
  if (hf === BigInt('115792089237316195423570985008687907853269984665640564039457584007913129639935')) {
    return '∞';
  }
  return Number(formatUnits(hf, 18)).toFixed(2);
};

export const formatUSD = (value: bigint): string => {
  const num = Number(formatUnits(value, 8));
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num);
};

export const formatPercentage = (value: bigint): string => {
  return (Number(formatUnits(value, 18)) * 100).toFixed(2) + '%';
};

export const getRiskLevel = (healthFactor: number): 'SAFE' | 'WARNING' | 'ACTION' | 'CRITICAL' => {
  if (healthFactor >= 3.0) return 'SAFE';
  if (healthFactor >= 1.6) return 'WARNING';
  if (healthFactor >= 1.0) return 'ACTION';
  return 'CRITICAL';
};

export const getRiskColor = (level: 'SAFE' | 'WARNING' | 'ACTION' | 'CRITICAL'): string => {
  const colors = {
    SAFE: '#00e676',
    WARNING: '#ffea00',
    ACTION: '#ff6d00',
    CRITICAL: '#ff1744',
  };
  return colors[level];
};

export const formatAddress = (address: string): string => {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
};

export const formatTimestamp = (timestamp: number): string => {
  return new Date(timestamp * 1000).toLocaleString();
};