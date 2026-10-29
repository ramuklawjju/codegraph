/**
 * Graph Query Functions
 *
 * Higher-level query functions built on top of traversal algorithms.
 */

import { Node, Edge, Context, Subgraph, EdgeKind } from '../types';
import { QueryBuilder } from '../db/queries';
import { GraphTraverser } from './traversal';
import { isTestFile } from '../search/query-utils';
import type { Language } from '../types';

/** Resolves file-level imports for the dependency graph. */
export interface ImportFileResolver {
  /** Project file an import specifier in `fromFile` loads, or null. */
  resolve(specifier: string, fromFile: string, language: Language): string | null;
  /** Specifiers `filePath` re-exports from; these create no import node. */
  reExportSpecifiers(filePath: string, language: Language): string[];
}

const RE_EXPORT_LANGUAGES = new Set<Language>(['typescript', 'javascript', 'tsx', 'jsx']);

/** Names invoked by a runtime or framework rather than by user code. */
const ENTRY_POINT_NAMES = new Set([
  'main', 'constructor', 'init', '__init__', '__new__', '__call__', '__enter__', '__exit__',
  'setUp', 'tearDown', 'toString', 'equals', 'hashCode', 'render', 'new', 'drop', 'fmt',
]);

function wordPattern(name: string): RegExp {
  return new RegExp(`(^|[^A-Za-z0-9_$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_$])`);
}

/** True when `node.name` appears as a whole word in its file outside the node's own span. */
function nameUsedOutsideNode(node: Node, lines: string[]): boolean {
  const word = wordPattern(node.name);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    if (lineNo >= node.startLine && lineNo <= node.endLine) continue;
    if (word.test(lines[i]!)) return true;
  }
  return false;
}

/** True when `name` appears as a whole word within lines `start..end` (1-based, inclusive). */
function nameInSpan(name: string, lines: string[], start: number, end: number): boolean {
  const word = wordPattern(name);
  for (let i = Math.max(0, start - 1); i < Math.min(lines.length, end); i++) {
    if (word.test(lines[i]!)) return true;
  }
  return false;
}

/**
 * Graph query manager for complex queries
 */
export class GraphQueryManager {
  private queries: QueryBuilder;
  private traverser: GraphTraverser;

  private importResolver: ImportFileResolver | null = null;
  private importGraph: { fingerprint: string; forward: Map<string, Set<string>>; reverse: Map<string, Set<string>> } | null = null;

  /**
   * Supply a resolver for import specifiers. Import nodes store the module
   * path (`../src/index`) but no edge to the file it loads, and code inside
   * anonymous callbacks (e.g. `describe(() => ...)` test bodies) records no
   * symbol edges — so without this, such files look dependency-free.
   */
  setImportResolver(resolver: ImportFileResolver): void {
    this.importResolver = resolver;
    this.importGraph = null;
  }

  /** File-level import graph, rebuilt only when import nodes or files change. */
  private getImportGraph(): { forward: Map<string, Set<string>>; reverse: Map<string, Set<string>> } | null {
    if (!this.importResolver) return null;
    const fingerprint = this.queries.getImportFingerprint();
    if (this.importGraph?.fingerprint === fingerprint) return this.importGraph;

    const indexed = new Set(this.queries.getAllFilePaths());
    const forward = new Map<string, Set<string>>();
    const reverse = new Map<string, Set<string>>();
    const resolved = new Map<string, string | null>();
    const specifiers = this.queries.getImportSpecifiers();
    for (const file of this.queries.getAllFiles()) {
      if (!RE_EXPORT_LANGUAGES.has(file.language)) continue;
      for (const name of this.importResolver.reExportSpecifiers(file.path, file.language)) {
        specifiers.push({ filePath: file.path, name, language: file.language });
      }
    }
    for (const imp of specifiers) {
      const key = `${imp.language}\0${imp.filePath}\0${imp.name}`;
      let target = resolved.get(key);
      if (target === undefined) {
        target = this.importResolver.resolve(imp.name, imp.filePath, imp.language);
        resolved.set(key, target);
      }
      if (!target || target === imp.filePath || !indexed.has(target)) continue;
      if (!forward.has(imp.filePath)) forward.set(imp.filePath, new Set());
      forward.get(imp.filePath)!.add(target);
      if (!reverse.has(target)) reverse.set(target, new Set());
      reverse.get(target)!.add(imp.filePath);
    }
    this.importGraph = { fingerprint, forward, reverse };
    return this.importGraph;
  }

  constructor(queries: QueryBuilder) {
    this.queries = queries;
    this.traverser = new GraphTraverser(queries);
  }

