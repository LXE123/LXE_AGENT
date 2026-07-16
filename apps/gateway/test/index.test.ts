import { expect, test } from "bun:test";
import {
  ChannelRegistry,
  GatewayLifecycle,
  HeartbeatWakeQueue,
  SessionBindingStore,
  SessionRouter,
  SessionRuntimeState,
  SessionScheduler,
  buildPermissionPolicy,
  loadProjectEnv,
} from "../src/index";

test("the desktop Gateway library exports core modules without starting services", () => {
  expect(ChannelRegistry).toBeTypeOf("function");
  expect(GatewayLifecycle).toBeTypeOf("function");
  expect(HeartbeatWakeQueue).toBeTypeOf("function");
  expect(SessionBindingStore).toBeTypeOf("function");
  expect(SessionRouter).toBeTypeOf("function");
  expect(SessionRuntimeState).toBeTypeOf("function");
  expect(SessionScheduler).toBeTypeOf("function");
  expect(buildPermissionPolicy).toBeTypeOf("function");
  expect(loadProjectEnv).toBeTypeOf("function");
});
