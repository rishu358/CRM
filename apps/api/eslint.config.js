import base from '@crm/config/eslint';

export default [
  ...base,
  {
    files: ['src/**/*.ts'],
    rules: {
      // NestJS decorators are evaluated for their side effects on the class.
      '@typescript-eslint/no-extraneous-class': 'off',
    },
  },
];
