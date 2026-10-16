import react from '@crm/config/eslint/react';

export default [
  ...react,
  { ignores: ['.next/**', 'next-env.d.ts', 'playwright.config.ts', 'e2e/**'] },
  {
    /**
     * The shared `no fetch` rule exists to stop ad-hoc data loading inside
     * components (CLAUDE.md §9). These two places are where fetch belongs: the
     * server route handlers, which are not components at all, and the data
     * layer those components call through. Narrowing the rule to its stated
     * intent, not switching it off — components are still covered.
     */
    files: ['src/app/api/**/*.ts', 'src/lib/**/*.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },
];
