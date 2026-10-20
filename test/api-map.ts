// Generates docs/test-map.md (English) and docs/zh-CN/test-map.md: which tests exercise each
// public API member and MCP tool.
// Usage: node test/api-map.ts            (runs unit + integration tests with tracing; needs Chrome)
//        node test/api-map.ts --reuse    (rebuilds the document from the last trace)
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as prettier from 'prettier';
import * as typescript from 'prettier/plugins/typescript';

const root = resolve(import.meta.dirname, '..');
const traceDir = join(root, 'dev', 'api-trace');

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
// One trace per test-file process.
const trace: Record<string, string[]> = {};
for (const file of readdirSync(traceDir))
  for (const [member, callers] of Object.entries(
    JSON.parse(readFileSync(join(traceDir, file), 'utf8')) as Record<string, string[]>,
  ))
    trace[member] = [...new Set([...(trace[member] ?? []), ...callers])].sort();

type Node = { type: string; loc: { start: { line: number }; end: { line: number } } } & Record<
  string,
  any
>;
async function parse(file: string): Promise<{ ast: Node; text: string }> {
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
const label = (node: Node | undefined): string | undefined =>
  node?.type === 'Literal' && typeof node.value === 'string'
    ? node.value
    : node?.type === 'TemplateLiteral'
      ? node.quasis
          .map(
            (q: Node, i: number) =>
              q.value.cooked +
              (i < node.expressions.length ? '${' + (node.expressions[i].name ?? '…') + '}' : ''),
          )
          .join('')
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
async function index(file: string): Promise<FileIndex> {
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

// Public members from the source: classes exported by the entry points, minus private/protected.
const sources: Record<string, string> = {
  Browser: 'src/browser/browser.ts',
  BrowserContext: 'src/browser/context.ts',
  Download: 'src/browser/download.ts',
  Tab: 'src/page/tab.ts',
  Frame: 'src/page/frames.ts',
  JSHandle: 'src/page/frames.ts',
  Element: 'src/dom/element.ts',
  Network: 'src/page/network.ts',
  Route: 'src/page/network.ts',
  Mouse: 'src/input/input.ts',
  Keyboard: 'src/input/input.ts',
  Connection: 'src/protocol/connection.ts',
  Session: 'src/protocol/connection.ts',
  TargetSession: 'src/protocol/connection.ts',
  WebSocketTransport: 'src/transport/websocket.ts',
  PipeTransport: 'src/transport/pipe.ts',
  PipeDecoder: 'src/transport/pipe.ts',
  ProxyForwarder: 'src/optional/proxy.ts',
  BrowserSessionManager: 'src/mcp/manager.ts',
};
const members = new Map<string, string[]>();
for (const [cls, file] of Object.entries(sources)) {
  const { ast } = await parse(file);
  const list: string[] = [];
  walk(ast, (node) => {
    if (node.type !== 'ClassDeclaration' || node.id?.name !== cls) return;
    for (const member of node.body.body as Node[]) {
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
      if (!list.includes(name)) list.push(name);
    }
  });
  members.set(cls, list);
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

const functions = [
  'findExecutable',
  'acquireProfileLock',
  'keyDefinition',
  'parseChord',
  'createBrowserMcpServer',
  'createBrowserMcpHttpService',
  'startBrowserMcpHttpServer',
  'startBrowserMcpSocketServer',
];
const serverSource = readFileSync(join(root, 'src/mcp/server.ts'), 'utf8');
// Every 'browser_*' string literal in the server module is a tool name.
const tools = [...new Set([...serverSource.matchAll(/'(browser_\w+)'/g)].map((m) => m[1]!))].sort();

type Row = { name: string; tests: string[] };
const classRows = new Map<string, Row[]>();
for (const [cls, list] of members) {
  const rows: Row[] = [];
  for (const member of list)
    rows.push({ name: member, tests: await resolveTests(trace[traceKey(cls, member)] ?? []) });
  classRows.set(cls, rows);
}
const functionRows: Row[] = [];
for (const name of functions)
  functionRows.push({ name, tests: await testsReferencing('identifier', name) });
const toolRows: Row[] = [];
for (const name of tools) toolRows.push({ name, tests: await testsReferencing('literal', name) });

const text = {
  en: {
    title: '# API test map',
    language: '[简体中文](zh-CN/test-map.md)',
    intro:
      'This file is generated by `npm run test:map`; do not edit it by hand. The generator runs every unit and integration test with instrumentation and records direct calls from test code to each public method and accessor. Indirect calls inside the library are not counted, and calls made in a test helper are attributed to the tests that call the helper. Fields (such as `tab.network`) are not listed separately. MCP tools and exported functions are matched statically by name references in test code.',
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
      '本文件由 `npm run test:map` 生成，请勿手工编辑。生成脚本以插桩方式运行全部单元与集成测试，记录测试代码对每个公开方法和访问器的直接调用；库内部的间接调用不计入，测试辅助函数中的调用归属到调用该辅助函数的测试。字段（如 `tab.network`）不单独列出。MCP 工具与导出函数按测试代码中的名称引用静态匹配。',
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

function render(t: (typeof text)['en']): string {
  const cell = (tests: string[]) => {
    if (!tests.length) return '—';
    const shown = tests.slice(0, 3).map((test) => test.replaceAll('|', '\|'));
    return shown.join('<br>') + (tests.length > 3 ? `<br>${t.more(tests.length)}` : '');
  };
  const row = (name: string, { tests }: Row) => `| ${name} | ${tests.length} | ${cell(tests)} |`;
  const covered = (rows: Row[]) => rows.filter((r) => r.tests.length).length;
  const uncovered = [
    ...[...classRows].flatMap(([cls, rows]) =>
      rows.filter((r) => !r.tests.length).map((r) => `\`${cls}.${r.name}\``),
    ),
    ...functionRows.filter((r) => !r.tests.length).map((r) => `\`${r.name}()\``),
    ...toolRows.filter((r) => !r.tests.length).map((r) => `\`${r.name}\``),
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
    ...[...classRows].map(([cls, rows]) => `| ${cls} | ${rows.length} | ${covered(rows)} |`),
    `| ${t.functions} | ${functionRows.length} | ${covered(functionRows)} |`,
    `| ${t.tools} | ${toolRows.length} | ${covered(toolRows)} |`,
    '',
    t.uncovered,
    '',
    uncovered.length
      ? t.uncoveredIntro + '\n\n' + uncovered.map((u) => `- ${u}`).join('\n')
      : t.allCovered,
    '',
    t.members,
    '',
    ...[...classRows].flatMap(([cls, rows]) => [
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
    ...functionRows.map((r) => row(`\`${r.name}()\``, r)),
    '',
    t.toolsHeading,
    '',
    t.toolHeader,
    '| --- | --: | --- |',
    ...toolRows.map((r) => row(`\`${r.name}\``, r)),
    '',
  ].join('\n');
}

for (const [path, strings] of [
  [join(root, 'docs', 'test-map.md'), text.en],
  [join(root, 'docs', 'zh-CN', 'test-map.md'), text.zh],
] as const) {
  const options = (await prettier.resolveConfig(path)) ?? {};
  writeFileSync(path, await prettier.format(render(strings), { ...options, filepath: path }));
  console.log(`Wrote ${path}`);
}
