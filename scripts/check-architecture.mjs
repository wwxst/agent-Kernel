/**
 * 文件目的：自动保护 src/ 内已经确定的模块依赖方向。
 *
 * 文件职责：读取 TypeScript AST，检查静态 import / export、动态 import、
 * import type、require 和 import = require 是否违反架构边界。不负责检查 npm 包依赖，
 * 也不替代 TypeScript 类型检查。
 *
 * 依赖规则：
 *   - protocol：只允许依赖 protocol 自身，是最底层。
 *   - core / tools / model：只允许依赖各自模块和 protocol。
 *   - ui：允许依赖 ui、core、protocol。
 *   - cli.ts：唯一组装入口，可以依赖所有模块。
 *
 * 模块关系：由 npm run architecture:check 启动；测试见
 * test/architecture.test.mjs。只使用项目已有的 TypeScript 和 Node.js。
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const allowedDependencies = new Map([
  ["protocol", new Set(["protocol"])],
  ["core", new Set(["core", "protocol"])],
  ["tools", new Set(["tools", "protocol"])],
  ["model", new Set(["model", "protocol"])],
  ["ui", new Set(["ui", "core", "protocol"])],
  ["entry", new Set(["entry", "core", "tools", "model", "ui", "protocol"])],
]);

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function layerOf(file, srcRoot) {
  const relative = path.relative(srcRoot, file);
  if (relative === "cli.ts") return "entry";
  const first = relative.split(path.sep)[0];
  return allowedDependencies.has(first) ? first : null;
}

async function listTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listTypeScriptFiles(absolute));
    } else if (entry.isFile() && /\.(?:ts|tsx|mts|cts)$/.test(entry.name) && !/\.d\.(?:ts|mts|cts)$/.test(entry.name)) {
      files.push(absolute);
    }
  }
  return files.sort();
}

function compilerOptionsFor(root) {
  const defaults = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2023,
    allowImportingTsExtensions: true,
  };
  const configPath = path.join(root, "tsconfig.json");
  if (!ts.sys.fileExists(configPath)) return defaults;

  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, undefined, configPath);
  const errors = parsed.errors.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    throw new Error(errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")).join("\n"));
  }
  return { ...defaults, ...parsed.options };
}

/** 从 AST 提取所有能静态确定的模块引用；计算路径的动态导入会单独报错。 */
function collectReferences(sourceFile) {
  const references = [];
  const uncheckable = [];

  function add(specifier, node) {
    references.push({
      specifier,
      position: node.getStart(sourceFile),
    });
  }

  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      add(node.moduleSpecifier.text, node.moduleSpecifier);
    }

    if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteralLike(argument.literal)) {
        add(argument.literal.text, argument.literal);
      } else {
        uncheckable.push({ position: node.getStart(sourceFile), kind: "import type" });
      }
    }

    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      if (expression && ts.isStringLiteralLike(expression)) {
        add(expression.text, expression);
      } else {
        uncheckable.push({ position: node.getStart(sourceFile), kind: "import = require" });
      }
    }

    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteralLike(argument)) {
          add(argument.text, argument);
        } else {
          uncheckable.push({
            position: node.getStart(sourceFile),
            kind: isDynamicImport ? "动态 import()" : "require()",
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { references, uncheckable };
}

/**
 * 检查一个项目的 src/ 依赖边界。
 *
 * 返回值只包含静态检查结果，调用方可以直接在测试中断言，不需要启动子进程。
 */
export async function checkArchitecture(root = projectRoot) {
  const absoluteRoot = path.resolve(root);
  const srcRoot = path.join(absoluteRoot, "src");
  const compilerOptions = compilerOptionsFor(absoluteRoot);
  const host = ts.sys;
  const files = await listTypeScriptFiles(srcRoot);
  const violations = [];
  let checkedImports = 0;

  for (const file of files) {
    const sourceLayer = layerOf(file, srcRoot);
    const relativeFile = toPosix(path.relative(absoluteRoot, file));

    if (!sourceLayer) {
      violations.push({
        file: relativeFile,
        line: 1,
        message: "src/ 下的文件没有归入已定义模块；新增模块前先明确它的依赖边界",
      });
      continue;
    }

    const sourceText = await readFile(file, "utf8");
    const scriptKind = path.extname(file) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, scriptKind);

    for (const diagnostic of sourceFile.parseDiagnostics) {
      const location = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      violations.push({
        file: relativeFile,
        line: location.line + 1,
        message: `TypeScript 语法无法解析：${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
      });
    }

    const { references, uncheckable } = collectReferences(sourceFile);

    for (const item of uncheckable) {
      const location = sourceFile.getLineAndCharacterOfPosition(item.position);
      violations.push({
        file: relativeFile,
        line: location.line + 1,
        message: `${item.kind} 使用了非字符串路径，无法静态确认依赖方向`,
      });
    }

    for (const reference of references) {
      const resolved = ts.resolveModuleName(reference.specifier, file, compilerOptions, host).resolvedModule?.resolvedFileName;
      const looksRelative = reference.specifier.startsWith(".") || path.isAbsolute(reference.specifier);

      if (!resolved) {
        if (looksRelative) {
          const location = sourceFile.getLineAndCharacterOfPosition(reference.position);
          violations.push({
            file: relativeFile,
            line: location.line + 1,
            specifier: reference.specifier,
            message: "项目内相对导入无法解析；请修正路径，避免架构检查漏掉目标模块",
          });
        }
        continue;
      }

      const targetFile = path.resolve(resolved);
      if (!isInside(srcRoot, targetFile)) continue;

      checkedImports++;
      const targetLayer = layerOf(targetFile, srcRoot);
      const location = sourceFile.getLineAndCharacterOfPosition(reference.position);

      if (!targetLayer) {
        violations.push({
          file: relativeFile,
          line: location.line + 1,
          specifier: reference.specifier,
          message: "导入目标位于 src/，但没有归入已定义模块",
        });
        continue;
      }

      if (!allowedDependencies.get(sourceLayer).has(targetLayer)) {
        violations.push({
          file: relativeFile,
          line: location.line + 1,
          specifier: reference.specifier,
          sourceLayer,
          targetLayer,
          message: `${sourceLayer} 不允许依赖 ${targetLayer}`,
        });
      }
    }
  }

  violations.sort((a, b) =>
    a.file.localeCompare(b.file) ||
    a.line - b.line ||
    (a.message ?? "").localeCompare(b.message ?? ""),
  );

  return {
    checkedFiles: files.length,
    checkedImports,
    violations,
  };
}

async function main() {
  const result = await checkArchitecture();
  if (result.violations.length > 0) {
    process.stderr.write(`架构边界检查失败：发现 ${result.violations.length} 个问题\n`);
    for (const item of result.violations) {
      const detail = item.specifier ? ` (${item.specifier})` : "";
      process.stderr.write(`- ${item.file}:${item.line}${detail}：${item.message}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `架构边界检查通过：检查 ${result.checkedFiles} 个源文件、${result.checkedImports} 条项目内部依赖。\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`架构边界检查无法执行：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
