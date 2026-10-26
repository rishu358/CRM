import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import { base } from './index.js';

/**
 * React/Next.js layer on top of the shared base.
 * The a11y rules are errors, not warnings: WCAG 2.1 AA is a spec requirement
 * (MVP_SPEC §9), so an inaccessible component is a failing build.
 */
export const react = [
  ...base,
  {
    files: ['**/*.tsx', '**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.configs.recommended.rules,

      // --- CLAUDE.md §9: no ad-hoc fetch in components --------------------
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message:
            'Do not call fetch directly in components (CLAUDE.md §9). Use the generated API client through TanStack Query.',
        },
      ],
    },
  },
];

export default react;
