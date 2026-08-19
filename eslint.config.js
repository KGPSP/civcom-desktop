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
    files: ["scripts/**/*.mjs", "test/support/**/*.mjs"],
    languageOptions: {
      globals: { Buffer: "readonly", URL: "readonly", clearTimeout: "readonly", process: "readonly", setTimeout: "readonly" }
    }
  },
  {
    files: ["electron-builder.config.cjs", "test/support/**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { URL: "readonly", __dirname: "readonly", clearTimeout: "readonly", module: "readonly", process: "readonly", require: "readonly", setTimeout: "readonly" }
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
