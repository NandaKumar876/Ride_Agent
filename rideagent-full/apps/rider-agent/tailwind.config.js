/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        mono: ["Space Mono", "monospace"],
        sans: ["DM Sans", "sans-serif"],
      },
      colors: {
        bg:      "#0a0e1a",
        surface: "#111827",
        card:    "#161d2e",
        border:  "#1e2d47",
        accent:  "#3b82f6",   // blue — rider theme
        green:   "#00d4aa",
        warn:    "#f59e0b",
        danger:  "#ef4444",
        muted:   "#64748b",
        text:    "#e2e8f0",
      },
    },
  },
  plugins: [],
};
