/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        display: ["'Syne'", "sans-serif"],
        mono:    ["'JetBrains Mono'", "monospace"],
        body:    ["'DM Sans'", "sans-serif"],
      },
      colors: {
        // Dark base
        void:    "#050508",
        surface: "#0d0d14",
        panel:   "#13131e",
        border:  "#1e1e2e",
        muted:   "#2a2a3d",

        // Brand accent — electric cyan
        cyan: {
          DEFAULT: "#00e5ff",
          dim:     "#00b8d4",
          glow:    "rgba(0,229,255,0.15)",
        },

        // Risk bands
        safe:     "#00e676",
        warning:  "#ffea00",
        action:   "#ff6d00",
        critical: "#ff1744",

        // Text
        ink:      "#e8e8f0",
        faint:    "#6b6b8a",
      },
      boxShadow: {
        cyan:     "0 0 24px rgba(0,229,255,0.25)",
        "cyan-lg":"0 0 48px rgba(0,229,255,0.2)",
        safe:     "0 0 20px rgba(0,230,118,0.3)",
        critical: "0 0 20px rgba(255,23,68,0.35)",
      },
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4,0,0.6,1) infinite",
        "scan-line":  "scanLine 2s linear infinite",
        "fade-in":    "fadeIn 0.4s ease forwards",
        "slide-up":   "slideUp 0.5s cubic-bezier(0.16,1,0.3,1) forwards",
      },
      keyframes: {
        scanLine: {
          "0%":   { transform: "translateY(-100%)" },
          "100%": { transform: "translateY(100%)" },
        },
        fadeIn: {
          from: { opacity: 0 },
          to:   { opacity: 1 },
        },
        slideUp: {
          from: { opacity: 0, transform: "translateY(16px)" },
          to:   { opacity: 1, transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};
