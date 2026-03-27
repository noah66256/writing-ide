/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: "#E84A0A",
        "brand-light": "#F5A623",
      },
    },
  },
  plugins: [],
};
