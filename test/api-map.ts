// Generates docs/test-map.md (English) and docs/zh-CN/test-map.md: which tests exercise each
// public API member and MCP tool. The public API is every class and function exported by the
// package entry points (package.json "exports"), without private, protected or @internal members.
// Usage: node test/api-map.ts            (runs unit + integration tests with tracing; needs Chrome)
//        node test/api-map.ts --reuse    (rebuilds the document from the last trace)
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import * as prettier from 'prettier';
import * as typescript from 'prettier/plugins/typescript';

const root = resolve(import.meta.dirname, '..');
const traceDir = join(root, 'dev', 'api-trace');

type Node = {
  type: string;
  range: [number, number];
  loc: { start: { line: number }; end: { line: number } };
} & Record<string, any>;
interface Source {
  ast: Node;
  text: string;
}
const sources = new Map<string, Promise<Source>>();
/** Parses a repository-relative TypeScript file once. */
function parse(file: string): Promise<Source> {
  let source = sources.get(file);
  if (!source) sources.set(file, (source = load(file)));
  return source;
}
async function load(file: string): Promise<Source> {
  const text = readFileSync(join(root, file), 'utf8');
  const ast = (await typescript.parsers.typescript.parse(text, {
    filepath: file,
  } as never)) as Node;
  return { ast, text };
}
function walk(node: unknown, visit: (node: Node, parents: Node[]) => void, parents: Node[] = []) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, parents);
    return;
  }
  const n = node as Node;
  if (typeof n.type !== 'string') return;
  visit(n, parents);
  for (const [key, value] of Object.entries(n))
    if (key !== 'loc' && key !== 'range' && key !== 'parent') walk(value, visit, [...parents, n]);
}

/** An interpolated value by name: identifiers and property paths, anything else as "…". */
function placeholder(node: Node): string {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
    const object = placeholder(node.object);
    if (object !== '…') return `${object}.${node.property.name}`;
  }
  return '…';
}
/** Literals verbatim, templates and `+` concatenations part by part, other values as ${name}. */
function spell(node: Node): string {
  if (node.type === 'Literal' && ['string', 'number', 'boolean'].includes(typeof node.value))
    return String(node.value);
  if (node.type === 'TemplateLiteral')
    return node.quasis
      .map(
        (q: Node, i: number) =>
          q.value.cooked + (i < node.expressions.length ? spell(node.expressions[i]) : ''),
      )
      .join('');
  if (node.type === 'BinaryExpression' && node.operator === '+')
    return spell(node.left) + spell(node.right);
  return '${' + placeholder(node) + '}';
}
const names = ['Literal', 'TemplateLiteral', 'BinaryExpression', 'Identifier', 'MemberExpression'];
/** A test or suite name as written: `transport + ': x'` reads `${transport}: x`. */
export const label = (node: Node | undefined): string | undefined =>
  node && names.includes(node.type) && (node.type !== 'BinaryExpression' || node.operator === '+')
    ? spell(node)
    : undefined;
const calleeName = (node: Node): string | undefined =>
  node.callee?.type === 'Identifier'
    ? node.callee.name
    : node.callee?.type === 'MemberExpression' && node.callee.object.type === 'Identifier'
      ? node.callee.object.name
      : undefined;

