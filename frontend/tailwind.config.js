// frontend/tailwind.config.js
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        "cyber-bg": "#050508",
        "cyber-surface": "#13131e",
        "cyber-border": "#1e1e2e",
        "cyber-cyan": "#00e5ff",
        "cyber-green": "#00e676",
        "cyber-yellow": "#ffea00",
        "cyber-orange": "#ff6d00",
        "cyber-red": "#ff1744",
        "cyber-text": "#e8e8f0",
        "cyber-muted": "#6b6b8a",
      },
      fontFamily: {
        heading: ["Syne", "sans-serif"],
        body: ["DM Sans", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
      boxShadow: {
        "cyber-glow": "0 0 15px rgba(0, 229, 255, 0.5)",
        "cyber-glow-green": "0 0 15px rgba(0, 230, 118, 0.5)",
        "cyber-glow-yellow": "0 0 15px rgba(255, 234, 0, 0.5)",
        "cyber-glow-orange": "0 0 15px rgba(255, 109, 0, 0.5)",
        "cyber-glow-red": "0 0 15px rgba(255, 23, 68, 0.5)",
      },
      animation: {
        "pulse-glow": "pulse-glow 2s ease-in-out infinite",
        "scan-line": "scan-line 8s linear infinite",
      },
      keyframes: {
        "pulse-glow": {
          "0%, 100%": { opacity: 0.5 },
          "50%": { opacity: 1 },
        },
        "scan-line": {
          "0%": { transform: "translateY(-100%)" },
          "100%": { transform: "translateY(100%)" },
        },
      },
    },
  },
  plugins: [],
};
