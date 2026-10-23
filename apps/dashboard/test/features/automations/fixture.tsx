import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AutomationsPage } from "../../../src/features/automations/AutomationsPage";
import { setDashboardTransportForTests } from "../../../src/api/client";
import "../../../src/styles.css";
setDashboardTransportForTests({ async call(call) { const response = await fetch("/__automations", {method:"POST",body:JSON.stringify(call)}); if (!response.ok) throw new Error(await response.text()); return response.json(); } });
function Fixture() {
  const [opened, setOpened] = useState("");
  return <><nav style={{padding:8}}><button onClick={()=>{document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";}}>切换明暗</button><output aria-label="打开的会话">{opened}</output></nav><AutomationsPage ready onOpenSession={async (session, turn)=>{setOpened(`${session.session_id} / ${turn}`);}}/></>;
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><Fixture/></QueryClientProvider>);
