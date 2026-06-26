# 01 — Make the lint gate real (ESLint for TypeScript)

> `frontend/eslint.config.js` matches only `src/**/*.{js,jsx}`, and `typescript-eslint`
> isn't installed. After the TS migration that means **every `.ts`/`.tsx` file — all
> source — is unlinted**, and the `@typescript-eslint/no-explicit-any` disables already
> in the tree are inert. `npm run lint` passes because it checks almost nothing. This
> wires up `typescript-eslint` so the linter (and the CI `lint` gate) actually covers the
> codebase again, then fixes whatever the first real run surfaces. Frontend-only.

## Locked decisions

1. **Use the unified `typescript-eslint` v8 package** (`parser` + `plugin`), compatible
   with the installed ESLint 9 flat config + TypeScript 5.9. Pin it in
   `package.json` `devDependencies` so CI and local match.
2. **A second flat-config block**, not a rewrite. Keep the existing `js,jsx` block as-is
   (the generated `fluidParams.js` + any non-TS stragglers stay covered); add a
   `src/**/*.{ts,tsx}` block that reuses the same react-hooks / `jsx-uses-vars` /
   `no-unused-vars` rules plus the typescript-eslint recommended set.
3. **Enforce `@typescript-eslint/no-explicit-any`** (the reason the inert disables exist).
   The two existing disable sites (`lib/api.ts`, `lib/segments.ts`) become meaningful;
   don't add new ones without a justifying comment.
4. **No type-aware linting (no `parserOptions.project`) in v1.** Syntactic + recommended
   rules only — fast, no `tsc`-in-eslint coupling. Type-aware rules can be a later opt-in.
5. **`npm run lint` and the command stay unchanged** (`eslint .`); only the config grows.

## Architecture this builds on

- `frontend/eslint.config.js` — flat config: `js.configs.recommended`, a
  `src/**/*.{js,jsx}` block with `react-hooks` + `react` plugins and
  `no-unused-vars` (warn, `argsIgnorePattern: "^_"`, `caughtErrors: "none"`), and a
  test/`vite.config.js` node-globals block.
- `.github/workflows/ci.yml` — the frontend job already runs `npm run lint` after
  install; this spec makes that step exercise `.tsx` without touching CI.
- `tsconfig.json` — `strict`, `noUnusedLocals`, `noUnusedParameters` already catch a lot;
  ESLint adds the react-hooks rules + `no-explicit-any` + import/unused hygiene that `tsc`
  doesn't.
- The inert disables to reactivate: `lib/api.ts` (file-level) and `lib/segments.ts`
  (file-level), both justified dynamic-JSON boundaries.

---

## Step 1 — Install + extend the flat config

**Goal.** `.ts/.tsx` files are linted by `typescript-eslint`.

**Files.** `frontend/package.json` (add `typescript-eslint` devDep),
`frontend/eslint.config.js` (add the TS block).

**Design.** Add a block after the existing `{js,jsx}` one:

```js
import tseslint from "typescript-eslint";
// ...
...tseslint.configs.recommended,   // spread the recommended flat configs
{
  files: ["src/**/*.{ts,tsx}"],
  languageOptions: {
    parser: tseslint.parser,
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
    "no-unused-vars": "off",                       // defer to the TS-aware rule
    "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", caughtErrors: "none" }],
    "@typescript-eslint/no-explicit-any": "error",
  },
}
```

Mirror the existing `no-unused-vars` options on the TS variant. Disable the base
`no-unused-vars` on TS files (it false-positives on type-only constructs).

**Reuse.** The existing plugin imports (`reactHooks`, `react`, `globals`) and rule
choices — same lenient stance, now applied to TS.

**Acceptance.** `npx eslint src/App.tsx` reports rule results (not "0 files linted");
`@typescript-eslint/*` rules are active.

**Verification (two-audience).** *Agent:* `npm run lint` now processes `.tsx` (temporarily
add an `any` with no disable → it errors; remove it). *User:* none.

**Risks.** ESLint-9 + typescript-eslint-8 flat-config wiring is version-sensitive; if the
recommended-config spread shape differs, follow the typescript-eslint "Getting Started
(flat config)" snippet for the installed major.

---

## Step 2 — Fix what the first real lint surfaces

**Goal.** `npm run lint` clean again — this time meaningfully.

**Files.** Whatever the run flags across the ~50 converted `.ts/.tsx` files.

**Design.** Expect: unused imports/vars left from the conversion, `react-hooks/exhaustive-deps`
warnings (already silenced case-by-case in some files — keep that pattern), and a few
real `any`s. For each `any`: type it properly if cheap, else add a
`// eslint-disable-next-line @typescript-eslint/no-explicit-any` **with a reason**. The
two existing file-level disables (`api.ts`, `segments.ts`) are already justified — leave
them. Don't mass-disable; the point is to see the real issues.

**Reuse.** The `^_` arg-ignore convention for intentionally-unused params; the existing
`eslint-disable-line` style already in the node cards.

**Acceptance.** `npm run lint` exits 0 with the TS block active; no blanket file-level
disables added beyond the two pre-existing justified ones.

**Verification (two-audience).** *Agent:* `npm run lint` clean; `npm run typecheck` +
`npm run build` + `npm run test` still green (lint fixes shouldn't change behaviour);
`npm run format:check` clean. *User:* none.

**Risks.** A lint fix that deletes a "used-only-for-effect" import could change behaviour —
prefer `// eslint-disable` over deletion when unsure, and rely on the build/test gate.

---

## Step 3 — Confirm the CI gate now has teeth

**Goal.** The existing CI `lint` step covers `.tsx` with no workflow change.

**Files.** none (verification only); optionally a one-line note in `DEVELOPMENT.md`'s lint
section that ESLint now covers `.ts/.tsx`.

**Design.** The frontend CI job already runs `npm run lint`; once the config covers TS,
the gate is automatically meaningful. Optionally prove it by pushing a branch with a
deliberate unused var and confirming CI goes red, then reverting.

**Acceptance.** CI `lint` step fails on a TS lint violation.

**Verification (two-audience).** *Agent:* (optional) throwaway violation → CI red → revert.
*User:* none.

**Risks.** None — no new job, same command.

---

## v1 boundary & extension points

**This spec:** syntactic + recommended typescript-eslint coverage of all `.ts/.tsx`, with
`no-explicit-any` enforced. **Designed-for:** later opt-in to type-aware rules
(`parserOptions.project` + `recommendedTypeChecked`) for rules like
`no-floating-promises`/`no-misused-promises` once the team wants the `tsc`-coupled cost.
No behaviour change in the app — this only changes what the linter sees.