interface TestBlock {
  name: string;
  start: number;
  end: number;
  text: string;
}
interface FileIndex {
  tests: TestBlock[];
  helpers: Array<{ name: string; start: number; end: number }>;
  literals: Array<{ value: string; line: number }>;
  identifiers: Array<{ name: string; line: number }>;
}
const files = new Map<string, FileIndex>();
/** Tests (named `suite › test`), helpers, string literals and identifiers of a test file. */
export async function index(file: string): Promise<FileIndex> {
  const cached = files.get(file);
  if (cached) return cached;
  const { ast, text } = await parse(file);
  const lines = text.split('\n');
  const result: FileIndex = { tests: [], helpers: [], literals: [], identifiers: [] };
  walk(ast, (node, parents) => {
    if (node.type === 'CallExpression' && ['test', 'it'].includes(calleeName(node) ?? '')) {
      const describes = parents
        .filter((p) => p.type === 'CallExpression' && calleeName(p) === 'describe')
        .map((p) => label(p.arguments[0]) ?? '…');
      const name = [...describes, label(node.arguments[0]) ?? '…'].join(' › ');
      const { start, end } = node.loc;
      result.tests.push({
        name,
        start: start.line,
        end: end.line,
        text: lines.slice(start.line - 1, end.line).join('\n'),
      });
    }
    const named =
      node.type === 'FunctionDeclaration'
        ? node.id?.name
        : node.type === 'VariableDeclarator' &&
            ['ArrowFunctionExpression', 'FunctionExpression'].includes(node.init?.type)
          ? node.id?.name
          : undefined;
    if (named)
      result.helpers.push({ name: named, start: node.loc.start.line, end: node.loc.end.line });
    if (node.type === 'Literal' && typeof node.value === 'string')
      result.literals.push({ value: node.value, line: node.loc.start.line });
    if (node.type === 'Identifier')
      result.identifiers.push({ name: node.name, line: node.loc.start.line });
  });
  files.set(file, result);
  return result;
}
const innermost = <T extends { start: number; end: number }>(items: T[], line: number) =>
  items
    .filter((item) => item.start <= line && line <= item.end)
    .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
const short = (file: string) => file.replace(/^test\//, '').replace(/\.test\.ts$/, '');

/** Tests enclosing a source line; a helper's line resolves to the tests that call the helper. */
async function testsAt(file: string, line: number, seen = new Set<string>()): Promise<string[]> {
  const { tests, helpers } = await index(file);
  const test = innermost(tests, line);
  if (test) return [`${short(file)} › ${test.name}`];
  const helper = innermost(helpers, line);
  if (!helper || seen.has(`${file}:${helper.name}`)) return [];
  seen.add(`${file}:${helper.name}`);
  const result: string[] = [];
  for (const other of await testFiles()) {
    const { identifiers } = await index(other);
    for (const use of identifiers)
      if (
        use.name === helper.name &&
        !(other === file && use.line >= helper.start && use.line <= helper.end)
      )
        result.push(...(await testsAt(other, use.line, seen)));
  }
  return result;
}
let cachedFiles: string[] | undefined;
async function testFiles(): Promise<string[]> {
  return (cachedFiles ??= ['test/unit', 'test/integration', 'test/fixtures'].flatMap((dir) =>
    readdirSync(join(root, dir))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => `${dir}/${f}`),
  ));
}

