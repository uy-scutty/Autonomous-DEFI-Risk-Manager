// frontend/components/RiskMeter.tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { getRiskLevel } from '@/lib/formatters';

interface RiskMeterProps {
  healthFactor: number;
  isLoading: boolean;
}

export const RiskMeter = ({ healthFactor, isLoading }: RiskMeterProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [riskLevel, setRiskLevel] = useState<'SAFE' | 'WARNING' | 'ACTION' | 'CRITICAL'>('SAFE');

  useEffect(() => {
    setRiskLevel(getRiskLevel(healthFactor));
  }, [healthFactor]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const centerX = rect.width / 2;
    const centerY = rect.height * 0.8;
    const radius = Math.min(rect.width, rect.height) * 0.7;

    const drawTickMarks = () => {
      const tickValues = [0, 1.0, 1.4, 1.6, 2.0, 3.0, 5.0];
      tickValues.forEach((value) => {
        const angle = Math.PI - (value / 5.0) * Math.PI;
        const x = centerX + radius * Math.cos(angle);
        const y = centerY - radius * Math.sin(angle);

        ctx.beginPath();
        ctx.arc(x, y, 4, 0, 2 * Math.PI);
        ctx.fillStyle = getTickColor(value);
        ctx.fill();

        ctx.font = '12px "JetBrains Mono"';
        ctx.fillStyle = '#6b6b8a';
        ctx.textAlign = 'center';
        ctx.fillText(value.toFixed(1), x, y + 20);
      });
    };

    const getTickColor = (value: number) => {
      if (value >= 3.0) return '#00e676';
      if (value >= 1.6) return '#ffea00';
      if (value >= 1.0) return '#ff6d00';
      return '#ff1744';
    };

    const drawGauge = () => {
      ctx.clearRect(0, 0, rect.width, rect.height);

      // Background arc
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius, Math.PI, 0);
      ctx.strokeStyle = '#1e1e2e';
      ctx.lineWidth = 20;
      ctx.stroke();

      // Gradient arc based on risk
      const gradient = ctx.createLinearGradient(0, 0, rect.width, 0);
      gradient.addColorStop(0, '#00e676');
      gradient.addColorStop(0.3, '#ffea00');
      gradient.addColorStop(0.6, '#ff6d00');
      gradient.addColorStop(1, '#ff1744');

      const currentAngle = Math.PI - (healthFactor / 5.0) * Math.PI;
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius, Math.PI, currentAngle);
      ctx.strokeStyle = gradient;
      ctx.lineWidth = 20;
      ctx.lineCap = 'round';
      ctx.stroke();

      // Glow effect
      ctx.shadowColor = getTickColor(healthFactor);
      ctx.shadowBlur = 30;

      // Needle
      const needleAngle = currentAngle;
      const needleLength = radius * 0.9;
      const needleX = centerX + needleLength * Math.cos(needleAngle);
      const needleY = centerY - needleLength * Math.sin(needleAngle);

      ctx.beginPath();
      ctx.moveTo(centerX, centerY);
      ctx.lineTo(needleX, needleY);
      ctx.strokeStyle = getTickColor(healthFactor);
      ctx.lineWidth = 3;
      ctx.stroke();

      // Needle center
      ctx.beginPath();
      ctx.arc(centerX, centerY, 8, 0, 2 * Math.PI);
      ctx.fillStyle = '#00e5ff';
      ctx.fill();
      ctx.shadowBlur = 0;

      // Risk band indicators
      const bands = [
        { range: 'CRITICAL', color: '#ff1744', start: 0, end: 1.0 },
        { range: 'ACTION', color: '#ff6d00', start: 1.0, end: 1.6 },
        { range: 'WARNING', color: '#ffea00', start: 1.6, end: 3.0 },
        { range: 'SAFE', color: '#00e676', start: 3.0, end: 5.0 },
      ];

      bands.forEach((band) => {
        const startAngle = Math.PI - (band.start / 5.0) * Math.PI;
        const endAngle = Math.PI - (band.end / 5.0) * Math.PI;
        const midAngle = (startAngle + endAngle) / 2;
        const labelRadius = radius * 0.65;
        const labelX = centerX + labelRadius * Math.cos(midAngle);
        const labelY = centerY - labelRadius * Math.sin(midAngle);

        ctx.font = '10px "JetBrains Mono"';
        ctx.fillStyle = band.color;
        ctx.textAlign = 'center';
        ctx.fillText(band.range, labelX, labelY);
      });

      drawTickMarks();

      // Health factor value
      ctx.font = '48px "Syne"';
      ctx.fillStyle = '#e8e8f0';
      ctx.textAlign = 'center';
      const displayHF = healthFactor === Infinity ? '∞' : healthFactor.toFixed(2);
      ctx.fillText(displayHF, centerX, centerY - 80);

      ctx.font = '14px "DM Sans"';
      ctx.fillStyle = '#6b6b8a';
      ctx.fillText('HEALTH FACTOR', centerX, centerY - 50);
    };

    const animate = () => {
      drawGauge();
      requestAnimationFrame(animate);
    };

    animate();

    return () => {
      // Cleanup
    };
  }, [healthFactor]);

  if (isLoading) {
    return (
      <div className="cyber-card">
        <div className="space-y-4">
          <div className="skeleton h-8 w-48" />
          <div className="skeleton h-64 w-full rounded-lg" />
        </div>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.5 }}
      className="cyber-card"
    >
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xl font-heading font-bold">Risk Meter</h3>
        <span
          className="px-3 py-1 rounded-full text-sm font-mono font-bold"
          style={{
            backgroundColor: `${getRiskColor(riskLevel)}20`,
            color: getRiskColor(riskLevel),
            border: `1px solid ${getRiskColor(riskLevel)}40`,
          }}
        >
          {riskLevel}
        </span>
      </div>
      <canvas
        ref={canvasRef}
        className="w-full aspect-square"
        style={{ maxHeight: '400px' }}
      />
    </motion.div>
  );
};

function getRiskColor(level: string): string {
  const colors = {
    SAFE: '#00e676',
    WARNING: '#ffea00',
    ACTION: '#ff6d00',
    CRITICAL: '#ff1744',
  };
  return colors[level as keyof typeof colors] || '#6b6b8a';
}