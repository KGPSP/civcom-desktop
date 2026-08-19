import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/",
      "node_modules/",
      "coverage/",
      "playwright-report/",
      "test-results/"
    ]
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { Buffer: "readonly", URL: "readonly", process: "readonly" }
    }
  },
  {
    files: ["electron-builder.config.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { module: "readonly", process: "readonly", require: "readonly" }
    },
    rules: { "@typescript-eslint/no-require-imports": "off" }
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }]
    }
  }
);
