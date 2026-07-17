/**
 * update-docs.ts — Scan extension source code via TypeScript AST and regenerate
 * the root README.md with an accurate extension catalog.
 *
 * Extracts from each extension's index.ts:
 *   - pi.registerProvider()  → provider id, display name, model list
 *   - pi.registerCommand()   → command name, description
 *   - pi.registerTool()      → tool name, description
 *   - pi.registerShortcut()  → shortcut key, description
 *   - pi.registerFlag()      → flag name, description
 *
 * Repo metadata (title, install URL) is read from the root package.json.
 *
 * Usage: npx tsx scripts/update-docs.ts
 */

import ts from "typescript";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

interface RepoConfig {
  name: string;
  description: string;
  repository: string;
  installUrl: string;
}

interface ProviderInfo {
  id: string;
  name: string;
  models: ModelInfo[];
}

interface ModelInfo {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
}

interface CommandInfo {
  name: string;
  description: string;
}

interface ToolInfo {
  name: string;
  description: string;
}

interface ShortcutInfo {
  key: string;
  description: string;
}

interface FlagInfo {
  name: string;
  description: string;
}

interface ExtensionInfo {
  dirName: string;
  providers: ProviderInfo[];
  commands: CommandInfo[];
  tools: ToolInfo[];
  shortcuts: ShortcutInfo[];
  flags: FlagInfo[];
}

// ── Repo Config ──────────────────────────────────────────────────────────────

function readRepoConfig(repoRoot: string): RepoConfig {
  const pkgPath = path.join(repoRoot, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  return {
    name: pkg.name ?? "pi-extensions",
    description: pkg.description ?? "Collection of pi extensions",
    repository: pkg.repository ?? "",
    installUrl: pkg.installUrl ?? pkg.repository ?? "",
  };
}

// ── AST Helpers ──────────────────────────────────────────────────────────────

/** Get string literal value from a node, or undefined */
function getStringLiteral(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return undefined;
}

/** Get a property value from an object literal expression by property name */
function getObjectProperty(
  obj: ts.ObjectLiteralExpression,
  propName: string,
): ts.Expression | undefined {
  for (const prop of obj.properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      ((ts.isIdentifier(prop.name) && prop.name.text === propName) ||
        (ts.isStringLiteral(prop.name) && prop.name.text === propName))
    ) {
      return prop.initializer;
    }
  }
  return undefined;
}

/** Extract string value from a property in an object literal */
function getStringProp(
  obj: ts.ObjectLiteralExpression,
  propName: string,
): string | undefined {
  const expr = getObjectProperty(obj, propName);
  if (expr) return getStringLiteral(expr);
  return undefined;
}

