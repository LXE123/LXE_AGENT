import { test, expect } from "bun:test";
import { parseManagedManifest, parseManagedState, managedCredentialFor, singleManagedState } from "../src/managed-llm";
const credential = { provider: "deepseek", model: "deepseek-v4-flash", api_key: "dummy", credential_revision: "a".repeat(64), invalid_revision: "", fetched_at: 1 };
test("manifest validates default membership, uniqueness and credential revision without reflecting keys", () => {
  const state = singleManagedState(credential);
  expect(parseManagedState(state)).toEqual(state);
  expect(() => parseManagedManifest({ ...state, models: [...state.models, ...state.models] })).toThrow("duplicate");
  expect(() => parseManagedManifest({ ...state, default_target: null })).toThrow("default");
  expect(() => parseManagedState({ ...state, credentials: [{ ...credential, credential_revision: "b".repeat(64) }] })).toThrow("does not match");
  expect(() => parseManagedState({ ...state, credentials: [{ ...credential, api_key: "" }] })).toThrow("invalid managed LLM credential");
  state.credentials[0]!.invalid_revision = credential.credential_revision;
  expect(managedCredentialFor(state, credential)).toBeUndefined();
});