  /**
   * Get full context for a node
   *
   * Returns the focal node along with its ancestors, children,
   * and both incoming and outgoing references.
   *
   * @param nodeId - ID of the focal node
   * @returns Context object with all related information
   */
  getContext(nodeId: string): Context {
    const focal = this.queries.getNodeById(nodeId);

    if (!focal) {
      throw new Error(`Node not found: ${nodeId}`);
    }

    // Get ancestors (containment hierarchy)
    const ancestors = this.traverser.getAncestors(nodeId);

    // Get children
    const children = this.traverser.getChildren(nodeId);

    // Get incoming references (things that reference this node)
    const incomingEdges = this.queries.getIncomingEdges(nodeId);
    const incomingRefs: Array<{ node: Node; edge: Edge }> = [];
    for (const edge of incomingEdges) {
      // Skip containment edges (already in ancestors)
      if (edge.kind === 'contains') {
        continue;
      }
      const node = this.queries.getNodeById(edge.source);
      if (node) {
        incomingRefs.push({ node, edge });
      }
    }

    // Get outgoing references (things this node references)
    const outgoingEdges = this.queries.getOutgoingEdges(nodeId);
    const outgoingRefs: Array<{ node: Node; edge: Edge }> = [];
    for (const edge of outgoingEdges) {
      // Skip containment edges (already in children)
      if (edge.kind === 'contains') {
        continue;
      }
      const node = this.queries.getNodeById(edge.target);
      if (node) {
        outgoingRefs.push({ node, edge });
      }
    }

    // Get type information (type_of, returns edges)
    const types: Node[] = [];
    const typeEdgeKinds: EdgeKind[] = ['type_of', 'returns'];
    for (const kind of typeEdgeKinds) {
      const typeEdges = this.queries.getOutgoingEdges(nodeId, [kind]);
      for (const edge of typeEdges) {
        const typeNode = this.queries.getNodeById(edge.target);
        if (typeNode && !types.some((t) => t.id === typeNode.id)) {
          types.push(typeNode);
        }
      }
    }

    // Get relevant imports
    const imports: Node[] = [];
    const fileNode = ancestors.find((a) => a.kind === 'file');
    if (fileNode) {
      const importEdges = this.queries.getOutgoingEdges(fileNode.id, ['imports']);
      for (const edge of importEdges) {
        const importNode = this.queries.getNodeById(edge.target);
        if (importNode) {
          imports.push(importNode);
        }
      }
    }

    return {
      focal,
      ancestors,
      children,
      incomingRefs,
      outgoingRefs,
      types,
      imports,
    };
  }

  /**
   * Get dependencies of a file
   *
   * Returns all files that this file imports from.
   *
   * @param filePath - Path to the file
   * @returns Array of file paths this file depends on
   */
  getFileDependencies(filePath: string): string[] {
    const deps = new Set(this.queries.getFileDependencyPaths(filePath));
    for (const f of this.getImportGraph()?.forward.get(filePath) ?? []) deps.add(f);
    return Array.from(deps);
  }

  /**
   * Get dependents of a file
   *
   * Returns all files that import from this file.
   *
   * @param filePath - Path to the file
   * @returns Array of file paths that depend on this file
   */
  getFileDependents(filePath: string): string[] {
    const dependents = new Set(this.queries.getFileDependentPaths(filePath));
    for (const f of this.getImportGraph()?.reverse.get(filePath) ?? []) dependents.add(f);
    return Array.from(dependents);
  }

  /**
   * Get all symbols exported by a file
   *
   * @param filePath - Path to the file
   * @returns Array of exported nodes
   */
  getExportedSymbols(filePath: string): Node[] {
    const nodes = this.queries.getNodesByFile(filePath);
    return nodes.filter((n) => n.isExported);
  }

  /**
   * Find symbols by qualified name pattern
   *
   * @param pattern - Pattern to match (supports * wildcard)
   * @returns Array of matching nodes
   */
  findByQualifiedName(pattern: string): Node[] {
    // Convert glob pattern to regex
    const regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');

    const regex = new RegExp(`^${regexPattern}$`);

    // This is inefficient for large graphs - would need FTS index on qualified_name
    // For now, use kind-based filtering if possible
    const allNodes: Node[] = [];
    const kinds: Node['kind'][] = [
      'class',
      'function',
      'method',
      'interface',
      'type_alias',
      'variable',
      'constant',
    ];

    for (const kind of kinds) {
      const nodes = this.queries.getNodesByKind(kind);
      for (const node of nodes) {
        if (regex.test(node.qualifiedName)) {
          allNodes.push(node);
        }
      }
    }

    return allNodes;
  }

