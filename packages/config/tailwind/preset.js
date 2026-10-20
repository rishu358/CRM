/**
 * Shared Tailwind preset — the single source of design tokens (CLAUDE.md §9).
 *
 * Colour is a CSS variable so light and dark mode are one stylesheet and a
 * tenant-level theme can be layered on later without a rebuild. Components in
 * @crm/ui must only ever reference these semantic names, never raw hex values.
 *
 * Everything else a design system has an opinion about lives here too, because
 * overriding Tailwind's own scale (rather than inventing parallel names) is
 * what lets one change reach every `text-sm` and `shadow-md` already in the app:
 *
 *   type     a dense, data-first scale: 13px is the working size, because a CRM
 *            is read as tables and a 16px table is a table you scroll
 *   elevation three steps — resting, floating, overlay — and nothing between
 *   motion   two durations and one easing; nothing animates for decoration
 *   radius   controls < surfaces < dialogs, so nesting reads as nesting
 *
 * The rationale is in ADR-0031.
 */

/** @type {import('tailwindcss').Config} */
const preset = {
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    container: {
      center: true,
      padding: '1rem',
      screens: { '2xl': '1400px' },
    },
    /*
     * The scale replaces Tailwind's, deliberately: `text-sm` is the body size
     * here. Line heights sit on the 4px grid (16/20/22/24/28/32/40), and the
     * larger sizes tighten their tracking because optical spacing opens up as
     * type gets bigger.
     */
    fontSize: {
      '2xs': ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.01em' }],
      xs: ['0.75rem', { lineHeight: '1rem', letterSpacing: '0.005em' }],
      sm: ['0.8125rem', { lineHeight: '1.25rem' }],
      base: ['0.875rem', { lineHeight: '1.375rem' }],
      lg: ['1rem', { lineHeight: '1.5rem', letterSpacing: '-0.006em' }],
      xl: ['1.25rem', { lineHeight: '1.75rem', letterSpacing: '-0.014em' }],
      '2xl': ['1.5rem', { lineHeight: '2rem', letterSpacing: '-0.02em' }],
      '3xl': ['1.875rem', { lineHeight: '2.25rem', letterSpacing: '-0.024em' }],
    },
    extend: {
      colors: {
        border: 'hsl(var(--border) / <alpha-value>)',
        input: 'hsl(var(--input) / <alpha-value>)',
        ring: 'hsl(var(--ring) / <alpha-value>)',
        background: 'hsl(var(--background) / <alpha-value>)',
        foreground: 'hsl(var(--foreground) / <alpha-value>)',
        primary: {
          DEFAULT: 'hsl(var(--primary) / <alpha-value>)',
          foreground: 'hsl(var(--primary-foreground) / <alpha-value>)',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary) / <alpha-value>)',
          foreground: 'hsl(var(--secondary-foreground) / <alpha-value>)',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted) / <alpha-value>)',
          foreground: 'hsl(var(--muted-foreground) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent) / <alpha-value>)',
          foreground: 'hsl(var(--accent-foreground) / <alpha-value>)',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive) / <alpha-value>)',
          foreground: 'hsl(var(--destructive-foreground) / <alpha-value>)',
        },
        success: {
          DEFAULT: 'hsl(var(--success) / <alpha-value>)',
          foreground: 'hsl(var(--success-foreground) / <alpha-value>)',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning) / <alpha-value>)',
          foreground: 'hsl(var(--warning-foreground) / <alpha-value>)',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover) / <alpha-value>)',
          foreground: 'hsl(var(--popover-foreground) / <alpha-value>)',
        },
        card: {
          DEFAULT: 'hsl(var(--card) / <alpha-value>)',
          foreground: 'hsl(var(--card-foreground) / <alpha-value>)',
        },
      },
      borderRadius: {
        // sm: chips and badges · md: controls · lg: surfaces · xl: dialogs
        xl: 'calc(var(--radius) + 4px)',
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      /*
       * Three elevations. The tint is the ink colour, not black: a pure-black
       * shadow on a cool-tinted page reads as dirt.
       */
      boxShadow: {
        sm: '0 1px 2px 0 rgb(14 30 34 / 0.06)',
        md: '0 6px 16px -4px rgb(14 30 34 / 0.12), 0 2px 4px -2px rgb(14 30 34 / 0.06)',
        lg: '0 20px 44px -10px rgb(14 30 34 / 0.28), 0 6px 14px -6px rgb(14 30 34 / 0.14)',
        xl: '0 20px 44px -10px rgb(14 30 34 / 0.28), 0 6px 14px -6px rgb(14 30 34 / 0.14)',
      },
      transitionDuration: {
        fast: '120ms',
        base: '180ms',
      },
      transitionTimingFunction: {
        // Quick out, soft landing: things arrive, they do not bounce.
        DEFAULT: 'cubic-bezier(0.2, 0, 0, 1)',
        out: 'cubic-bezier(0.2, 0, 0, 1)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        // The only entrance motion: something the user just asked for, arriving.
        'pop-in': {
          from: { opacity: '0', transform: 'translateY(6px) scale(0.985)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'slide-in-left': {
          from: { transform: 'translateX(-100%)' },
          to: { transform: 'translateX(0)' },
        },
        // A skeleton breathes rather than flashes.
        shimmer: {
          '0%': { backgroundPosition: '200% 0' },
          '100%': { backgroundPosition: '-200% 0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'pop-in': 'pop-in 180ms cubic-bezier(0.2, 0, 0, 1)',
        'fade-in': 'fade-in 160ms ease-out',
        'slide-in-left': 'slide-in-left 220ms cubic-bezier(0.2, 0, 0, 1)',
        shimmer: 'shimmer 1.8s linear infinite',
      },
    },
  },
  plugins: [],
};

export default preset;
