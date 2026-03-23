/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        set: {
          architect: '#8B5CF6',
          backend: '#22C55E',
          frontend: '#3B82F6',
          qa: '#EAB308',
          devops: '#F97316',
          security: '#EF4444',
          design: '#EC4899',
          data: '#06B6D4',
        },
      },
    },
  },
  plugins: [],
}
