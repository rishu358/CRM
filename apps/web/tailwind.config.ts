import type { Config } from 'tailwindcss';
import preset from '@crm/config/tailwind';

const config: Config = {
  presets: [preset],
  content: [
    './src/**/*.{ts,tsx}',
    // The shared design system ships source, so its classes must be scanned too.
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
};

export default config;
