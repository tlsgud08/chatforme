/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0f172a',
        surface: '#1e293b',
        surface2: '#334155',
        brand: '#6366f1',
      },
      maxWidth: {
        app: '480px',
      },
    },
  },
  plugins: [],
};
