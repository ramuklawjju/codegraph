/**
 * codegraph_path: shortest call/reference chain between two symbols.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('codegraph_path', () => {
  let root: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-path-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(
      path.join(root, 'src', 'flow.ts'),
      [
        'export function handleLogin() { return validate(); }',
        'function validate() { return saveSession(); }',
        'function saveSession() { return writeRow(); }',
        'function writeRow() { return 1; }',
        'export function unrelated() { return 2; }',
        '',
      ].join('\n')
    );
    cg = CodeGraph.initSync(root, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler.closeAll();
    cg.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('is listed in tool definitions', () => {
    expect(handler.getTools().some((t) => t.name === 'codegraph_path')).toBe(true);
  });

  it('returns every hop of the forward chain', async () => {
    const res = await handler.execute('codegraph_path', { from: 'handleLogin', to: 'writeRow' });
    const text = res.content[0]!.text;
    expect(text).toContain('Path: handleLogin -> writeRow (3 hops)');
    const order = ['handleLogin', 'validate', 'saveSession', 'writeRow'].map((n) => text.indexOf(`. ${n} (`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain('<- calls');
  });

  it('falls back to the reverse direction', async () => {
    const res = await handler.execute('codegraph_path', { from: 'writeRow', to: 'handleLogin' });
    expect(res.content[0]!.text).toContain('reverse direction connects');
    expect(res.content[0]!.text).toContain('Path: handleLogin -> writeRow');
  });

  it('reports when nothing connects', async () => {
    const res = await handler.execute('codegraph_path', { from: 'unrelated', to: 'writeRow' });
    expect(res.content[0]!.text).toContain('No path between');
  });

  it('reports unknown symbols and validates input', async () => {
    const res = await handler.execute('codegraph_path', { from: 'nopeNotHere', to: 'writeRow' });
    expect(res.content[0]!.text).toContain('not found');
    const bad = await handler.execute('codegraph_path', { from: 'handleLogin' });
    expect(bad.isError).toBe(true);
  });
});
