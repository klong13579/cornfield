# MOA Inline + Remove Extension Bundle Cache

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Bake MOA into compiled `omp` like swarm/autoresearch, and load filesystem extensions via direct `import` — no `.omp/cache/extension-bundles` Bun.build middleman.

**Architecture:** First-party extensions register via `inlineExtensions.push(factory)` in `sdk.ts` and ship inside `bun build --compile`. Path-based extensions use `import(pathToFileURL(entry))` only. Keep the `pi-natives` process-global bindings singleton as defense-in-depth.

**Tech Stack:** Bun, TypeScript, existing ExtensionAPI / `loadExtensionFromFactory`.

---

### Task 1: Direct-import path loader (no Bun.build cache)

**Files:**
- Modify: `packages/coding-agent/src/extensibility/extensions/loader.ts`
- Test: existing `packages/coding-agent/test/extensions-*.test.ts`

**Steps:** Remove `findOwningPackageRoot` / `buildBundledExtensionModule`. `importExtensionModule` → `import(pathToFileURL(resolvedPath).href)`.

### Task 2: MOA as inline extension

**Files:**
- Modify: `packages/coding-agent/package.json` (dependency)
- Modify: `packages/coding-agent/src/sdk.ts`
- Modify: `packages/moa-extension/templates/project-omp-settings.json`, `README.md`, CHANGELOGs

**Steps:** Depend on `@oh-my-pi/moa-extension`, `inlineExtensions.push(moaExtension)`, drop path-based install docs/templates.

### Task 3: Verify

Clear extension-bundles caches, `bun --cwd=packages/coding-agent run build`, run `omp -p "say ok"`, confirm no segfault and `/moa` is registered (no Failed to load extension from path).
