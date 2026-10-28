/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        neon: {
          green: '#39ff14',
          pink: '#ff00ff',
          cyan: '#00e5ff',
          amber: '#ffaa00',
          dark: '#050505',
          panel: '#0a0e0a',
          border: '#1b4d1b',
          muted: '#246b24',
        }
      },
      fontFamily: {
        mono: ['Fira Code', 'VT323', 'Courier New', 'monospace'],
      },
      boxShadow: {
        'neon-green': '0 0 10px rgba(57, 255, 20, 0.4), 0 0 20px rgba(57, 255, 20, 0.2)',
        'neon-pink': '0 0 10px rgba(255, 0, 255, 0.4), 0 0 20px rgba(255, 0, 255, 0.2)',
        'neon-cyan': '0 0 10px rgba(0, 229, 255, 0.4), 0 0 20px rgba(0, 229, 255, 0.2)',
        'neon-amber': '0 0 10px rgba(255, 170, 0, 0.4), 0 0 20px rgba(255, 170, 0, 0.2)',
      }
    },
  },
  plugins: [],
};

