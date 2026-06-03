// frontend/components/ui/Card.tsx
'use client';

import { motion } from 'framer-motion';
import { ReactNode } from 'react';

interface CardProps {
  children: ReactNode;
  className?: string;
  glow?: boolean;
  glowColor?: string;
}

export const Card = ({ children, className = '', glow = false, glowColor = '#00e5ff' }: CardProps) => {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className={`cyber-card relative overflow-hidden ${className}`}
      style={glow ? { boxShadow: `0 0 15px ${glowColor}40` } : undefined}
    >
      <div className="absolute inset-0 bg-gradient-to-br from-cyber-cyan/5 to-transparent pointer-events-none" />
      <div className="relative z-10">{children}</div>
    </motion.div>
  );
};

export const CardSkeleton = ({ className = '' }: { className?: string }) => {
  return (
    <div className={`cyber-card ${className}`}>
      <div className="space-y-4">
        <div className="skeleton h-6 w-1/3" />
        <div className="skeleton h-4 w-2/3" />
        <div className="skeleton h-32 w-full" />
        <div className="flex space-x-4">
          <div className="skeleton h-12 w-1/2" />
          <div className="skeleton h-12 w-1/2" />
        </div>
      </div>
    </div>
  );
};