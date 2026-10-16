import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/**
 * Shared ESLint base for every workspace package.
 *
 * Several rules here exist to enforce CLAUDE.md §5 mechanically rather than by
 * review. None of them may be disabled to make code pass (CLAUDE.md §11.6) —
 * if a rule fires, the code is wrong, not the rule.
 */
export const base = tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/*.config.js',
      '**/*.config.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      // --- CLAUDE.md §2: "no `any`" -----------------------------------------
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',

      // --- General correctness ----------------------------------------------
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],

      // --- CLAUDE.md §5.3: authorization goes through can(), never inline ----
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'BinaryExpression[operator=/^[!=]==?$/] > MemberExpression[property.name=/^(role|roleName)$/]',
          message:
            'Inline role checks are forbidden (CLAUDE.md §5.3). Authorize through can(actor, action, resource) in @crm/core/permissions.',
        },
        {
          selector:
            "BinaryExpression[operator=/^[!=]==?$/] > MemberExpression[property.name='plan']",
          message:
            'Do not branch on plan names (CLAUDE.md §6). Use entitlements.has(tenant, feature).',
        },
      ],

      // --- CLAUDE.md §5.2: tenant/user identity comes from the session ------
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            'Read configuration from the validated env module, not process.env directly (CLAUDE.md §5.8).',
        },
      ],
    },
  },
  {
    // Test files relax a few rules that only make sense in production code.
    files: ['**/*.spec.ts', '**/*.test.ts', '**/testing/**/*.ts', '**/tests/**/*.ts'],
    rules: {
      'no-console': 'off',
      'no-restricted-properties': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // The env module is the one place allowed to touch process.env.
    files: ['**/env.ts', '**/env/*.ts', '**/*.config.ts', '**/drizzle.config.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
);

export default base;
