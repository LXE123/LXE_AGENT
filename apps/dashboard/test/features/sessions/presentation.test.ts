import { describe, expect, test } from "bun:test";
import { acknowledgeConversationSend, conversationRows, type PendingMessage } from "../../../src/features/sessions/presentation";
import { boundConversationWindow, appendConversationWindow, prependConversationWindow } from "../../../src/features/sessions/model";
import type { SessionDetailPayload, SessionMessage, DesktopConversationTurnPayload } from "../../../src/api/payloads";

const page = (start: number, end: number): SessionDetailPayload => ({ session: { session_id: "s" },
  messages: Array.from({length: end - start}, (_, index) => ({ role: "user", content: `message ${start + index}`, display_id: `g${start + index}:0`, display_group_id: `g${start + index}` })),
  messages_page: { fetched_at: 1, total: 1000, raw_message_total: 1000, limit: 10, oldest_cursor: `g${start}`, newest_cursor: `g${end-1}`, previous_cursor: start ? `g${start}` : null, has_previous: start > 0, next_cursor: end < 1000 ? `g${end-1}` : null, has_next: end < 1000, group_cursors: Array.from({length:end-start},(_,i)=>`g${start+i}`) }
} as SessionDetailPayload);
const pending: PendingMessage = { pendingId: "client", sessionId: "s", text: "same text", attachments: [], createdAt: 10 };
const turn = { turn_id: "turn", message_id: "server", client_message_id: "client", text: pending.text, created_at: 10, started_at: 10, settled_at: 20, user_persisted_at: 12, state: "completed" } as DesktopConversationTurnPayload;
const stored: SessionMessage = { display_group_id: "g1", display_id: "g1:0", role: "user", client_message_id: "client", message_id: "server", content: pending.text, turn: {turn_id:"turn", status:"completed", elapsed_ms:10} };
describe("unified conversation identity", () => {
  test("keeps steering between the preceding and following responses, live and after reopen", () => {
    const steering = { ...stored, client_message_id: "second", message_id: "m2", content: "new direction", source_reason: "steering" };
    const answer = (id: string): SessionMessage => ({ ...stored, role: "assistant", id, content: [{ type: "text", text: id }] });
    const history = [stored, answer("before"), steering, answer("after")];
    const active = { ...turn, state: "running", steering: [{ client_message_id: "second", message_id: "m2", text: "new direction", created_at: 20 }],
      stream: { display_metrics: { phase: "waiting_model" }, process_parts: ["before", "after"].map((id, index) => ({
        type: "text", part_id: id + ":0", sequence: index + 1, text: id, status: "completed", presentation: index ? "final" : "process",
      })) } } as DesktopConversationTurnPayload;
    for (const turns of [[], [active]]) {
      const rows = conversationRows(history, turns, []).filter(row => row.kind === "message");
      expect(rows.map(row => row.id)).toEqual(["user:client", "before:0", "user:second", "after:0"]);
    }
    expect(conversationRows([stored], [active], [{ ...pending, pendingId: "second", steering: true, turnId: "turn" }])
      .filter(row => row.id === "user:second").map(row => row.status)).toEqual(["steering"]);
  });

  test("pending, activity and persistence share one user key for every arrival order", () => {
    for (const [messages, turns, sends] of [ [[], [], [pending]], [[], [turn], [pending]], [[stored], [], [pending]], [[stored], [turn], [pending]], [[stored], [turn], []] ] as [SessionMessage[], DesktopConversationTurnPayload[], PendingMessage[]][]) {
      expect(conversationRows(messages, turns, sends).filter(r=>r.message?.role === "user").map(r=>r.id)).toEqual(["user:client"]);
    }
    expect(conversationRows([], [], [pending, {...pending, pendingId:"other"}]).length).toBe(2);
  });
  test("only waiting user messages carry a queue label, including after history loads", () => {
    const first = { ...turn, state: "queued" as const, started_at: 0, settled_at: 0 };
    const next = { ...first, turn_id: "next", message_id: "next-server", client_message_id: "next-client", created_at: 11 };
    const savedInput = { ...stored, created_at: pending.createdAt / 1000, turn: { turn_id: first.turn_id, status: null, elapsed_ms: null } };
    for (const history of [[], [savedInput]]) {
      const waiting = conversationRows(history, [first, next], [pending]);
      expect(waiting.map(row => [row.id, row.status])).toEqual([["user:client", "queued"], ["user:next-client", "queued"]]);
      const running = conversationRows(history, [{ ...first, state: "running" }, next], []);
      expect(running.filter(row => row.status === "queued").map(row => row.id)).toEqual(["user:next-client"]);
      expect(running.find(row => row.id === "status:turn")?.status).toBe("running");
    }
  });
  test("failed sends stay visible; timestamps alone never retire a bubble", () => {
    expect(conversationRows([], [turn], [pending]).some(r=>r.id === "user:client")).toBe(true);
    expect(conversationRows([], [], [{...pending,error:"actual transport failure"}])[0]?.error).toBe("actual transport failure");
  });
  test("environment metadata hides internal content without inspecting user text", () => {
    expect(conversationRows([{...stored,source_reason:"environment_context"}],[],[])).toHaveLength(0);
    expect(conversationRows([{...stored,environmentContext:{cwd:"/tmp"}}],[],[])).toHaveLength(0);
    expect(conversationRows([{...stored,content:"<environment_context>example</environment_context>"}],[],[]).filter(row=>row.kind === "message")).toHaveLength(1);
  });
  test("only trusted stop records are hidden before grouping; legacy and user text remain visible", () => {
    const content = "<turn_aborted>用户主动中断了上一回合。</turn_aborted>";
    const hidden = { ...stored, display_group_id: "internal", display_id: "internal:0", source_reason: "turn_aborted", content };
    expect(conversationRows([hidden], [], [])).toEqual([]);
    expect(conversationRows([stored, hidden], [], [])).toEqual(conversationRows([stored], [], []));
    for (const userContent of [content, "System: 用户已从桌面停止当前任务。\n再提问一下"]) {
      const user = { ...stored, content: userContent, source_reason: "turn_input" };
      expect(conversationRows([user, hidden], [], []).find(row => row.kind === "message")?.message?.content).toBe(userContent);
    }
    const old = { ...hidden, source_reason: undefined };
    expect(conversationRows([old], [], []).some(row => row.message?.content === content)).toBe(true);
  });
  test("stopped turns expose one footer after persistence even when the last message is internal", () => {
    const boundary: SessionMessage = { ...stored, display_group_id: "end", source_reason: "turn_aborted",
      turn: { turn_id: "turn", status: "cancelled", elapsed_ms: 10, forkable: true } };
    for (const live of [[], [{ ...turn, state: "cancelled" as const }]]) {
      const rows = conversationRows([stored, boundary], live, []);
      expect(rows.filter(row => row.answerMeta?.forkable)).toHaveLength(1);
      expect(rows.at(-1)?.answerMeta?.forkable).toBe(true);
    }
    expect(conversationRows([stored], [], []).some(row => row.answerMeta?.forkable)).toBe(false);
  });
  test("failed text keeps its live block ID and remains a process row after reload", () => {
    const failed: SessionMessage = { ...stored, id: "failed", role: "assistant", stopReason: "error",
      source_reason: "assistant_partial", content: [{ type: "text", text: "prefix", contentIndex: 2 }] };
    const live = { ...turn, stream: { process_parts: [
      { type: "text", part_id: "failed:2", sequence: 1, text: "prefix", status: "error", presentation: "process" },
    ], display_metrics: {} } } as DesktopConversationTurnPayload;
    for (const turns of [[], [live]]) {
      const rows = conversationRows([stored, failed], turns, []);
      expect(rows.filter(row => row.id.startsWith("failed:")).map(row => [row.id, row.status, row.presentation]))
        .toEqual([["failed:2", "error", "process"]]);
      expect(rows.filter(row => row.answerMeta?.text)).toHaveLength(0);
    }
  });
  test("streaming and persisted block identity and failed attempt order survive handoff", () => {
    const streaming = {...turn,stream:{display_metrics:{phase:"generating_answer"},process_parts:[
      {type:"text",part_id:"failed:0",sequence:1,text:"partial failure",status:"error",presentation:"process"},
      {type:"thinking",part_id:"answer:0",sequence:2,text:"thinking",status:"completed",redacted_count:0},
      {type:"text",part_id:"answer:1",sequence:3,text:"final",status:"completed",presentation:"final"},
    ]}} as DesktopConversationTurnPayload;
    const history = {...stored, role:"assistant", id:"answer",content:[{type:"thinking",thinking:"thinking"},{type:"text",text:"final"}]} as SessionMessage;
    const rows = conversationRows([stored,history],[streaming],[]);
    expect(rows.filter(r=>r.message?.role === "assistant").map(r=>r.id)).toEqual(["failed:0","answer:0","answer:1"]);
    expect(rows.find(r=>r.id === "answer:1")?.status).toBe("completed");
  });
  test("legacy display keys remain stable when older groups are prepended", () => {
    const last = conversationRows(page(10,20).messages,[],[]).map(r=>r.id);
    expect(conversationRows(page(0,20).messages,[],[]).slice(10).map(r=>r.id)).toEqual(last);
  });
});
describe("bounded reading window", () => {
  test("1000 groups remain bounded while paging in both directions", () => {
    let current = page(990,1000);
    for (let i=980;i>=0;i-=10) {
      current = boundConversationWindow(prependConversationWindow(current,page(i,i+10)),[`g${i+10}`],"older");
      expect(current.messages_page.group_cursors!.length).toBeLessThanOrEqual(60);
    }
    expect(current.messages[0]!.display_group_id).toBe("g0");
    expect(current.messages_page.has_next).toBe(true);
    for (let i=60;i<1000;i+=10) current=boundConversationWindow(appendConversationWindow(current,page(i,i+10)),[],"newer");
    expect(current.messages.at(-1)!.display_group_id).toBe("g999");
    expect(new Set(current.messages.map(m=>m.display_id)).size).toBe(current.messages.length);
  });
  test("byte budget evicts distant groups but protects a single oversized visible group", () => {
    const current=page(0,3);current.messages[1]!.content="x".repeat(17*1024*1024);
    const bounded=boundConversationWindow(current,["g1"]);
    expect(bounded.messages.map(m=>m.display_group_id)).toEqual(["g1"]);
    expect(bounded.messages_page.has_previous).toBe(true);expect(bounded.messages_page.has_next).toBe(true);
  });
});


test("late send acknowledgements cannot overwrite a running or completed activity snapshot", () => {
  const current={session_id:"s",active:null,latest:turn,queued:[]};
  const result={session_id:"s",turn_id:"turn",message_id:"server",created:false,state:"running" as const};
  expect(acknowledgeConversationSend(current,result,pending)).toBe(current);
  const accepted=acknowledgeConversationSend(undefined,result,pending);
  expect(accepted.active?.client_message_id).toBe("client");
  expect(conversationRows([],accepted.active?[accepted.active]:[],[pending]).filter(row=>row.message?.role === "user")).toHaveLength(1);
});

test("explicit skill markers survive history while injected instructions stay internal", () => {
  const message = { ...stored, content: "使用 /office-xlsx /unknown", invoked_skills: ["office-xlsx"] };
  const injected = { role: "user", content: "<skill_content>full instructions</skill_content>", source_reason: "skill_invocation" } as SessionMessage;
  const rows = conversationRows([message, injected], [], []).filter(row => row.kind === "message");
  expect(rows).toHaveLength(1);
  expect(rows[0]?.message?.invoked_skills).toEqual(["office-xlsx"]);
  expect(rows[0]?.message?.content).toBe(message.content);
});
