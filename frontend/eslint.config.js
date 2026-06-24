import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import react from "eslint-plugin-react";
import globals from "globals";

// Flat ESLint config for the React frontend. Recommended rules + the
// react-hooks checks (the ones that actually catch bugs here: missing effect
// deps, conditional hooks). `react/jsx-uses-vars` teaches no-unused-vars that
// JSX-referenced imports are used. Lenient on stylistic noise.
export default [
  { ignores: ["dist/**"] },
  js.configs.recommended,
  {
    files: ["src/**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    plugins: { "react-hooks": reactHooks, react },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react/jsx-uses-vars": "error",
      "react/jsx-uses-react": "error",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
  {
    files: ["src/**/*.test.js", "vite.config.js"],
    languageOptions: { globals: { ...globals.node } },
  },
];
