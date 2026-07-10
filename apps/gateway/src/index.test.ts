import { expect, test } from "bun:test";
import {
  ChannelRegistry,
  GatewayLifecycle,
  GatewayStatusFiles,
  HeartbeatWakeQueue,
  SessionBindingStore,
  SessionRouter,
  SessionRuntimeState,
  SessionScheduler,
  WorkerSupervisor,
  buildPermissionPolicy,
  loadProjectEnv,
} from "./index";

test("the thin Gateway entrypoint exports core modules without starting services", () => {
  expect(ChannelRegistry).toBeTypeOf("function");
  expect(GatewayLifecycle).toBeTypeOf("function");
  expect(GatewayStatusFiles).toBeTypeOf("function");
  expect(HeartbeatWakeQueue).toBeTypeOf("function");
  expect(SessionBindingStore).toBeTypeOf("function");
  expect(SessionRouter).toBeTypeOf("function");
  expect(SessionRuntimeState).toBeTypeOf("function");
  expect(SessionScheduler).toBeTypeOf("function");
  expect(WorkerSupervisor).toBeTypeOf("function");
  expect(buildPermissionPolicy).toBeTypeOf("function");
  expect(loadProjectEnv).toBeTypeOf("function");
});
