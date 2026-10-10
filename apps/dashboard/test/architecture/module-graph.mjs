// Keep the pinned TypeScript 7 API behind this test-only adapter.
import { API } from "typescript/unstable/async";
import { SyntaxKind as K } from "typescript/unstable/ast";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

const portable = path => path.split(sep).join("/");
export async function readModuleGraph(config, sourceRoot) {
  const root = resolve(sourceRoot);
  const paths = readdirSync(root, { recursive: true }).map(String).filter(p => /\.(ts|tsx)$/.test(p));
  if (!paths.length) throw new Error(`No TypeScript sources in ${root}`);
  const api = new API({ cwd: dirname(resolve(config)) });
  let snapshot;
  try {
    snapshot = await api.updateSnapshot({ openProjects: [resolve(config)] });
    const project = snapshot.getProject(resolve(config));
    if (!project) throw new Error(`Project not loaded: ${config}`);
    const errors = await project.program.getSyntacticDiagnostics();
    if (errors.length) throw new Error(`Syntax errors in ${config}: ${JSON.stringify(errors)}`);
    const graph = new Map();
    for (const path of paths) {
      const file = await project.program.getSourceFile(resolve(root, path));
      if (!file) throw new Error(`Source omitted from compiler project: ${path}`);
      const edges = [];
      const add = (literal, typeOnly = false, reexport = false) => {
        if (!literal || ![K.StringLiteral, K.NoSubstitutionTemplateLiteral].includes(literal.kind)) return;
        const specifier = literal.text;
        let target = specifier;
        if (specifier.startsWith(".")) {
          const base = resolve(dirname(file.fileName), specifier.split("?")[0]);
          const found = [base, base + ".ts", base + ".tsx", resolve(base, "index.ts"), resolve(base, "index.tsx")]
            .find(candidate => existsSync(candidate) && statSync(candidate).isFile());
          if (!found) throw new Error(`Unresolved local dependency: ${path} -> ${specifier}`);
          target = portable(relative(root, found));
        }
        edges.push({ target, typeOnly, reexport });
      };
      const visit = node => {
        if (node.kind === K.ImportDeclaration) {
          const clause = node.importClause;
          const elements = clause?.namedBindings?.elements;
          add(node.moduleSpecifier, clause?.phaseModifier === K.TypeKeyword
            || Boolean(!clause?.name && elements?.length && elements.every(e => e.isTypeOnly)));
        } else if (node.kind === K.ExportDeclaration) {
          const elements = node.exportClause?.elements;
          add(node.moduleSpecifier, node.isTypeOnly || Boolean(elements?.length && elements.every(e => e.isTypeOnly)), true);
        } else if (node.kind === K.ImportEqualsDeclaration) {
          add(node.moduleReference.expression, node.isTypeOnly);
        } else if (node.kind === K.ImportType) {
          add(node.argument.literal, true);
        } else if (node.kind === K.CallExpression && (node.expression.kind === K.ImportKeyword
          || node.expression.kind === K.Identifier && node.expression.text === "require")) {
          add(node.arguments[0]);
        }
        node.forEachChild(visit);
      };
      visit(file);
      graph.set(portable(path), edges);
    }
    return graph;
  } finally {
    await snapshot?.dispose();
    await api.close();
  }
}

export function dashboardBoundaryViolations(graph) {
  const errors = [];
  const transports = new Set(["api/client.ts", "api/queries.ts", "api/model-actions.ts", "api/mcp-actions.ts", "api/session-actions.ts"]);
  const pages = new Set(["features/sessions/SessionSidebar.tsx", "features/sessions/ConversationPage.tsx", "features/capabilities/CapabilitiesPage.tsx"]);
  const privateState = new Set(["@tanstack/react-query", "features/sessions/display-controller.ts", "features/sessions/composer-draft.ts",
    "features/sessions/attachment-draft.ts", "features/sessions/live-stream.ts", "api/session-actions.ts"]);
  // Follow barrel exports, but not the implementations behind an allowed hook.
  const exportedTargets = (target, seen = new Set()) => {
    if (seen.has(target)) return [];
    seen.add(target);
    return [target, ...(graph.get(target) ?? []).filter(e => e.reexport && !e.typeOnly).flatMap(e => exportedTargets(e.target, seen))];
  };
  for (const [file, edges] of graph) {
    for (const edge of edges) {
      if (edge.target === "main.tsx") errors.push(`${file}: must not depend on App (including types)`);
      if (edge.typeOnly) continue;
      for (const target of exportedTargets(edge.target)) {
        if (target === "api/client.ts" && !transports.has(file)) errors.push(`${file}: raw transport belongs to query/action modules`);
        if ((file === "main.tsx" || pages.has(file)) && privateState.has(target)) errors.push(`${file}: state/cache ownership must stay behind hooks (${target})`);
        if (pages.has(file) && ["api/model-actions.ts", "api/mcp-actions.ts", "features/sessions/use-session-workspace.ts", "features/sessions/use-conversation-events.ts"].includes(target))
          errors.push(`${file}: pages receive semantic actions and read-only data (${target})`);
        if (file === "api/session-actions.ts" && (target === "react" || target === "@tanstack/react-query" || target.startsWith("features/sessions/")))
          errors.push(`${file}: protocol requests must not own UI/session state (${target})`);
      }
    }
  }
  return [...new Set(errors)];
}
