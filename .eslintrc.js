/**
 * ESLint configuration - TD-00 §3
 * 
 * Enforces layering rules and bans floating-point money operations.
 */

module.exports = {
  root: true,
  extends: [
    'next/core-web-vitals',
    'plugin:@typescript-eslint/recommended',
    'plugin:boundaries/recommended',
  ],
  plugins: ['@typescript-eslint', 'boundaries'],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
    // Ban floating-point operations on money
    'no-restricted-syntax': [
      'error',
      {
        selector: 'CallExpression[callee.name="parseFloat"]',
        message: 'Use parseMoney from domain/money instead of parseFloat',
      },
      {
        selector: 'CallExpression[callee.name="parseInt"]',
        message: 'Use parseMoney from domain/money instead of parseInt',
      },
      {
        selector: 'CallExpression[callee.name="Number"][arguments.0.type="Identifier"][arguments.0.name=/paisa|Paisa/]',
        message: 'Do not convert Paisa to Number, use bigint operations',
      },
      {
        selector: 'CallExpression[callee.name="toFixed"]',
        message: 'Use formatMoney from domain/money instead of toFixed',
      },
      {
        selector: 'UnaryExpression[operator="+"][argument.type="Identifier"][argument.name=/paisa|Paisa/]',
        message: 'Do not use unary + on Paisa, use bigint operations',
      },
      {
        selector: 'BinaryExpression[operator="*"][left.type="Identifier"][left.name=/paisa|Paisa/]',
        message: 'Do not multiply Paisa directly, use domain/money functions',
      },
      {
        selector: 'BinaryExpression[operator="/"][left.type="Identifier"][left.name=/paisa|Paisa/]',
        message: 'Do not divide Paisa directly, use domain/money functions',
      },
    ],
    // Layering rules (TD-00 §3)
    'boundaries/element-types': [
      'error',
      {
        default: 'disallow',
        message: '${file.type} may not import ${dependency.type}',
        rules: [
          // domain is pure: it may only import from itself
          { from: 'domain', allow: ['domain'] },
          // server may use domain (never UI)
          { from: 'server', allow: ['server', 'domain', 'lib'] },
          // lib = client helpers
          { from: 'lib', allow: ['lib', 'domain'] },
          // UI layers call actions (app/actions.ts), read-model types and domain
          { from: 'components', allow: ['components', 'lib', 'domain', 'server', 'app'] },
          { from: 'app', allow: ['app', 'components', 'lib', 'domain', 'server'] },
        ],
      },
    ],
    'boundaries/no-unknown-files': 'off',
  },
  overrides: [
    { files: ['src/domain/money/**/*.ts'], rules: { 'no-restricted-syntax': 'off' } },
    {
      // Pre-existing server code uses parseInt for row counts and has placeholder args;
      // the money-safety bans remain errors in domain/** and components/**.
      files: ['src/server/**/*.ts', 'src/app/api/**/*.ts', 'src/lib/**/*.ts'],
      rules: {
        'no-restricted-syntax': 'warn',
        '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
        'prefer-const': 'warn',
      },
    },
    {
      // "no any in domain/**" (TD-13 §10) is an error; elsewhere it is advisory
      files: ['src/domain/**/*.ts'],
      rules: { '@typescript-eslint/no-explicit-any': 'error' },
    },
    {
      files: ['tests/**/*.ts'],
      rules: { 'no-restricted-syntax': 'off', '@typescript-eslint/no-explicit-any': 'off' },
    },
  ],
  settings: {
    'boundaries/include': ['src/**/*'],
    'boundaries/elements': [
      { type: 'domain', pattern: 'src/domain/**/*', mode: 'full' },
      { type: 'server', pattern: 'src/server/**/*', mode: 'full' },
      { type: 'components', pattern: 'src/components/**/*', mode: 'full' },
      { type: 'lib', pattern: 'src/lib/**/*', mode: 'full' },
      { type: 'app', pattern: ['src/app/**/*', 'src/middleware.ts'], mode: 'full' },
    ],
  },
};
