import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // No `any` anywhere. The one exception is the documented `Json` type that the tests use for API responses.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  { files: ['apps/api/**/*.ts', 'packages/**/*.ts', '*.mjs'], languageOptions: { globals: globals.node } },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    // useQuery() deliberately resets state when its path changes, so this newer rule is shown as a warning, not a failure.
    rules: { ...reactHooks.configs.recommended.rules, 'react-hooks/set-state-in-effect': 'warn' },
  },
);