/** Source files of the package entry points: package.json "exports" mapped from dist to src. */
function entryPoints(): string[] {
  const { exports } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    exports: Record<string, { import: string }>;
  };
  return Object.values(exports).map((target) =>
    target.import.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts'),
  );
}
/** Whether the JSDoc block directly before `start` has an @internal tag. */
function documentedInternal({ ast, text }: Source, start: number): boolean {
  const comment = (ast.comments as Node[]).findLast((c) => c.range[1] <= start);
  return (
    comment?.type === 'Block' &&
    comment.value.startsWith('*') &&
    !text.slice(comment.range[1], start).trim() &&
    /(^|\s)@internal\b/.test(comment.value)
  );
}
interface Declaration {
  kind: 'class' | 'function';
  name: string;
  file: string;
  /** The class declaration, or the first declaration of a function. */
  node: Node;
  internal: boolean;
}
const declared = new Map<string, Promise<Map<string, Declaration>>>();
/** Top-level classes and functions of a module, by local name. */
function declarations(file: string): Promise<Map<string, Declaration>> {
  let result = declared.get(file);
  if (!result) declared.set(file, (result = collectDeclarations(file)));
  return result;
}
async function collectDeclarations(file: string): Promise<Map<string, Declaration>> {
  const source = await parse(file);
  const found = new Map<string, { kind: Declaration['kind']; nodes: Node[]; docs: boolean[] }>();
  const add = (name: string, kind: Declaration['kind'], node: Node, start: number) => {
    const entry = found.get(name) ?? { kind, nodes: [], docs: [] };
    entry.nodes.push(node);
    entry.docs.push(documentedInternal(source, start));
    found.set(name, entry);
  };
  for (const statement of source.ast.body as Node[]) {
    const node: Node | undefined = ['ExportNamedDeclaration', 'ExportDefaultDeclaration'].includes(
      statement.type,
    )
      ? statement.declaration
      : statement;
    // The JSDoc of an exported declaration precedes the export keyword.
    const start = statement.range[0];
    if (node?.type === 'ClassDeclaration' && node.id) add(node.id.name, 'class', node, start);
    else if (node && ['FunctionDeclaration', 'TSDeclareFunction'].includes(node.type) && node.id)
      add(node.id.name, 'function', node, start);
    else if (node?.type === 'VariableDeclaration')
      for (const variable of node.declarations as Node[])
        if (
          variable.id.type === 'Identifier' &&
          ['ArrowFunctionExpression', 'FunctionExpression'].includes(variable.init?.type)
        )
          add(variable.id.name, 'function', variable, start);
  }
  const result = new Map<string, Declaration>();
  for (const [name, { kind, nodes, docs }] of found) {
    // Overload signatures are what callers see; without overloads, the declaration itself.
    const signatures = nodes.map((n) => n.type === 'TSDeclareFunction');
    const visible = signatures.some(Boolean) ? docs.filter((_, i) => signatures[i]) : docs;
    result.set(name, { kind, name, file, node: nodes[0]!, internal: visible.every(Boolean) });
  }
  return result;
}
/** A relative module specifier as a repository-relative source path; packages are skipped. */
function moduleFile(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const file = posix.normalize(posix.join(posix.dirname(from), specifier));
  return existsSync(join(root, file)) ? file : undefined;
}
const exported = new Map<string, Promise<Map<string, Declaration>>>();
/**
 * Classes and functions a module exports, by exported name, following re-exports. `via` lists
 * the modules whose exports are being collected; a re-export cycle back to one adds nothing.
 */
