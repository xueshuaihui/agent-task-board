import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

/**
 * v0.0.4 #24（QA#23 阻断）的静态回归哨兵。
 *
 * 缺陷模式：provider 类构造参数类型位用 `import type` 导入的符号（HEAD 实例：
 * creation.service.ts 的 SkillsService）。`nest build`（tsc, emitDecoratorMetadata）
 * 会把该参数编译成 `design:paramtypes = [Function]`，真机 Nest 报
 * `Nest can't resolve dependencies of the CreationService (…, ?)`——而 vitest 侧
 * 因 esbuild 根本不产元数据、全靠 nest-di-shim 补表，573 个用例照常全绿。
 * 也就是说：**单测面永远复现不了这个缺陷，只能静态拦**。
 * （真机维度的兜底门禁是 `npm run boot:smoke -w @atb/api`，两者互补。）
 *
 * 判据与 nest build 的语义对齐：被 @Injectable/@Controller/@CanPlay… 装饰的类，
 * 其构造参数类型若是「type-only 导入的具名符号」即违规。豁免：
 *  - 带 `@Inject(TOKEN)` 的参数（Nest 按 token 解析，不看元数据类型）；
 *  例外说明：类型是**本文件内**声明的接口不算（元数据编成真实引用）——本检查看
 *  不到它，因为它不在 type-only import 集合里。
 */

const SRC_DIR = path.resolve(__dirname, '../..');

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue;
    const st = statSync(full);
    if (st.isDirectory()) listSourceFiles(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** 收集一个文件里所有 type-only 导入的本地名（`import type {X}` 与 `import {type X}`）。 */
function typeOnlyImportedNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause || !ts.isImportClause(stmt.importClause)) continue;
    const bindings = stmt.importClause.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const clauseIsTypeOnly = stmt.importClause.isTypeOnly === true;
    for (const spec of bindings.elements) {
      if (clauseIsTypeOnly || spec.isTypeOnly) names.add(spec.name.text);
    }
  }
  return names;
}

interface Violation {
  file: string;
  className: string;
  paramIndex: number;
  typeName: string;
}

function paramTypeName(p: ts.ParameterDeclaration): string | null {
  const t = p.type;
  if (!t) return null;
  if (ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName)) return t.typeName.text;
  return null;
}

function hasInjectDecorator(p: ts.ParameterDeclaration): boolean {
  return (p.modifiers ?? []).some((m) => {
    if (!ts.isDecorator(m)) return false;
    const expr = m.expression;
    const name = ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)
      ? expr.expression.text
      : ts.isIdentifier(expr) ? expr.text : '';
    return name === 'Inject';
  });
}

function scanFile(file: string): Violation[] {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const typeOnly = typeOnlyImportedNames(sf);
  if (typeOnly.size === 0) return [];
  const violations: Violation[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && (node.modifiers ?? []).some(isNestDecorated)) {
      const ctor = node.members.find((m) => ts.isConstructorDeclaration(m));
      if (ctor) {
        ctor.parameters.forEach((p, i) => {
          if (hasInjectDecorator(p)) return;
          const typeName = paramTypeName(p);
          if (typeName && typeOnly.has(typeName)) {
            violations.push({
              file: path.relative(SRC_DIR, file),
              className: node.name?.text ?? 'anonymous',
              paramIndex: i,
              typeName,
            });
          }
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

/** 类上有 Nest 装饰器（Injectable / Controller / NestMiddleware 的 Use 等）即视作 provider。 */
function isNestDecorated(modifier: ts.Node): boolean {
  if (!ts.isDecorator(modifier)) return false;
  const expr = modifier.expression;
  const name = ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)
    ? expr.expression.text
    : ts.isIdentifier(expr) ? expr.text : '';
  return name === 'Injectable' || name === 'Controller';
}

describe('DI 元数据静态哨兵（#24 / QA#23）', () => {
  it('provider 构造参数类型不得是 type-only 导入（nest build 会编成 Function）', () => {
    const files = listSourceFiles(SRC_DIR);
    expect(files.length).toBeGreaterThan(50);
    const violations = files.flatMap(scanFile);
    expect(
      violations.map((v) => `${v.file} ${v.className} ctor[${v.paramIndex}]: "${v.typeName}" 被 type-only 导入`),
      '把列出的类型改回值导入（import { X }）——它出现在靠元数据注入的构造参数类型位',
    ).toEqual([]);
  });
});
