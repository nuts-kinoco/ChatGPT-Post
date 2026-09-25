/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/renderer/**/*.{html,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        base: "#121417",
        surface: "#1a1d21",
        raised: "#2a2e33",
        line: "#2a2e33",
        ink: "#e1e4e8",
        "ink-2": "#8b949e",
        "ink-3": "#6e7681",
        ok: "#2ea043",
        info: "#388bfd",
        warn: "#d29922",
        err: "#f85149",
      },
      fontFamily: {
        mono: ["IBM Plex Mono", "ui-monospace", "monospace"],
        sans: ["IBM Plex Sans JP", "system-ui", "sans-serif"],
      },
      keyframes: {
        ind: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(380px)" },
        },
      },
      animation: {
        ind: "ind 1.4s linear infinite",
      },
    },
  },
  plugins: [],
};