function moduleExports(file: string, via: string[] = []): Promise<Map<string, Declaration>> {
  if (via.includes(file)) return Promise.resolve(new Map());
  let result = exported.get(file);
  if (!result) exported.set(file, (result = collectExports(file, [...via, file])));
  return result;
}
async function collectExports(file: string, via: string[]): Promise<Map<string, Declaration>> {
  const { ast } = await parse(file);
  const local = await declarations(file);
  const result = new Map<string, Declaration>();
  const name = (node: Node): string => node.name ?? node.value;
  /** A local name bound by `import { name } from './module.ts'`, resolved to its declaration. */
  const imported = async (localName: string) => {
    for (const statement of ast.body as Node[]) {
      if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type') continue;
      const specifier = (statement.specifiers as Node[]).find(
        (s) => s.type === 'ImportSpecifier' && s.local.name === localName,
      );
      if (!specifier) continue;
      const target = moduleFile(file, statement.source.value);
      return target ? (await moduleExports(target, via)).get(name(specifier.imported)) : undefined;
    }
    return undefined;
  };
  for (const statement of ast.body as Node[]) {
    if (statement.exportKind === 'type') continue;
    if (statement.type === 'ExportAllDeclaration') {
      const target = statement.exported ? undefined : moduleFile(file, statement.source.value);
      if (target)
        for (const [exportedName, declaration] of await moduleExports(target, via))
          if (!result.has(exportedName)) result.set(exportedName, declaration);
      continue;
    }
    if (statement.type !== 'ExportNamedDeclaration') continue;
    const declaration: Node | undefined = statement.declaration;
    const declaredNames =
      declaration?.type === 'VariableDeclaration'
        ? (declaration.declarations as Node[]).map((v) => v.id.name as string)
        : declaration?.id
          ? [declaration.id.name as string]
          : [];
    for (const declaredName of declaredNames) {
      const found = local.get(declaredName);
      if (found) result.set(declaredName, found);
    }
    for (const specifier of (statement.specifiers ?? []) as Node[]) {
      if (specifier.exportKind === 'type') continue;
      const target = statement.source && moduleFile(file, statement.source.value);
      const found = statement.source
        ? target && (await moduleExports(target, via)).get(name(specifier.local))
        : (local.get(name(specifier.local)) ?? (await imported(name(specifier.local))));
      if (found) result.set(name(specifier.exported), found);
    }
  }
  return result;
}
/** Public methods and accessors of a class, as `name` or `static name`. */
async function classMembers(declaration: Declaration): Promise<string[]> {
  const source = await parse(declaration.file);
  const groups = new Map<string, Node[]>();
  for (const member of declaration.node.body.body as Node[]) {
    if (!['MethodDefinition', 'TSAbstractMethodDefinition'].includes(member.type)) continue;
    if (member.kind === 'constructor' || member.accessibility === 'private') continue;
    if (member.accessibility === 'protected' || member.key.type === 'PrivateIdentifier') continue;
    const key =
      member.key.type === 'Identifier'
        ? member.key.name
        : member.computed && member.key.type === 'MemberExpression'
          ? `[Symbol.${member.key.property.name}]`
          : undefined;
    if (!key) continue;
    const name = `${member.static ? 'static ' : ''}${key}`;
    groups.set(name, [...(groups.get(name) ?? []), member]);
  }
  const list: string[] = [];
  for (const [name, nodes] of groups) {
    // Overload signatures are what callers see; otherwise each method body or accessor.
    const signatures = nodes.filter((n) => n.value.type === 'TSEmptyBodyFunctionExpression');
    if (
      (signatures.length ? signatures : nodes).some((n) => !documentedInternal(source, n.range[0]))
    )
      list.push(name);
  }
  return list;
}
/**
 * Exported classes with their public methods and accessors, and exported functions, in entry
 * point order. Classes without either, such as error classes, have nothing to map.
 */
export async function publicApi(): Promise<{
  classes: Map<string, string[]>;
  functions: string[];
}> {
  const classes = new Map<string, string[]>(),
    functions: string[] = [],
    seen = new Set<Declaration>();
  for (const entry of entryPoints())
    for (const declaration of (await moduleExports(entry)).values()) {
      if (declaration.internal || seen.has(declaration)) continue;
      seen.add(declaration);
      if (declaration.kind === 'function') functions.push(declaration.name);
      else {
        const members = await classMembers(declaration);
        if (members.length) classes.set(declaration.name, members);
      }
    }
  return { classes, functions };
}
const traceKey = (cls: string, member: string) =>
  `${cls}.${member.replace(/^\[Symbol\.(\w+)\]$/, (_, s) => `Symbol(Symbol.${s})`)}`;

async function resolveTests(locations: string[]): Promise<string[]> {
  const result = new Set<string>();
  for (const location of locations) {
    const at = location.lastIndexOf(':');
    for (const test of await testsAt(location.slice(0, at), Number(location.slice(at + 1))))
      result.add(test);
  }
  return [...result].sort();
}
/** Static coverage: tests whose body contains an identifier or string literal. */
async function testsReferencing(kind: 'identifier' | 'literal', value: string): Promise<string[]> {
  const result = new Set<string>();
  for (const file of await testFiles()) {
    const indexed = await index(file);
    const lines =
      kind === 'identifier'
        ? indexed.identifiers.filter((i) => i.name === value).map((i) => i.line)
        : indexed.literals.filter((l) => l.value === value).map((l) => l.line);
    for (const line of lines) for (const test of await testsAt(file, line)) result.add(test);
  }
  return [...result].sort();
}

