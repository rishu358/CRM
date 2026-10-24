import base from '@crm/config/eslint';

export default [
  ...base,
  {
    // The one file in the application allowed to read process.env (ADR-0044). Everything else asks
    // `loadEnv(scope)`, and the base config forbids `process.env` everywhere else.
    files: ['src/process-env.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
];
