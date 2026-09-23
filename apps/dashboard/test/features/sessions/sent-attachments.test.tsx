import React from "react";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UnifiedConversationRow } from "../../../src/features/sessions/view";
import { partitionSentAttachments } from "../../../src/features/sessions/sent-attachments";
import { FILE_TYPE_ICONS, attachmentSuffix } from "../../../src/features/sessions/file-attachment-display";
import type { ConversationRow } from "../../../src/features/sessions/presentation";

const image = { attachment_id: "image", name: "photo.png", size_bytes: 1, media_type: "image/png" };
const file = { attachment_id: "file", name: "report.zip", size_bytes: 1, media_type: "application/zip" };
const noop = async () => {};
function markup(attachments: typeof file[], text = "Message text") {
  const row: ConversationRow = { id: "row", groupId: "group", turnId: "turn", kind: "message", createdAt: 1,
    message: { role: "user", display_group_id: "group", content: text, attachments } };
  return renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>
    <UnifiedConversationRow row={row} expanded={false} onToggle={() => {}}
      onOpenFile={noop} onRevealFile={noop} onOpenAttachment={noop} attachmentSessionId="session" />
  </QueryClientProvider>);
}
test("groups images and files without changing their relative order", () => {
  const second = { ...image, attachment_id: "second" };
  expect(partitionSentAttachments([file, image, second])).toEqual({ images: [image, second], files: [file] });
  const html = markup([file, image]);
  expect(html.indexOf('class="sent-image-list"')).toBeLessThan(html.indexOf('class="sent-file-list"'));
  expect(html.indexOf('class="sent-file-list"')).toBeLessThan(html.indexOf('class="message-card role-user"'));
  expect(html).toContain(">ZIP</span>");
});
test("omits empty sections and the text bubble in attachment-only messages", () => {
  expect(markup([file])).not.toContain('class="sent-image-list"');
  expect(markup([image])).not.toContain('class="sent-file-list"');
  expect(markup([file, image], "")).not.toContain('class="message-card role-user"');
  expect(markup([], "text")).not.toContain('class="sent-attachments"');
});
test("sent file cards share the draft icon and extension display", () => {
  const attachments = ["orders.csv", "page.html", "old.xls", "new.xlsx", "archive.zip", "README"]
    .map((name, index) => ({ ...file, attachment_id: `file-${index}`, name }));
  const html = markup(attachments);
  expect(html.match(/class="sent-file-card"/g)).toHaveLength(attachments.length);
  for (const extension of ["CSV", "HTML", "XLS", "XLSX"]) {
    expect(html).toContain(`src="${FILE_TYPE_ICONS[extension]}"`);
    expect(html).toContain(`>${extension}</span>`);
  }
  expect(html.match(/class="lucide lucide-file"/g)).toHaveLength(2);
  expect(html).toContain(">ZIP</span>");
  expect(html).not.toContain(">FILE</span>");
  expect(html).not.toContain("input-attachment-remove");
  expect(attachmentSuffix("README")).toBe("");
});