type Row = { name: string; tests: string[] };
interface Rows {
  classes: Map<string, Row[]>;
  functions: Row[];
  tools: Row[];
}
const text = {
  en: {
    title: '# API test map',
    language: '[简体中文](zh-CN/test-map.md)',
    intro:
      'This file is generated by `npm run test:map`; do not edit it by hand. Public items are the classes and functions exported by the package entry points, without members documented as `@internal`; classes without public methods or accessors, such as error classes, are not listed. The generator runs every unit and integration test with instrumentation and records direct calls from test code to each public method and accessor. Indirect calls inside the library are not counted, and calls made in a test helper are attributed to the tests that call the helper. Fields (such as `tab.network`) are not listed separately. MCP tools and exported functions are matched statically by name references in test code.',
    cells: 'Each cell lists at most three tests, formatted as `file › test name`.',
    more: (n: number) => `${n} in total`,
    summary: '## Summary',
    summaryHeader: '| Category | Public items | With direct tests |',
    functions: 'Exported functions',
    tools: 'MCP tools',
    uncovered: '## Without direct tests',
    uncoveredIntro:
      'No test calls the following public items directly; they may only be covered indirectly through other APIs:',
    allCovered: 'Every public item has a direct test.',
    members: '## Class members',
    memberHeader: '| Member | Tests | Test |',
    functionsHeading: '## Exported functions',
    functionHeader: '| Function | Tests | Test |',
    toolsHeading: '## MCP tools',
    toolHeader: '| Tool | Tests | Test |',
  },
  zh: {
    title: '# API 测试映射',
    language: '[English](../test-map.md)',
    intro:
      '本文件由 `npm run test:map` 生成，请勿手工编辑。公开项是包入口导出的类与函数，不含标注 `@internal` 的成员；没有公开方法或访问器的类（如错误类）不列出。生成脚本以插桩方式运行全部单元与集成测试，记录测试代码对每个公开方法和访问器的直接调用；库内部的间接调用不计入，测试辅助函数中的调用归属到调用该辅助函数的测试。字段（如 `tab.network`）不单独列出。MCP 工具与导出函数按测试代码中的名称引用静态匹配。',
    cells: '每格最多列出三个测试，格式为 `文件 › 测试名`。',
    more: (n: number) => `等 ${n} 项`,
    summary: '## 汇总',
    summaryHeader: '| 类别 | 公开项 | 有直接测试 |',
    functions: '导出函数',
    tools: 'MCP 工具',
    uncovered: '## 无直接测试',
    uncoveredIntro: '以下公开项没有测试直接调用，可能只经由其他接口间接覆盖：',
    allCovered: '所有公开项均有直接测试。',
    members: '## 类成员',
    memberHeader: '| 成员 | 测试数 | 测试 |',
    functionsHeading: '## 导出函数',
    functionHeader: '| 函数 | 测试数 | 测试 |',
    toolsHeading: '## MCP 工具',
    toolHeader: '| 工具 | 测试数 | 测试 |',
  },
};

/** A test name inside a Markdown table cell. */
export const cellText = (test: string) => test.replaceAll('|', '\\|');
function render(t: (typeof text)['en'], { classes, functions, tools }: Rows): string {
  const cell = (tests: string[]) => {
    if (!tests.length) return '—';
    const shown = tests.slice(0, 3).map(cellText);
    return shown.join('<br>') + (tests.length > 3 ? `<br>${t.more(tests.length)}` : '');
  };
  const row = (name: string, { tests }: Row) => `| ${name} | ${tests.length} | ${cell(tests)} |`;
  const covered = (rows: Row[]) => rows.filter((r) => r.tests.length).length;
  const uncovered = [
    ...[...classes].flatMap(([cls, rows]) =>
      rows.filter((r) => !r.tests.length).map((r) => `\`${cls}.${r.name}\``),
    ),
    ...functions.filter((r) => !r.tests.length).map((r) => `\`${r.name}()\``),
    ...tools.filter((r) => !r.tests.length).map((r) => `\`${r.name}\``),
  ];
  return [
    t.title,
    '',
    t.language,
    '',
    t.intro,
    '',
    t.cells,
    '',
    t.summary,
    '',
    t.summaryHeader,
    '| --- | --: | --: |',
    ...[...classes].map(([cls, rows]) => `| ${cls} | ${rows.length} | ${covered(rows)} |`),
    `| ${t.functions} | ${functions.length} | ${covered(functions)} |`,
    `| ${t.tools} | ${tools.length} | ${covered(tools)} |`,
    '',
    t.uncovered,
    '',
    uncovered.length
      ? t.uncoveredIntro + '\n\n' + uncovered.map((u) => `- ${u}`).join('\n')
      : t.allCovered,
    '',
    t.members,
    '',
    ...[...classes].flatMap(([cls, rows]) => [
      `### ${cls}`,
      '',
      t.memberHeader,
      '| --- | --: | --- |',
      ...rows.map((r) => row(`\`${r.name}\``, r)),
      '',
    ]),
    t.functionsHeading,
    '',
    t.functionHeader,
    '| --- | --: | --- |',
    ...functions.map((r) => row(`\`${r.name}()\``, r)),
    '',
    t.toolsHeading,
    '',
    t.toolHeader,
    '| --- | --: | --- |',
    ...tools.map((r) => row(`\`${r.name}\``, r)),
    '',
  ].join('\n');
}

