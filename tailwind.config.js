/** @type {import('tailwindcss').Config} */
// Build-time Tailwind (v3, the same major version the CDN play script
// served), with exactly the theme extension index.html used to carry.
export default {
  content: ['./index.html', './App.tsx', './index.tsx', './components/**/*.{ts,tsx}', './services/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        display: ['Oswald', 'sans-serif']
      },
      colors: {
        neutral: {
          50: '#fafafa',
          100: '#f5f5f5',
          200: '#e5e5e5',
          300: '#d4d4d4',
          400: '#a3a3a3',
          500: '#737373',
          600: '#525252',
          700: '#404040',
          800: '#262626',
          900: '#171717',
          950: '#0a0a0a'
        },
        orange: {
          500: '#f97316',
          600: '#ea580c',
          700: '#c2410c'
        }
      }
    }
  },
  plugins: []
};
