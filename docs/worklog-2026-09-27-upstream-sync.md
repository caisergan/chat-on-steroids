# Upstream integration — 2026-09-27

Integrated upstream `3d2659059a9f886ede156168c15061387bb558c1` into the fork's
published `main` tip, `e29acf164a5309eedd1a6c802e87be48eef5e9f1`. The merge retains
upstream history and authorship without incorporating the private development branch.

## Scope

- Use upstream implementations for extension observation, composer delivery, receipt
  recovery, recording, automation, renderer behavior and release metadata.
- Retain the macOS Search browser option, bundle detection and LaunchServices opening.
- Retain the CoS CLI, authenticated local control endpoint, MCP server, hooks and
  Claude Code plugin, including their Settings and build wiring.
- Include the three retained Settings labels in all nine translated catalogs.
- Add an IPC regression proving that a stale Settings save preserves CLI access and
  upstream command rules, while an explicit disable still takes effect.

The pre-integration dirty tree contained an upload fix and tunnel pins already present
on the fork's published main, stale 2.1.15 release staging, and host-generated license
inventory differences. It was preserved locally rather than published as another change.
App and extension versions remain 2.1.16; this integration does not publish a release.

## Verification

- TypeScript check and Electron production build passed.
- Production dependency audit: zero reported vulnerabilities.
- License verification: 154 production packages, seven catalog entries and 730 pinned
  native source archives/patches validated.
- Plugin and marketplace manifest validation passed.
- Built CLI smoke: `--help`, MCP initialization and all 13 tool declarations passed
  under Node over stdio.
- IPC suite with the new Settings regression: 84/84 passed.
- The initial unconstrained full run had 12 failures, including timeouts and subsequent
  state/timer failures. All seven affected suites passed unchanged with two workers:
  1,115/1,115 tests in 152.20 seconds. No assertions or timeouts were weakened.
- The final complete verification repeated every `verify:ci` gate, limiting ordinary
  Vitest suites to two workers and retaining one worker for the native/shutdown phase.
  Ordinary suites: 6,101 passed, 110 skipped in 251.29 seconds. Native/shutdown phase:
  six passed, 20 platform-skipped in 1.69 seconds. Total: 6,107 passed, 130 skipped,
  zero failures. There is no separate lint script; both staged and working-tree
  whitespace checks passed.

Verification covers source, automated tests and bundles. It does not establish an
installed-app or signed-in Search/ChatGPT end-to-end result. Windows desktop tests and
other platform/opt-in suites retain their existing eligibility requirements.