/** Merges the traces in a directory, one per test-file process: member -> test locations. */
export function readTrace(directory: string): Record<string, string[]> {
  const trace: Record<string, string[]> = {};
  for (const file of readdirSync(directory))
    for (const [member, callers] of Object.entries(
      JSON.parse(readFileSync(join(directory, file), 'utf8')) as Record<string, string[]>,
    ))
      trace[member] = [...new Set([...(trace[member] ?? []), ...callers])].sort();
  return trace;
}
/** The English and Chinese test maps for a trace, formatted for their paths. */
export async function testMaps(
  trace: Record<string, string[]>,
): Promise<Array<{ path: string; content: string }>> {
  const api = await publicApi();
  const serverSource = readFileSync(join(root, 'src/mcp/server.ts'), 'utf8');
  // Every 'browser_*' string literal in the server module is a tool name.
  const tools = [...new Set([...serverSource.matchAll(/'(browser_\w+)'/g)].map((m) => m[1]!))];
  const rows: Rows = { classes: new Map(), functions: [], tools: [] };
  for (const [cls, list] of api.classes) {
    const classRows: Row[] = [];
    for (const member of list)
      classRows.push({
        name: member,
        tests: await resolveTests(trace[traceKey(cls, member)] ?? []),
      });
    rows.classes.set(cls, classRows);
  }
  for (const name of api.functions)
    rows.functions.push({ name, tests: await testsReferencing('identifier', name) });
  for (const name of tools.sort())
    rows.tools.push({ name, tests: await testsReferencing('literal', name) });
  const maps = [];
  for (const [path, strings] of [
    [join(root, 'docs', 'test-map.md'), text.en],
    [join(root, 'docs', 'zh-CN', 'test-map.md'), text.zh],
  ] as const) {
    const options = (await prettier.resolveConfig(path)) ?? {};
    const content = await prettier.format(render(strings, rows), { ...options, filepath: path });
    maps.push({ path, content });
  }
  return maps;
}

async function main() {
  if (!process.argv.includes('--reuse') || !existsSync(traceDir)) {
    rmSync(traceDir, { recursive: true, force: true });
    mkdirSync(traceDir, { recursive: true });
    const run = spawnSync(
      process.execPath,
      [
        '--import',
        './test/api-trace.ts',
        '--test',
        '--test-concurrency=1',
        '--test-timeout=60000',
        'test/unit/*.test.ts',
        'test/integration/*.test.ts',
      ],
      { cwd: root, env: { ...process.env, NODRIVER_API_TRACE: traceDir }, stdio: 'inherit' },
    );
    if (run.status !== 0) throw new Error(`Traced test run failed (${run.status})`);
  }
  for (const { path, content } of await testMaps(readTrace(traceDir))) {
    writeFileSync(path, content);
    console.log(`Wrote ${path}`);
  }
}

if (import.meta.main) await main();
