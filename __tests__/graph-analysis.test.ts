/**
 * File dependencies, circular dependencies, dead code, and typed-receiver
 * method resolution, checked against real indexed fixtures.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
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

let roots: string[] = [];
const graphs: CodeGraph[] = [];

async function indexFixture(files: Record<string, string>, include = ['**/*.ts']): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-analysis-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  const cg = CodeGraph.initSync(root, { config: { include, exclude: [] } });
  await cg.indexAll();
  graphs.push(cg);
  return cg;
}

afterEach(() => {
  for (const cg of graphs.splice(0)) cg.close();
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  roots = [];
});

describe('file dependencies', () => {
  it('follows resolved imports stored as call edges', async () => {
    const cg = await indexFixture({
      'src/a.ts': `import { b } from './b';\nexport function a() { return b(); }\n`,
      'src/b.ts': `export function b() { return 1; }\n`,
    });
    expect(cg.getFileDependencies('src/a.ts')).toEqual(['src/b.ts']);
    expect(cg.getFileDependents('src/b.ts')).toEqual(['src/a.ts']);
  });
});

describe('import-only file dependencies', () => {
  it('links a test file whose calls all live inside describe() callbacks', async () => {
    const cg = await indexFixture({
      'src/lib/math.ts': `export function add(a: number, b: number) { return a + b; }\n`,
      'src/index.ts': `export { add } from './lib/math';\n`,
      '__tests__/math.test.ts': [
        "import { add } from '../src/index';",
        "describe('add', () => { it('adds', () => { expect(add(1, 2)).toBe(3); }); });",
        '',
      ].join('\n'),
    });
    expect(cg.getFileDependencies('__tests__/math.test.ts')).toContain('src/index.ts');
    expect(cg.getFileDependents('src/index.ts')).toContain('__tests__/math.test.ts');
    expect(cg.getFileDependents('src/lib/math.ts')).toContain('src/index.ts');
  });
});

describe('findCircularDependencies', () => {
  it('reports a cycle reached through an already-visited file', async () => {
    // a -> b -> c -> b: a plain DFS visiting a first used to report this,
    // but starting from c after b was visited could miss it. Tarjan groups {b, c}.
    const cg = await indexFixture({
      'src/a.ts': `import { b } from './b';\nexport function a() { return b(); }\n`,
      'src/b.ts': `import { c } from './c';\nexport function b() { return c(); }\nexport function b2() { return 2; }\n`,
      'src/c.ts': `import { b2 } from './b';\nexport function c() { return b2(); }\n`,
      'src/d.ts': `export function d() { return 4; }\n`,
    });
    expect(cg.findCircularDependencies()).toEqual([['src/b.ts', 'src/c.ts']]);
  });

  it('returns nothing for an acyclic project', async () => {
    const cg = await indexFixture({
      'src/a.ts': `import { b } from './b';\nexport function a() { return b(); }\n`,
      'src/b.ts': `export function b() { return 1; }\n`,
    });
    expect(cg.findCircularDependencies()).toEqual([]);
  });
});

describe('findDeadCode', () => {
  it('reports only truly unreferenced symbols', async () => {
    const cg = await indexFixture({
      'src/mod.ts': [
        'function reallyUnused() { return 0; }',
        'function usedAsCallback(x: number) { return x; }',
        'function calledDirectly() { return 1; }',
        'export function run(xs: number[]) { calledDirectly(); return xs.map(usedAsCallback); }',
        'export class Service { helper() { return 1; } private secret() { return 2; } }',
        'export const target = { detect() { return true; } };',
        'interface Target { describe(): string; }',
        'class Impl implements Target { describe() { return "x"; } }',
        'export const impl: Target = new Impl();',
        '',
      ].join('\n'),
      'src/mod.test.ts': `function testOnlyHelper() { return 1; }\n`,
    });
    const names = cg.findDeadCode().map((n) => n.name).sort();
    expect(names).toEqual(['reallyUnused', 'secret']);
  });
});

