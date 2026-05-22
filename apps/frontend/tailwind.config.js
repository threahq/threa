/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  // Gate hover: utilities behind @media (hover: hover) so touch taps don't leave
  // a stuck hover state until the next tap elsewhere.
  future: {
    hoverOnlyWhenSupported: true,
  },
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Space Grotesk", "system-ui", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
        chart: {
          1: "hsl(var(--chart-1))",
          2: "hsl(var(--chart-2))",
          3: "hsl(var(--chart-3))",
          4: "hsl(var(--chart-4))",
          5: "hsl(var(--chart-5))",
        },
        activity: {
          people: "hsl(var(--activity-people))",
        },
      },
      borderRadius: {
        modal: "16px",
        card: "12px",
        input: "12px",
        button: "10px",
        item: "8px",
        avatar: "8px",
        pill: "20px",
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: {
            height: "0",
          },
          to: {
            height: "var(--radix-accordion-content-height)",
          },
        },
        "accordion-up": {
          from: {
            height: "var(--radix-accordion-content-height)",
          },
          to: {
            height: "0",
          },
        },
        "fade-in": {
          from: {
            opacity: "0",
          },
          to: {
            opacity: "1",
          },
        },
        "highlight-flash": {
          "0%": {
            backgroundColor: "hsl(var(--primary) / 0.3)",
          },
          "100%": {
            backgroundColor: "transparent",
          },
        },
        "new-message-fade": {
          "0%": {
            backgroundColor: "hsl(var(--primary) / 0.08)",
          },
          "100%": {
            backgroundColor: "transparent",
          },
        },
        "activity-pulse": {
          "0%, 100%": {
            opacity: "1",
          },
          "50%": {
            opacity: "0.4",
          },
        },
        "indeterminate-progress": {
          "0%": {
            transform: "translateX(-100%)",
          },
          "100%": {
            transform: "translateX(400%)",
          },
        },
        "topbar-shimmer": {
          "0%": {
            transform: "translateX(-100%)",
          },
          "50%": {
            transform: "translateX(300%)",
          },
          "100%": {
            transform: "translateX(-100%)",
          },
        },
        "ariadne-breathe": {
          "0%, 100%": {
            transform: "scale(1)",
            filter: "drop-shadow(0 0 2px hsl(var(--primary) / 0.2))",
          },
          "50%": {
            transform: "scale(1.04)",
            filter: "drop-shadow(0 0 6px hsl(var(--primary) / 0.5))",
          },
        },
        "ariadne-ripple": {
          "0%, 100%": {
            transform: "scale(1)",
            opacity: "0.15",
          },
          "50%": {
            transform: "scale(1.08)",
            opacity: "0",
          },
        },
        "thread-weave": {
          "0%": { transform: "translateY(-110%)" },
          "100%": { transform: "translateY(420%)" },
        },
        "thread-grow": {
          "0%": { transform: "scaleY(0)", opacity: "0" },
          "60%": { opacity: "1" },
          "100%": { transform: "scaleY(1)", opacity: "1" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "fade-in-delayed": "fade-in 0.2s ease-out 0.5s forwards",
        "highlight-flash": "highlight-flash 2s ease-out forwards",
        "new-message-fade": "new-message-fade 2s ease-out forwards",
        "activity-pulse": "activity-pulse 2s ease-in-out infinite",
        "indeterminate-progress": "indeterminate-progress 1.5s ease-in-out infinite",
        "topbar-shimmer": "topbar-shimmer 2s ease-in-out infinite",
        "ariadne-breathe": "ariadne-breathe 2s ease-in-out infinite",
        "ariadne-ripple": "ariadne-ripple 2s ease-in-out infinite",
        "thread-weave": "thread-weave 2.2s ease-in-out infinite",
        "thread-grow": "thread-grow 450ms cubic-bezier(0.22, 1, 0.36, 1) forwards",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
}
