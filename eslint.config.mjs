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
      // The API leans on `any` for Express request objects and pg rows. Visible as warnings so it can be reduced over time.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  { files: ['apps/api/**/*.ts', 'packages/**/*.ts', '*.mjs'], languageOptions: { globals: globals.node } },
  // The API source is fully typed: a new `any` there fails the build. Tests and the web app keep it as a warning.
  { files: ['apps/api/src/**/*.ts'], rules: { '@typescript-eslint/no-explicit-any': 'error' } },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    // useQuery() deliberately resets state when its path changes, so this newer rule is shown as a warning, not a failure.
    rules: { ...reactHooks.configs.recommended.rules, 'react-hooks/set-state-in-effect': 'warn' },
  },
);
