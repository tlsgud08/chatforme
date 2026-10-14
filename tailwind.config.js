/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'rgb(var(--color-bg) / <alpha-value>)',
        surface: 'rgb(var(--color-surface) / <alpha-value>)',
        surface2: 'rgb(var(--color-surface2) / <alpha-value>)',
        brand: 'rgb(var(--color-brand, 99 102 241) / <alpha-value>)',
      },
      maxWidth: {
        app: '480px',
      },
    },
  },
  plugins: [],
};
