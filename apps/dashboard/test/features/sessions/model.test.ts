import { describe, expect, test } from "bun:test";
import type { SessionDetailPayload, SessionMessage, SessionPayload } from "../../../src/api/payloads";
import {
  groupSidebarSessions,
  mergeLatestConversationWindow,
  prependConversationWindow,
} from "../../../src/features/sessions/model";

const messages = (ids: string[], suffix = "old"): SessionMessage[] => ids.map((id) => ({
  display_group_id: id,
  role: "user",
  content: `${id}-${suffix}`,
}));

const detail = (
  ids: string[],
  options: { previous?: string | null; fetchedAt?: number; suffix?: string; total?: number } = {},
): SessionDetailPayload => ({
  session: {
    session_id: "session-1",
    title: "Session",
    source: {},
    source_summary: { platform: "desktop", chat_type: "direct" },
    workspace: { directory: "/workspace", worktree: "/workspace" },
    model: "test",
    reasoning_effort: "",
    model_config: {},
    pinned_at: 0,
    created_at: 1,
    last_active_at: 1,
    message_count: ids.length,
    tool_call_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    api_call_count: 0,
  },
  messages: messages(ids, options.suffix),
  messages_page: {
    fetched_at: options.fetchedAt ?? 1,
    total: options.total ?? ids.length,
    raw_message_total: options.total ?? ids.length,
    limit: 10,
    oldest_cursor: ids[0] ?? null,
    newest_cursor: ids.at(-1) ?? null,
    previous_cursor: options.previous ?? null,
    has_previous: Boolean(options.previous),
  },
});

const sidebarSession = (sessionId: string, pinnedAt: number): SessionPayload => ({
  ...detail([]).session,
  session_id: sessionId,
  title: sessionId,
  pinned_at: pinnedAt,
});

describe("sidebar session groups", () => {
  test("separates pinned sessions while preserving server order", () => {
    const sessions = [sidebarSession("pin-2", 2), sidebarSession("pin-1", 1), sidebarSession("recent", 0)];
    const grouped = groupSidebarSessions(sessions, false);
    expect(grouped.pinned.map((session) => session.session_id)).toEqual(["pin-2", "pin-1"]);
    expect(grouped.recent.map((session) => session.session_id)).toEqual(["recent"]);
  });

  test("keeps search results in one server-ordered group", () => {
    const sessions = [sidebarSession("pinned", 2), sidebarSession("recent", 0)];
    expect(groupSidebarSessions(sessions, true)).toEqual({ pinned: [], recent: sessions });
  });
});

describe("conversation cursor windows", () => {
  test("replaces an overlapping tail and preserves the loaded prefix", () => {
    const current = detail(["g0", "g1", "g2", "g3"], { fetchedAt: 10 });
    const latest = detail(["g2", "g3", "g4"], { fetchedAt: 20, suffix: "new", total: 5 });

    const merged = mergeLatestConversationWindow(current, latest);

    expect(merged.messages.map((message) => message.display_group_id))
      .toEqual(["g0", "g1", "g2", "g3", "g4"]);
    expect(merged.messages.find((message) => message.display_group_id === "g3")?.content).toBe("g3-new");
    expect(merged.messages_page).toMatchObject({
      fetched_at: 20,
      total: 5,
      oldest_cursor: "g0",
      newest_cursor: "g4",
      previous_cursor: null,
      has_previous: false,
    });
  });

  test("keeps the reading window when the latest tail has no overlap", () => {
    const merged = mergeLatestConversationWindow(
      detail(["g0", "g1"]),
      detail(["g10", "g11"], { total: 12 }),
    );
    expect(merged.messages.map((message) => message.display_group_id)).toEqual(["g0", "g1"]);
    expect(merged.messages_page.oldest_cursor).toBe("g0");
    expect(merged.messages_page.has_next).toBe(true);
  });

  test("prepends older groups without replacing the latest watermark", () => {
    const current = detail(["g2", "g3"], { previous: "g2", fetchedAt: 20, total: 4 });
    const earlier = detail(["g0", "g1"], { fetchedAt: 30, total: 4 });

    const merged = prependConversationWindow(current, earlier);

    expect(merged.messages.map((message) => message.display_group_id))
      .toEqual(["g0", "g1", "g2", "g3"]);
    expect(merged.messages_page).toMatchObject({
      fetched_at: 20,
      oldest_cursor: "g0",
      newest_cursor: "g3",
      has_previous: false,
    });
  });
});

test("context display chooses coherent live or durable values, keeps valid zero and suppresses pre-reset activity", async () => {
  const {selectContextDisplay,clearResetStreams}=await import("../../../src/features/sessions/context-display");
  const snapshot = {version:1 as const,turn_id:"old",updated_at:100,model:"old",context_tokens:0,context_window_tokens:1000,
    context_source:"usage_calibrated" as const,input_tokens:50,output_tokens:3,cache_read_input_tokens:40,cache_creation_input_tokens:0};
  const saved={...detail(["g1"]),context_display:snapshot};
  expect(selectContextDisplay(null,saved)).toMatchObject({metrics:snapshot,restored:true});
  expect(selectContextDisplay(null,detail(["g1"])).metrics).toBeNull();
  const activity: import("@lxe/desktop-protocol").DesktopConversationActivityPayload = {
    session_id:"session-1",queued:[],latest:null,active:{
      turn_id:"new",message_id:"m",text:"hello",state:"running",started_at:200,user_persisted_at:200,settled_at:0,
      stream:{seq:1,state:"delta",content:"",thinking:"",redacted_thinking_count:0,thinking_elapsed_ms:0,
        tool_pending:false,tool_elapsed_ms:0,tool_steps:[],process_parts:[],
        display_metrics:{status:"running",phase:"waiting_model",elapsed_ms:0,model:"new",
          context_tokens:2000,context_window_tokens:10000,context_source:"estimated",
          input_tokens:0,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}},
    },
  };
  expect(selectContextDisplay(activity,saved)).toMatchObject({metrics:{model:"new",context_window_tokens:10000,context_tokens:2000},restored:false});
  expect(selectContextDisplay(activity,{...saved,context_display:null,context_reset_at:300}).metrics).toBeNull();
  expect(clearResetStreams(activity,300)?.active?.stream).toBeUndefined();
  expect(clearResetStreams(activity,100)).toBe(activity);
  const older={...detail(["g0"]),context_display:{...snapshot,context_tokens:900}};
  expect(prependConversationWindow(saved,older).context_display).toEqual(snapshot);
  const latest={...detail(["g5"]),context_display:{...snapshot,context_tokens:80}};
  expect(mergeLatestConversationWindow(saved,latest).context_display).toEqual(latest.context_display);
});
