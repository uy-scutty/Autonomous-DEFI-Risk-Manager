"use client";

import { useEffect, useRef } from "react";
import { getBandHex, formatHF, getHFBand } from "@/lib/formatters";

interface Props {
  healthFactor: number;
  size?: number;
}

export default function RiskMeter({ healthFactor, size = 220 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const band      = getHFBand(healthFactor);
  const color     = getBandHex(band);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = size, h = size;
    const cx = w / 2, cy = h * 0.62;
    const r  = w * 0.38;

    ctx.clearRect(0, 0, w, h);

    // Background arc
    ctx.beginPath();
    ctx.arc(cx, cy, r, Math.PI, 0);
    ctx.lineWidth   = 14;
    ctx.strokeStyle = "#1e1e2e";
    ctx.lineCap     = "round";
    ctx.stroke();

    // Gradient arc — always draw full spectrum background
    const segments = [
      { pct: 0.0,  color: "#ff1744" },
      { pct: 0.25, color: "#ff6d00" },
      { pct: 0.5,  color: "#ffea00" },
      { pct: 0.75, color: "#00e676" },
      { pct: 1.0,  color: "#00e676" },
    ];

    for (let i = 0; i < segments.length - 1; i++) {
      const startAngle = Math.PI + segments[i].pct     * Math.PI;
      const endAngle   = Math.PI + segments[i + 1].pct * Math.PI;
      const grad = ctx.createLinearGradient(
        cx + r * Math.cos(startAngle),
        cy + r * Math.sin(startAngle),
        cx + r * Math.cos(endAngle),
        cy + r * Math.sin(endAngle),
      );
      grad.addColorStop(0, segments[i].color);
      grad.addColorStop(1, segments[i + 1].color);
      ctx.beginPath();
      ctx.arc(cx, cy, r, startAngle, endAngle);
      ctx.lineWidth   = 14;
      ctx.strokeStyle = grad;
      ctx.lineCap     = "round";
      ctx.stroke();
    }

    // Needle
    // HF range: 1.0 (critical, left) → 3.0+ (safe, right)
    const hfClamped  = Math.min(Math.max(healthFactor, 1.0), 3.0);
    const pct        = (hfClamped - 1.0) / 2.0;
    const angle      = Math.PI + pct * Math.PI;
    const needleLen  = r * 0.85;
    const nx         = cx + needleLen * Math.cos(angle);
    const ny         = cy + needleLen * Math.sin(angle);

    // Needle glow
    ctx.shadowColor  = color;
    ctx.shadowBlur   = 16;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(nx, ny);
    ctx.lineWidth   = 3;
    ctx.strokeStyle = color;
    ctx.lineCap     = "round";
    ctx.stroke();
    ctx.shadowBlur  = 0;

    // Needle pivot
    ctx.beginPath();
    ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur  = 12;
    ctx.fill();
    ctx.shadowBlur  = 0;

    // Tick marks
    const ticks = [1.0, 1.4, 1.6, 2.0, 3.0];
    ctx.font      = `${size * 0.055}px 'JetBrains Mono'`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    ticks.forEach((val) => {
      const p   = (Math.min(val, 3.0) - 1.0) / 2.0;
      const ang = Math.PI + p * Math.PI;
      const tx1 = cx + (r - 18) * Math.cos(ang);
      const ty1 = cy + (r - 18) * Math.sin(ang);
      const tx2 = cx + (r - 10) * Math.cos(ang);
      const ty2 = cy + (r - 10) * Math.sin(ang);

      ctx.beginPath();
      ctx.moveTo(tx1, ty1);
      ctx.lineTo(tx2, ty2);
      ctx.lineWidth   = val === 1.0 || val === 3.0 ? 2 : 1;
      ctx.strokeStyle = "#6b6b8a";
      ctx.stroke();

      const labelR = r - 30;
      const lx = cx + labelR * Math.cos(ang);
      const ly = cy + labelR * Math.sin(ang);
      ctx.fillStyle = "#6b6b8a";
      ctx.fillText(val.toFixed(1), lx, ly);
    });

  }, [healthFactor, size]);

  return (
    <div className="flex flex-col items-center gap-2">
      <canvas ref={canvasRef} width={size} height={size * 0.7} />

      {/* HF value below needle */}
      <div className="text-center -mt-2">
        <div
          className="font-display font-bold text-5xl leading-none"
          style={{ color }}
        >
          {formatHF(healthFactor)}
        </div>
        <div className="font-mono text-xs text-faint mt-1 tracking-widest uppercase">
          Health Factor
        </div>
        <div
          className="mt-2 px-3 py-1 rounded-full text-xs font-mono font-medium border inline-block"
          style={{ color, borderColor: color + "40", background: color + "15" }}
        >
          {band}
        </div>
      </div>
    </div>
  );
}