  /**
   * Get the module/package structure
   *
   * Returns a tree structure of files organized by directory.
   *
   * @returns Map of directory paths to contained files
   */
  getModuleStructure(): Map<string, string[]> {
    const files = this.queries.getAllFiles();
    const structure = new Map<string, string[]>();

    for (const file of files) {
      const parts = file.path.split('/');
      const dir = parts.slice(0, -1).join('/') || '.';

      if (!structure.has(dir)) {
        structure.set(dir, []);
      }
      structure.get(dir)!.push(file.path);
    }

    return structure;
  }

  /**
   * Find circular file dependencies.
   *
   * Uses Tarjan's strongly connected components, so every file caught in a
   * cycle is reported exactly once, grouped with the files it cycles with.
   * (A plain DFS with a shared visited set misses cycles reached through an
   * already-visited file.) Each group is sorted; groups are largest first.
   *
   * @returns Array of cycles, each cycle is an array of file paths
   */
  findCircularDependencies(): string[][] {
    const adjacency = new Map<string, string[]>();
    const addEdge = (from: string, to: string) => {
      const list = adjacency.get(from);
      if (list) list.push(to);
      else adjacency.set(from, [to]);
    };
    for (const { from, to } of this.queries.getAllFileDependencyPairs()) addEdge(from, to);
    for (const [from, targets] of this.getImportGraph()?.forward ?? []) {
      for (const to of targets) addEdge(from, to);
    }

    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const cycles: string[][] = [];
    let counter = 0;

    // Iterative Tarjan: deep import chains would overflow the JS call stack.
    for (const root of adjacency.keys()) {
      if (index.has(root)) continue;
      const work: Array<{ node: string; next: number }> = [{ node: root, next: 0 }];
      index.set(root, counter); low.set(root, counter); counter++;
      stack.push(root); onStack.add(root);

      while (work.length > 0) {
        const frame = work[work.length - 1]!;
        const deps = adjacency.get(frame.node) ?? [];
        if (frame.next < deps.length) {
          const dep = deps[frame.next++]!;
          if (!index.has(dep)) {
            index.set(dep, counter); low.set(dep, counter); counter++;
            stack.push(dep); onStack.add(dep);
            work.push({ node: dep, next: 0 });
          } else if (onStack.has(dep)) {
            low.set(frame.node, Math.min(low.get(frame.node)!, index.get(dep)!));
          }
          continue;
        }
        work.pop();
        const parent = work[work.length - 1];
        if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
        if (low.get(frame.node) === index.get(frame.node)) {
          const group: string[] = [];
          let member: string;
          do {
            member = stack.pop()!;
            onStack.delete(member);
            group.push(member);
          } while (member !== frame.node);
          if (group.length > 1) cycles.push(group.sort());
        }
      }
    }

    return cycles.sort((x, y) => y.length - x.length || x[0]!.localeCompare(y[0]!));
  }

  /**
   * Get complexity metrics for a node
   *
   * @param nodeId - ID of the node
   * @returns Object containing various complexity metrics
   */
  getNodeMetrics(nodeId: string): {
    incomingEdgeCount: number;
    outgoingEdgeCount: number;
    callCount: number;
    callerCount: number;
    childCount: number;
    depth: number;
  } {
    const incomingEdges = this.queries.getIncomingEdges(nodeId);
    const outgoingEdges = this.queries.getOutgoingEdges(nodeId);

    const callEdges = outgoingEdges.filter((e) => e.kind === 'calls');
    const callerEdges = incomingEdges.filter((e) => e.kind === 'calls');
    const containsEdges = outgoingEdges.filter((e) => e.kind === 'contains');

    const ancestors = this.traverser.getAncestors(nodeId);

    return {
      incomingEdgeCount: incomingEdges.length,
      outgoingEdgeCount: outgoingEdges.length,
      callCount: callEdges.length,
      callerCount: callerEdges.length,
      childCount: containsEdges.length,
      depth: ancestors.length,
    };
  }

