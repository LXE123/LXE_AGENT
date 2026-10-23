import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AutomationsPage } from "../../../src/features/automations/AutomationsPage";
import { setDashboardTransportForTests } from "../../../src/api/client";
import "../../../src/styles.css";
const params = new URLSearchParams(location.search);
const scenario = params.get("scenario");
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light";
setDashboardTransportForTests({ async call(call) {
  if (call.operation === "automations.list") {
    if (scenario === "empty") return { items: [] };
    if (scenario === "loading") await new Promise(resolve => setTimeout(resolve, 60_000));
    if (scenario === "error") throw new Error("Fixture: SQLITE_BUSY: database is locked (automations.list)");
  }
  if (call.operation === "automations.save" && scenario === "save-error") throw new Error("Fixture: schedule.start_at is invalid: non-existent local time");
  if (call.operation === "automations.preview" && scenario === "pending") await new Promise(resolve => setTimeout(resolve, 4000));
 const response = await fetch("/__automations", {method:"POST",body:JSON.stringify(call)}); if (!response.ok) throw new Error(await response.text()); return response.json(); } });
function Fixture() {
  const [opened, setOpened] = useState("");
  return <><nav style={{padding:8}}><button onClick={()=>{document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";}}>切换明暗</button><output aria-label="打开的会话">{opened}</output></nav><AutomationsPage ready={scenario !== "offline"} onOpenSession={async (session, turn)=>{setOpened(`${session.session_id} / ${turn}`);}}/></>;
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><Fixture/></QueryClientProvider>);