/** Extract boolean value from a property */
function getBoolProp(
  obj: ts.ObjectLiteralExpression,
  propName: string,
): boolean | undefined {
  const expr = getObjectProperty(obj, propName);
  if (expr && expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr && expr.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

/** Extract number value from a property */
function getNumProp(
  obj: ts.ObjectLiteralExpression,
  propName: string,
): number | undefined {
  const expr = getObjectProperty(obj, propName);
  if (expr && ts.isNumericLiteral(expr)) return Number(expr.text);
  return undefined;
}

/** Extract string array from a property like input: ["text", "image"] */
function getStringArrayProp(
  obj: ts.ObjectLiteralExpression,
  propName: string,
): string[] | undefined {
  const expr = getObjectProperty(obj, propName);
  if (expr && ts.isArrayLiteralExpression(expr)) {
    return expr.elements
      .map((el) => getStringLiteral(el))
      .filter((s): s is string => s !== undefined);
  }
  return undefined;
}

/**
 * Check if a call expression matches `pi.registerXxx(...)`.
 * Returns the method name (e.g. "registerProvider") or undefined.
 */
function getRegisterMethod(
  callExpr: ts.CallExpression,
): string | undefined {
  const expr = callExpr.expression;
  if (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "pi" &&
    expr.name.text.startsWith("register")
  ) {
    return expr.name.text;
  }
  return undefined;
}

// ── Extractors ───────────────────────────────────────────────────────────────

/**
 * Extract models from a top-level static array. Recognizes both `MODELS`
 * (static providers) and `FALLBACK_MODELS` (dynamic-discovery providers,
 * which register the live list at runtime but keep a static snapshot for
 * docs/fallback). `MODELS` takes precedence when both exist.
 */
function extractModelsArray(sourceFile: ts.SourceFile): ModelInfo[] {
  const byName: Record<string, ModelInfo[]> = {};
  const NAMES = ["MODELS", "FALLBACK_MODELS"];

  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;

    for (const decl of stmt.declarationList.declarations) {
      if (
        !ts.isIdentifier(decl.name) ||
        !NAMES.includes(decl.name.text) ||
        !decl.initializer ||
        !ts.isArrayLiteralExpression(decl.initializer)
      ) {
        continue;
      }
      const collected: ModelInfo[] = [];
      for (const el of decl.initializer.elements) {
        if (ts.isObjectLiteralExpression(el)) {
          const model = extractModelInfo(el);
          if (model) collected.push(model);
        }
      }
      byName[decl.name.text] = collected;
    }
  }

  return byName.MODELS ?? byName.FALLBACK_MODELS ?? [];
}

function extractModelInfo(obj: ts.ObjectLiteralExpression): ModelInfo | undefined {
  const id = getStringProp(obj, "id");
  if (!id) return undefined;

  return {
    id,
    name: getStringProp(obj, "name") ?? id,
    reasoning: getBoolProp(obj, "reasoning") ?? false,
    input: getStringArrayProp(obj, "input") ?? ["text"],
    contextWindow: getNumProp(obj, "contextWindow") ?? 0,
    maxTokens: getNumProp(obj, "maxTokens") ?? 0,
  };
}

/** Extract provider info from pi.registerProvider("id", { ... }) */
function extractProvider(
  callExpr: ts.CallExpression,
  modelsArray: ModelInfo[],
): ProviderInfo | undefined {
  const args = callExpr.arguments;
  if (args.length < 2) return undefined;

  const id = getStringLiteral(args[0]);
  if (!id) return undefined;

  const opts = args[1];
  if (!ts.isObjectLiteralExpression(opts)) return undefined;

  const name = getStringProp(opts, "name") ?? id;

  // Models are mapped from the top-level MODELS array via MODELS.map(...)
  // We use the extracted MODELS array directly
  return { id, name, models: modelsArray };
}

/** Extract command info from pi.registerCommand("name", { ... }) */
function extractCommand(callExpr: ts.CallExpression): CommandInfo | undefined {
  const args = callExpr.arguments;
  if (args.length < 2) return undefined;

  const name = getStringLiteral(args[0]);
  if (!name) return undefined;

  const opts = args[1];
  if (!ts.isObjectLiteralExpression(opts)) return undefined;

  return {
    name,
    description: getStringProp(opts, "description") ?? "",
  };
}

/** Extract tool info from pi.registerTool({ name, description, ... }) */
function extractTool(callExpr: ts.CallExpression): ToolInfo | undefined {
  const args = callExpr.arguments;
  if (args.length < 1) return undefined;

  const opts = args[0];
  if (!ts.isObjectLiteralExpression(opts)) return undefined;

  const name = getStringProp(opts, "name");
  if (!name) return undefined;

  return {
    name,
    description: getStringProp(opts, "description") ?? "",
  };
}

/** Extract shortcut info from pi.registerShortcut("key", { ... }) */
function extractShortcut(callExpr: ts.CallExpression): ShortcutInfo | undefined {
  const args = callExpr.arguments;
  if (args.length < 2) return undefined;

  const key = getStringLiteral(args[0]);
  if (!key) return undefined;

  const opts = args[1];
  if (!ts.isObjectLiteralExpression(opts)) return undefined;

  return {
    key,
    description: getStringProp(opts, "description") ?? "",
  };
}

/** Extract flag info from pi.registerFlag("name", { ... }) */
function extractFlag(callExpr: ts.CallExpression): FlagInfo | undefined {
  const args = callExpr.arguments;
  if (args.length < 2) return undefined;

  const name = getStringLiteral(args[0]);
  if (!name) return undefined;

  const opts = args[1];
  if (!ts.isObjectLiteralExpression(opts)) return undefined;

  return {
    name,
    description: getStringProp(opts, "description") ?? "",
  };
}

// ── Main Parser ──────────────────────────────────────────────────────────────

function parseExtension(extDir: string): ExtensionInfo | undefined {
  const indexPath = path.join(extDir, "index.ts");
  if (!fs.existsSync(indexPath)) return undefined;

  const source = fs.readFileSync(indexPath, "utf-8");
  const sourceFile = ts.createSourceFile(
    "index.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );

  const dirName = path.basename(extDir);
  const info: ExtensionInfo = {
    dirName,
    providers: [],
    commands: [],
    tools: [],
    shortcuts: [],
    flags: [],
  };

  // Pre-extract the MODELS array (used by providers)
  const modelsArray = extractModelsArray(sourceFile);

  // Walk the AST looking for pi.registerXxx() calls
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const method = getRegisterMethod(node);
      if (method) {
        switch (method) {
          case "registerProvider": {
            // Dynamic-discovery providers call registerProvider multiple
            // times (cache path, live path, background refresh). Keep only
            // the first occurrence per provider id so the catalog is stable.
            const provider = extractProvider(node, modelsArray);
            if (
              provider &&
              !info.providers.some((p) => p.id === provider.id)
            ) {
              info.providers.push(provider);
            }
            break;
          }
          case "registerCommand": {
            const cmd = extractCommand(node);
            if (cmd) info.commands.push(cmd);
            break;
          }
          case "registerTool": {
            const tool = extractTool(node);
            if (tool) info.tools.push(tool);
            break;
          }
          case "registerShortcut": {
            const shortcut = extractShortcut(node);
            if (shortcut) info.shortcuts.push(shortcut);
            break;
          }
          case "registerFlag": {
            const flag = extractFlag(node);
            if (flag) info.flags.push(flag);
            break;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return info;
}

// ── README Generator ─────────────────────────────────────────────────────────

function formatContextWindow(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 2)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

function generateReadme(config: RepoConfig, extensions: ExtensionInfo[]): string {
  const installUrl = config.installUrl;
  const lines: string[] = [];

  lines.push(`# ${config.name}`);
  lines.push("");
  lines.push(config.description);
  lines.push("");
  lines.push(
    "> **Auto-generated**: The extension catalog below is generated by `scripts/update-docs.ts`.",
  );
  lines.push("> Edit the source files and re-run the script to update.");
  lines.push("");
  lines.push("## Extensions");
  lines.push("");

  // Summary table
  lines.push("| Extension | Providers | Commands | Tools |");
  lines.push("|-----------|-----------|----------|-------|");
  for (const ext of extensions) {
    const providerNames = ext.providers.map((p) => `\`${p.id}\``).join(", ") || "—";
    const commandNames =
      ext.commands.map((c) => `\`/${c.name}\``).join(", ") || "—";
    const toolNames = ext.tools.map((t) => `\`${t.name}\``).join(", ") || "—";
    lines.push(
      `| [${ext.dirName}](./${ext.dirName}) | ${providerNames} | ${commandNames} | ${toolNames} |`,
    );
  }
  lines.push("");

  // Detailed sections
  for (const ext of extensions) {
    lines.push(`### [${ext.dirName}](./${ext.dirName})`);
    lines.push("");

    // Read first descriptive line from extension's README
    const extReadme = path.join(
      path.dirname(import.meta.dirname ?? ""),
      ext.dirName,
      "README.md",
    );
    if (fs.existsSync(extReadme)) {
      const readmeContent = fs.readFileSync(extReadme, "utf-8");
      const firstDesc = readmeContent
        .split("\n")
        .find((l) => l.trim() && !l.startsWith("#"));
      if (firstDesc) {
        lines.push(firstDesc.trim());
        lines.push("");
      }
    }

    // Providers
    for (const provider of ext.providers) {
      lines.push(`**Provider:** ${provider.name} (\`${provider.id}\`)`);
      lines.push("");

      if (provider.models.length > 0) {
        lines.push("<details>");
        lines.push(`<summary>Models (${provider.models.length})</summary>`);
        lines.push("");
        lines.push("| Model | Context | Max Output | Image | Reasoning |");
        lines.push("|-------|---------|------------|-------|-----------|");
        for (const m of provider.models) {
          const img = m.input.includes("image") ? "✓" : "✗";
          const reason = m.reasoning ? "✓" : "✗";
          lines.push(
            `| \`${m.id}\` | ${formatContextWindow(m.contextWindow)} | ${formatContextWindow(m.maxTokens)} | ${img} | ${reason} |`,
          );
        }
        lines.push("");
        lines.push("</details>");
        lines.push("");
      }
    }

    // Commands
    if (ext.commands.length > 0) {
      lines.push("**Commands:**");
      lines.push("");
      for (const c of ext.commands) {
        lines.push(
          c.description
            ? `- \`/${c.name}\` — ${c.description}`
            : `- \`/${c.name}\``,
        );
      }
      lines.push("");
    }

    // Tools
    if (ext.tools.length > 0) {
      lines.push("**Tools:**");
      lines.push("");
      for (const t of ext.tools) {
        lines.push(
          t.description
            ? `- \`${t.name}\` — ${t.description}`
            : `- \`${t.name}\``,
        );
      }
      lines.push("");
    }

    // Shortcuts
    if (ext.shortcuts.length > 0) {
      lines.push("**Shortcuts:**");
      lines.push("");
      for (const s of ext.shortcuts) {
        lines.push(
          s.description
            ? `- \`${s.key}\` — ${s.description}`
            : `- \`${s.key}\``,
        );
      }
      lines.push("");
    }

    // Flags
    if (ext.flags.length > 0) {
      lines.push("**Flags:**");
      lines.push("");
      for (const f of ext.flags) {
        lines.push(
          f.description
            ? `- \`--${f.name}\` — ${f.description}`
            : `- \`--${f.name}\``,
        );
      }
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }

  // Footer
  lines.push("## Installation");
  lines.push("");
  if (installUrl) {
    lines.push("```bash");
    lines.push(`pi install ${installUrl}`);
    lines.push("```");
    lines.push("");
    lines.push("Update with:");
    lines.push("");
    lines.push("```bash");
    lines.push("pi update --extensions");
    lines.push("```");
    lines.push("");
  }
  lines.push("## License");
  lines.push("");
  lines.push("MIT");
  lines.push("");

  return lines.join("\n");
}

// ── Entry Point ──────────────────────────────────────────────────────────────

function main() {
  const repoRoot = path.resolve(import.meta.dirname ?? ".", "..");
  const readmePath = path.join(repoRoot, "README.md");

  const config = readRepoConfig(repoRoot);
  console.log(`  Repo: ${config.name}`);

  // Find all extension directories (containing index.ts)
  const entries = fs.readdirSync(repoRoot, { withFileTypes: true });
  const extensions: ExtensionInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "scripts") continue;

    const extDir = path.join(repoRoot, entry.name);
    const info = parseExtension(extDir);
    if (info) {
      extensions.push(info);
      console.log(
        `  ✓ ${info.dirName}: ${info.providers.length} provider(s), ${info.commands.length} command(s), ${info.tools.length} tool(s)`,
      );
    }
  }

  if (extensions.length === 0) {
    console.error("No extensions found.");
    process.exit(1);
  }

  const readme = generateReadme(config, extensions);
  fs.writeFileSync(readmePath, readme, "utf-8");
  console.log(`\n✓ Updated ${readmePath}`);
}

main();