  /**
   * Find dead code: symbols nothing in the index refers to.
   *
   * Skips symbols that are reachable from outside the graph's view: exported
   * symbols, public members of exported types, decorated symbols (frameworks
   * call them), methods that override/implement another or that a supertype
   * declares (called through the parent type), object-literal members,
   * constructors and conventional entry points, and anything in test files.
   * When `readFile` is given, a symbol whose name still appears
   * elsewhere in its own file is also kept — this catches references the
   * extractor does not record as edges, such as a function passed as a
   * callback (`items.map(serialize)`).
   *
   * @param kinds - Node kinds to check (default: functions, methods, classes)
   * @param readFile - Optional reader returning a file's source, or null
   * @returns Array of unreferenced nodes
   */
  findDeadCode(kinds?: Node['kind'][], readFile?: (filePath: string) => string | null): Node[] {
    const targetKinds = kinds || ['function', 'method', 'class'];
    const deadCode: Node[] = [];
    const fileLines = new Map<string, string[] | null>();
    const getLines = (filePath: string): string[] | null => {
      if (!readFile) return null;
      if (!fileLines.has(filePath)) {
        const content = readFile(filePath);
        fileLines.set(filePath, content === null ? null : content.split('\n'));
      }
      return fileLines.get(filePath)!;
    };

    for (const kind of targetKinds) {
      const nodes = this.queries.getNodesByKind(kind);
      for (const node of nodes) {
        if (node.isExported) continue;
        if (ENTRY_POINT_NAMES.has(node.name)) continue;
        if (node.decorators && node.decorators.length > 0) continue;
        if (isTestFile(node.filePath)) continue;

        const incomingEdges = this.queries.getIncomingEdges(node.id);
        if (incomingEdges.some((e) => e.kind !== 'contains')) continue;

        if (node.kind === 'method' || node.kind === 'property' || node.kind === 'field') {
          if (this.queries.getOutgoingEdges(node.id, ['overrides', 'implements']).length > 0) continue;
          const parent = incomingEdges
            .filter((e) => e.kind === 'contains')
            .map((e) => this.queries.getNodeById(e.source))
            .find((p) => p && p.kind !== 'file');
          // No owning type: an object-literal member, invoked through the
          // object (often an interface implementation) rather than by name.
          if (!parent) continue;
          if (parent.isExported && node.visibility !== 'private') continue;
          if (this.declaredBySupertype(parent, node.name, getLines)) continue;
        }

        const lines = getLines(node.filePath);
        if (lines && nameUsedOutsideNode(node, lines)) continue;

        deadCode.push(node);
      }
    }

    return deadCode;
  }

  /**
   * True when a type `parent` extends/implements declares a member `name` —
   * the member is then called through the supertype, not by its own name.
   */
  private declaredBySupertype(
    parent: Node,
    name: string,
    getLines: (filePath: string) => string[] | null
  ): boolean {
    const seen = new Set<string>([parent.id]);
    const queue = [parent];
    while (queue.length > 0) {
      const type = queue.shift()!;
      for (const edge of this.queries.getOutgoingEdges(type.id, ['extends', 'implements'])) {
        if (seen.has(edge.target)) continue;
        seen.add(edge.target);
        const superType = this.queries.getNodeById(edge.target);
        if (!superType) continue;
        const declares = this.queries
          .getOutgoingEdges(superType.id, ['contains'])
          .some((e) => this.queries.getNodeById(e.target)?.name === name);
        if (declares) return true;
        // Some extractors don't emit interface members as nodes; fall back
        // to the supertype's own source span.
        const lines = getLines(superType.filePath);
        if (lines && nameInSpan(name, lines, superType.startLine, superType.endLine)) return true;
        queue.push(superType);
      }
    }
    return false;
  }

  /**
   * Get subgraph containing nodes matching a filter
   *
   * @param filter - Filter function to select nodes
   * @param includeEdges - Whether to include edges between matching nodes
   * @returns Subgraph containing matching nodes
   */
  getFilteredSubgraph(
    filter: (node: Node) => boolean,
    includeEdges: boolean = true
  ): Subgraph {
    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];

    // Get all nodes of common kinds
    const kinds: Node['kind'][] = [
      'file',
      'module',
      'class',
      'struct',
      'interface',
      'trait',
      'function',
      'method',
      'variable',
      'constant',
      'enum',
      'type_alias',
    ];

    for (const kind of kinds) {
      const kindNodes = this.queries.getNodesByKind(kind);
      for (const node of kindNodes) {
        if (filter(node)) {
          nodes.set(node.id, node);
        }
      }
    }

    // Include edges between matching nodes
    if (includeEdges) {
      for (const nodeId of nodes.keys()) {
        const outgoing = this.queries.getOutgoingEdges(nodeId);
        for (const edge of outgoing) {
          if (nodes.has(edge.target)) {
            edges.push(edge);
          }
        }
      }
    }

    return {
      nodes,
      edges,
      roots: [],
    };
  }

  /**
   * Access the underlying traverser for direct traversal operations
   */
  getTraverser(): GraphTraverser {
    return this.traverser;
  }
}