describe('library calls do not resolve to project symbols', () => {
  it('ignores chained and externally-typed receivers', async () => {
    const cg = await indexFixture({
      'src/runner.ts': `export function run() { return 1; }\n`,
      'src/adapter.ts': `export class Adapter { exec(sql: string) { return sql; } }\n`,
      'src/use.ts': [
        "import Database from 'better-sqlite3';",
        "import { Adapter } from './adapter';",
        "export function chained(db: Database.Database) { db.prepare('x').run(); }",
        "export function regex() { const re = /x/g; return re.exec('y'); }",
        'export function plain() { return run(); }',
        'export function spread() { return [...run()]; }',
        "export function typed(a: Adapter) { return a.exec('q'); }",
        "import * as fs from 'fs';",
        "export function external() { return fs.exec('a'); }",
        'interface Runner { exec(q: string): string; }',
        "export function viaInterface(r: Runner) { return r.exec('q'); }",
        '',
      ].join('\n'),
    });
    const callees = (fn: string) => {
      const node = cg.searchNodes(fn).find((r) => r.node.name === fn)!.node;
      return cg.getCallees(node.id).map((c) => `${c.node.filePath}:${c.node.name}`);
    };
    expect(callees('chained')).toEqual([]);
    expect(callees('regex')).toEqual([]);
    expect(callees('plain')).toContain('src/runner.ts:run');
    expect(callees('spread')).toContain('src/runner.ts:run');
    expect(callees('typed')).toContain('src/adapter.ts:exec');
    expect(callees('external')).toEqual([]);
    expect(callees('viaInterface')).not.toContain('src/adapter.ts:exec');
  });
});

describe('typed receiver method resolution', () => {
  it('resolves obj.method() via the variable\'s declared or returned type', async () => {
    const cg = await indexFixture({
      'src/graph.ts': `export class Graph { findPath() { return 1; } }\n`,
      'src/traverser.ts': `export class Traverser { findPath() { return 2; } }\n`,
      'src/use.ts': [
        "import { Graph } from './graph';",
        'export function viaAnnotation(cg: Graph) { return cg.findPath(); }',
        'export function makeGraph(): Graph { return new Graph(); }',
        'export function viaReturnType() { const g = makeGraph(); return g.findPath(); }',
        '',
      ].join('\n'),
    });
    for (const fn of ['viaAnnotation', 'viaReturnType']) {
      const node = cg.searchNodes(fn).find((r) => r.node.name === fn)!.node;
      const callees = cg.getCallees(node.id).map((c) => `${c.node.filePath}:${c.node.name}`);
      expect(callees).toContain('src/graph.ts:findPath');
      expect(callees).not.toContain('src/traverser.ts:findPath');
    }
  });
});

describe('MCP tools', () => {
  it('codegraph_dead_code and codegraph_cycles format results and honor the path filter', async () => {
    const cg = await indexFixture({
      'src/x/b.ts': `import { c } from './c';\nexport function b() { return c(); }\nexport function b2() { return 2; }\n`,
      'src/x/c.ts': `import { b2 } from './b';\nexport function c() { return b2(); }\n`,
      'src/y/z.ts': `function orphan() { return 1; }\nexport function z() { return 1; }\n`,
    });
    const handler = new ToolHandler(cg);

    const dead = (await handler.execute('codegraph_dead_code', {})).content[0]!.text;
    expect(dead).toContain('orphan (function) - src/y/z.ts:1');
    const filtered = (await handler.execute('codegraph_dead_code', { path: './src/x/' })).content[0]!.text;
    expect(filtered).toContain('No unreferenced symbols found under src/x/');

    const cycles = (await handler.execute('codegraph_cycles', {})).content[0]!.text;
    expect(cycles).toContain('1. 2 files: src/x/b.ts, src/x/c.ts');
    const none = (await handler.execute('codegraph_cycles', { path: 'src/y' })).content[0]!.text;
    expect(none).toContain('No circular file dependencies found involving src/y/');
    handler.closeAll();
  });
});
