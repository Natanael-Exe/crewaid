import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';

/**
 * The R7 Prisma call-site audit's walker, shared by the core allowlist
 * (`prisma-allowlist.test.ts`) and the Enterprise one
 * (`ee/prisma-allowlist-ee.test.ts`, D-238), so both key call sites the same
 * way and neither lists the other's files.
 */

export const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
export const SOURCE_ROOT = join(REPO_ROOT, 'apps', 'orchestrator', 'src');

export type ScopedAllowlistEntry = {
  file: string;
  scope: string;
  receiver: 'prisma' | 'tx';
  model: string;
  operation: string;
  occurrence?: number;
  policy: 'scoped';
  ownershipToken: string;
};

export type ExemptAllowlistEntry = {
  file: string;
  scope: string;
  receiver: 'prisma' | 'tx';
  model: string;
  operation: string;
  occurrence?: number;
  policy: 'exempt';
  reason: string;
};

export type AllowlistEntry = ScopedAllowlistEntry | ExemptAllowlistEntry;

export type PrismaCallSite = {
  file: string;
  scope: string;
  receiver: 'prisma' | 'tx';
  model: string;
  operation: string;
  occurrence: number;
  sourceText: string;
};

function propertyPath(expression: ts.Expression): string[] | undefined {
  if (ts.isPropertyAccessExpression(expression)) {
    const parent = propertyPath(expression.expression);
    return parent === undefined ? undefined : [...parent, expression.name.text];
  }
  if (ts.isElementAccessExpression(expression)) {
    const parent = propertyPath(expression.expression);
    if (parent === undefined) {
      return undefined;
    }
    const argument = expression.argumentExpression;
    const name =
      argument !== undefined &&
      (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
        ? argument.text
        : '<computed>';
    return [...parent, name];
  }
  if (ts.isIdentifier(expression)) {
    return [expression.text];
  }
  return expression.kind === ts.SyntaxKind.ThisKeyword ? ['this'] : undefined;
}

/**
 * Resolves the enclosing named class method or function for a Prisma call site.
 * Anonymous callbacks (e.g. `$transaction(async (tx) => ...)`) climb to their
 * enclosing method or function so moving lines or adding comments never breaks
 * allowlist keys.
 */
function enclosingScope(node: ts.Node): string {
  let cur: ts.Node | undefined = node.parent;
  let methodOrFn: string | undefined;
  let className: string | undefined;
  while (cur !== undefined) {
    if (methodOrFn === undefined) {
      if (
        (ts.isMethodDeclaration(cur) ||
          ts.isGetAccessorDeclaration(cur) ||
          ts.isSetAccessorDeclaration(cur)) &&
        cur.name !== undefined
      ) {
        methodOrFn =
          ts.isIdentifier(cur.name) ||
          ts.isPrivateIdentifier(cur.name) ||
          ts.isStringLiteral(cur.name)
            ? cur.name.text
            : cur.name.getText();
      } else if (ts.isConstructorDeclaration(cur)) {
        methodOrFn = 'constructor';
      } else if (ts.isFunctionDeclaration(cur) && cur.name !== undefined) {
        methodOrFn = cur.name.text;
      } else if (
        (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) &&
        cur.parent !== undefined &&
        ts.isVariableDeclaration(cur.parent) &&
        ts.isIdentifier(cur.parent.name)
      ) {
        methodOrFn = cur.parent.name.text;
      } else if (
        (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) &&
        cur.parent !== undefined &&
        ts.isPropertyAssignment(cur.parent) &&
        (ts.isIdentifier(cur.parent.name) || ts.isStringLiteral(cur.parent.name))
      ) {
        methodOrFn = cur.parent.name.text;
      }
    }
    if (className === undefined && (ts.isClassDeclaration(cur) || ts.isClassExpression(cur))) {
      className = cur.name?.text;
      break;
    }
    cur = cur.parent;
  }
  if (className !== undefined && methodOrFn !== undefined) return `${className}.${methodOrFn}`;
  if (methodOrFn !== undefined) return methodOrFn;
  if (className !== undefined) return className;
  return '<module>';
}

export function parsePrismaCallSites(file: string, source: string): PrismaCallSite[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const callSites: PrismaCallSite[] = [];
  const counts = new Map<string, number>();

  function visit(node: ts.Node): void {
    // Scan tagged templates as well as calls so raw SQL (`$queryRaw`) is audited too.
    if (ts.isCallExpression(node) || ts.isTaggedTemplateExpression(node)) {
      const path = propertyPath(ts.isCallExpression(node) ? node.expression : node.tag);
      const isTransactionClient =
        (path?.[0] === 'tx' || path?.[0] === 'prisma') && (path.length === 2 || path.length === 3);
      const isInjectedClient =
        path?.[0] === 'this' && path[1] === 'prisma' && (path.length === 3 || path.length === 4);
      if (path !== undefined && (isTransactionClient || isInjectedClient)) {
        const receiver = path[0] === 'tx' ? 'tx' : 'prisma';
        const isDirectClientCall = isTransactionClient ? path.length === 2 : path.length === 3;
        const model = isDirectClientCall ? '$client' : isTransactionClient ? path[1] : path[2];
        const operation = isDirectClientCall
          ? path[isTransactionClient ? 1 : 2]
          : path[isTransactionClient ? 2 : 3];
        if (model !== undefined && operation !== undefined) {
          const scope = enclosingScope(node);
          const base = `${file}#${scope}:${receiver}.${model}.${operation}`;
          const occurrence = (counts.get(base) ?? 0) + 1;
          counts.set(base, occurrence);
          callSites.push({
            file,
            scope,
            receiver,
            model,
            operation,
            occurrence,
            sourceText: node.getText(sourceFile),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return callSites;
}

function sourceFiles(root: string, skipDirectories: ReadonlySet<string>): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (skipDirectories.has(entry.name)) continue;
      files.push(...sourceFiles(path, skipDirectories));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(path);
    }
  }
  return files.sort();
}

/**
 * Every Prisma call site under `root`. The core audit skips `ee` directories
 * (D-238): they are audited by the Enterprise suite, and the core must pass
 * with them deleted.
 */
export function discoverPrismaCallSites(
  root: string,
  options: { readonly skipDirectories?: readonly string[] } = {},
): PrismaCallSite[] {
  return sourceFiles(root, new Set(options.skipDirectories ?? [])).flatMap((path) =>
    parsePrismaCallSites(relative(REPO_ROOT, path), readFileSync(path, 'utf8')),
  );
}

export function callSiteKey(
  site: Pick<PrismaCallSite, 'file' | 'scope' | 'receiver' | 'model' | 'operation'> & {
    occurrence?: number;
  },
): string {
  const base = `${site.file}#${site.scope}:${site.receiver}.${site.model}.${site.operation}`;
  return site.occurrence !== undefined && site.occurrence > 1 ? `${base}#${site.occurrence}` : base;
}

export function unlistedCallSites(
  actual: PrismaCallSite[],
  allowlist: AllowlistEntry[],
): PrismaCallSite[] {
  const listed = new Set(allowlist.map(callSiteKey));
  return actual.filter((site) => !listed.has(callSiteKey(site)));
}
