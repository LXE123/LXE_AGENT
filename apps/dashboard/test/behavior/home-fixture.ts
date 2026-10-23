import type { SessionPayload, SkillStatPayload, StatsOverviewPayload } from "@lxe/desktop-protocol";

// Opt-in sample data for the real Home component; never reads production sessions.
export function createHomeFixture(initialMode = "ready") {
  let mode = initialMode;
  const pending: (() => void)[] = [];
  const now = Date.now() / 1000;
  const titles = ["整理 FBA 发货计划与库存建议", "Voxel Chinese dragon garden scene", "为工作台统一页面设计与交互", "检查本周销售报表与异常订单", "预览各种 Markdown 文本样式界面", "分析跨工作区的技能使用情况与后续改进"];
  return {
    ready() { mode = "ready"; pending.splice(0).forEach(resolve => resolve()); },
    rpc(operation: string, input: Record<string, unknown>, sessions: SessionPayload[]): Promise<unknown> | undefined {
      if (!["stats.overview", "stats.skills.list", "sessions.list"].includes(operation)) return undefined;
      return (async () => {
        if (mode === "loading") await new Promise<void>(resolve => pending.push(resolve));
        if (mode === "error" || (mode === "skills-error" && operation === "stats.skills.list")) {
          throw new Error(`SQLITE_BUSY: fixture ${operation} database is locked`);
        }
        const empty = mode === "empty";
        if (operation === "stats.overview") return {
          days: Number(input.days), peak_hour: null, daily: [], modules: [],
          totals: { turns: empty ? 18 : 32, error_turns: 0, tool_calls: 180, llm_calls: 40,
            input_tokens: 740000, output_tokens: 34868, skill_activations: empty ? 0 : 9, skill_executions: empty ? 0 : 12, skill_failures: empty ? 0 : 1 },
        } satisfies StatsOverviewPayload;
        if (operation === "stats.skills.list") return { days: Number(input.days), items: empty ? [] : [
          { name: "Amazon 备货算法参数管理", executions: 28, failures: 0 },
          { name: "frontend-design", executions: 20, failures: 1 },
          { name: "lark-sheets", executions: 12, failures: 2 },
        ].map(skill => ({ ...skill, module: "default", activations: skill.executions, execution_turns: skill.executions,
          duration_ms: 10000, last_used_at: now })) satisfies SkillStatPayload[] };
        const items = empty ? [] : sessions.slice(0, 6).map((session, index) => ({ ...session,
          title: titles[index]!, last_active_at: now - index * 18000,
          input_tokens: 480000 - index * 14000, output_tokens: 2868 + index * 1200,
        })).filter(session => (!input.workspace_id || session.workspace_id === input.workspace_id)
          && (!input.query || session.title.includes(String(input.query))));
        const offset = Number(input.offset ?? 0), limit = Number(input.limit ?? 10);
        return { items: items.slice(offset, offset + limit), total: items.length, offset, limit };
      })();
    },
  };
}
