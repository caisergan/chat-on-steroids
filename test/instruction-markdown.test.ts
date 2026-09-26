import { expect, it } from 'vitest';
import { CODE_MODE_INSTRUCTIONS } from '../src/main/mcp/code-mode-tool.js';

// ChatGPT's composer sends any message containing `[text](non-URL)` as escaped Markdown
// (renderMarkdown), so an app-owned frame must never contain that shape itself.
it('keeps the code-mode frame free of Markdown link shapes that switch ChatGPT to Markdown', () => {
  expect(CODE_MODE_INSTRUCTIONS).not.toMatch(/\[[^\]\n]+\]\((?!https?:\/\/)/);
  expect(CODE_MODE_INSTRUCTIONS).toContain('const tool = tools[name]; return tool(args);');
});
