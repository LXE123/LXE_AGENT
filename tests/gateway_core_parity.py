"""Deterministic Python reference fixture for the Bun Gateway core tests."""
from __future__ import annotations

import asyncio
import copy
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from agent_runtime.worker import RuntimeWorker
from gateway.models import InboundEvent
from gateway.session_router import SessionRouter
from gateway.session_scheduler import RunHandle, SessionScheduler
from gateway.heartbeat_wake import HeartbeatWakeManager
from gateway.autonomy_suspension import (
    is_session_autonomy_suspended,
    reset_autonomy_suspension_for_tests,
)
from gateway.steering_mode import (
    is_session_steering_enabled,
    reset_steering_mode_for_tests,
)
import gateway.session_router as router_module
import shared.env as env_module
from shared.agent_io import AgentJob
from shared.permission_policy_loader import PermissionPolicyError, build_permission_policy, load_permission_policy
from shared.session_bindings import SessionBindingEntry, SessionBindingStore, SessionSource
import shared.session_bindings as bindings_module


def _agent_job(session_id: str, job_id: str) -> AgentJob:
    return AgentJob(
        job_id=job_id,
        session_id=session_id,
        session_key=f"key:{session_id}",
        response_route_id=f"route:{job_id}",
        user_id="user",
        conversation_id="chat",
        is_group=False,
        message_id=f"message:{job_id}",
        user_input=f"input:{job_id}",
        sender_nick="Tester",
        source={"platform": "feishu", "chat_id": "chat", "chat_type": "dm", "user_id": "user"},
        raw_data={"keep": "yes", "system_events": [{"id": "old"}]},
    )


def env_fixture() -> dict[str, Any]:
    files = {
        ".env": "A=env\nB=env\nexport C='single value'\n",
        ".env.local": "A=local\nB=local\nD=local\n",
        "config/runtime.env": 'A=runtime\nE="line\\nnext"\n',
    }
    with TemporaryDirectory() as raw_root:
        root = Path(raw_root)
        for relative, content in files.items():
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
        names = {"A", "B", "C", "D", "E"}
        previous = {name: os.environ.get(name) for name in names}
        previous_loaded = env_module._ENV_LOADED
        try:
            for name in names:
                os.environ.pop(name, None)
            os.environ["A"] = "process"
            env_module._ENV_LOADED = False
            env_module.load_project_env(
                root / ".env",
                local_path=root / ".env.local",
                runtime_path=root / "config" / "runtime.env",
            )
            result = {name: os.environ[name] for name in sorted(names)}
        finally:
            env_module._ENV_LOADED = previous_loaded
            for name, value in previous.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value
    return {"files": files, "initial": {"A": "process"}, "result": result}


def session_fixture() -> dict[str, Any]:
    cases = [
        {"platform": "feishu", "chat_id": "dm", "chat_type": "p2p"},
        {
            "platform": "feishu",
            "chat_id": "group",
            "chat_type": "chat",
            "user_id": "open",
            "user_id_alt": "union",
        },
        {
            "platform": "feishu",
            "chat_id": "group",
            "chat_type": "group",
            "user_id": "open",
            "thread_id": "thread",
        },
        {"platform": "slack", "chat_id": "channel", "chat_type": "channel"},
    ]
    results = [
        {"input": item, "key": SessionSource.from_dict(item).session_key, "json": SessionSource.from_dict(item).to_dict()}
        for item in cases
    ]
    original_now = bindings_module._utc_now_text
    try:
        bindings_module._utc_now_text = lambda: "2026-01-01T00:00:00+00:00"
        with TemporaryDirectory() as raw_root:
            path = Path(raw_root) / "sessions.json"
            source = SessionSource.from_dict(
                {
                    "platform": "feishu",
                    "chat_id": "群聊",
                    "chat_type": "dm",
                    "user_id": "user",
                    "extra": {"label": "中文"},
                }
            )
            entry = SessionBindingStore(path).bind(source, session_id="session-fixed")
            serialized = json.loads(path.read_text(encoding="utf-8"))
    finally:
        bindings_module._utc_now_text = original_now
    return {"cases": results, "binding_entry": entry.to_dict(), "binding_file": serialized}


def permission_fixture() -> dict[str, Any]:
    data = {
        "bots": {
            "PRIMARY": {"key": "shared", "app_id": "app-1", "skill_types": ["default"]},
            "BACKUP": {"key": "shared", "app_id": "app-2", "skill_types": ["default"]},
        },
        "users": {
            "Alice": {"union_id": "union-1", "allow": ["PRIMARY"]},
            "Admin": {"union_id": "union-admin", "allow": ["*"]},
        },
    }
    policy = build_permission_policy(data, path="fixture.yaml")
    invalid: list[dict[str, str]] = []
    invalid_values = {
        "unknown_alias": (
            {
                **copy.deepcopy(data),
                "users": {"Alice": {"union_id": "union-1", "allow": ["UNKNOWN"]}},
            },
            "references unknown bot alias",
        ),
        "wildcard_mixed": (
            {
                **copy.deepcopy(data),
                "users": {"Alice": {"union_id": "union-1", "allow": ["*", "PRIMARY"]}},
            },
            "cannot mix",
        ),
    }
    for name, (value, expected) in invalid_values.items():
        try:
            build_permission_policy(value, path="fixture.yaml")
        except PermissionPolicyError as exc:
            invalid.append({"name": name, "contains": expected, "error": str(exc)})
    return {
        "data": data,
        "bot_id_to_key": dict(policy.bot_id_to_key),
        "user_agent_policy": {key: sorted(value) for key, value in policy.user_agent_policy.items()},
        "access": [
            {"user": "union-1", "bot": "app-2", "allowed": True},
            {"user": "union-admin", "bot": "app-1", "allowed": True},
            {"user": "union-admin", "bot": "unknown", "allowed": False},
        ],
        "invalid": invalid,
    }


class _Adapter:
    platform = "feishu"

    def __init__(self) -> None:
        self.outbound: list[Any] = []

    async def handle_outbound(self, request: Any) -> None:
        self.outbound.append(request)


class _Registry:
    def __init__(self, adapter: _Adapter) -> None:
        self.adapter = adapter

    def get(self, platform: str) -> _Adapter:
        assert platform == "feishu"
        return self.adapter


class _Bindings:
    def __init__(self, *, bound: bool = False) -> None:
        self.bound = bound

    def get(self, _key: str) -> None:
        return SimpleNamespace(session_id="session-fixed") if self.bound else None

    def get_or_create(self, _source: SessionSource) -> Any:
        return SimpleNamespace(session_id="session-fixed")

    def rotate(self, _source: SessionSource) -> Any:
        return SimpleNamespace(session_id="session-rotated")


class _RouterScheduler:
    def __init__(self) -> None:
        self.jobs: list[AgentJob] = []

    async def enqueue(self, job: AgentJob, *, front: bool = False) -> None:
        assert not front
        self.jobs.append(job)

    def clear_pending(self, _session_id: str) -> int:
        return 0

    def request_stop(self, _session_id: str) -> bool:
        return False

    def has_inflight_work(self, _session_id: str) -> bool:
        return False


def _authorized_identity() -> tuple[str, str, str]:
    policy = load_permission_policy(ROOT / "config" / "permission_policy.yaml")
    for user_name, aliases in policy.user_name_to_allow_aliases.items():
        for alias in sorted(aliases):
            if alias != "*":
                return (
                    policy.user_name_to_union_id[user_name],
                    policy.bot_alias_to_app_id[alias],
                    user_name,
                )
    raise RuntimeError("fixture policy has no explicitly authorized user")


async def router_fixture() -> dict[str, Any]:
    union_id, app_id, user_name = _authorized_identity()

    async def no_op(*_args: Any, **_kwargs: Any) -> None:
        return None

    async def load_none(*_args: Any, **_kwargs: Any) -> None:
        return None

    async def create_session(**kwargs: Any) -> Any:
        return SimpleNamespace(session_id=kwargs["session_id"], source=kwargs["source"])

    async def pop_events(_session_id: str) -> list[dict[str, Any]]:
        return [{"event_id": "pending-1", "text": "done"}]

    router_module.create_response_route_context = no_op
    router_module.load_agent_session = load_none
    router_module.create_agent_session = create_session
    router_module.pop_agent_session_pending_events = pop_events

    def make_event(text: str = "hello", *, bot: str = app_id) -> InboundEvent:
        return InboundEvent(
            platform="feishu",
            event_type="agent_message",
            user_input=text,
            user_id="open-user",
            conversation_id="chat-1",
            is_group=False,
            message_id="message-1",
            sender_nick=user_name,
            response_route_id="route-1",
            union_id=union_id,
            source={
                "platform": "feishu",
                "chat_id": "chat-1",
                "chat_type": "p2p",
                "user_id": "open-user",
                "user_id_alt": union_id,
                "user_name": user_name,
            },
            raw_data={"app_id": bot, "union_id": union_id, "opaque": "keep"},
        )

    adapter = _Adapter()
    scheduler = _RouterScheduler()
    router = SessionRouter(registry=_Registry(adapter))
    router.bind_scheduler(scheduler)  # type: ignore[arg-type]
    router._bindings = _Bindings()  # type: ignore[assignment]
    decision = await router.route_message(make_event())
    routed_job = scheduler.jobs[0].to_dict()
    routed_job["job_id"] = "<generated>"

    controls: dict[str, Any] = {}
    for command in ("/stop", "/clear", "/steer", "／STOP now"):
        control_adapter = _Adapter()
        control_router = SessionRouter(registry=_Registry(control_adapter))
        control_router.bind_scheduler(_RouterScheduler())  # type: ignore[arg-type]
        control_router._bindings = _Bindings()  # type: ignore[assignment]
        control_decision = await control_router.route_message(make_event(command))
        controls[command] = {
            "route_kind": control_decision.route_kind,
            "feedback": control_adapter.outbound[-1].payload["markdown"],
        }

    stale_controls: dict[str, Any] = {}
    for command in ("/stop", "/clear", "/steer"):
        reset_autonomy_suspension_for_tests()
        reset_steering_mode_for_tests()
        stale_adapter = _Adapter()
        stale_router = SessionRouter(registry=_Registry(stale_adapter))
        stale_router.bind_scheduler(_RouterScheduler())  # type: ignore[arg-type]
        stale_router._bindings = _Bindings(bound=True)  # type: ignore[assignment]
        stale_decision = await stale_router.route_message(make_event(command))
        stale_controls[command] = {
            "route_kind": stale_decision.route_kind,
            "feedback": stale_adapter.outbound[-1].payload["markdown"],
            "autonomy_suspended": is_session_autonomy_suspended("session-fixed"),
            "steering_enabled": is_session_steering_enabled("session-fixed"),
        }

    denied_adapter = _Adapter()
    denied_router = SessionRouter(registry=_Registry(denied_adapter))
    denied_router.bind_scheduler(_RouterScheduler())  # type: ignore[arg-type]
    denied_router._bindings = _Bindings()  # type: ignore[assignment]
    denied = await denied_router.route_message(make_event(bot="unknown"))
    return {
        "identity": {"union_id": union_id, "app_id": app_id, "user_name": user_name},
        "event": make_event().__dict__ if hasattr(make_event(), "__dict__") else {
            field: getattr(make_event(), field)
            for field in InboundEvent.__dataclass_fields__
        },
        "decision": {
            "route_kind": decision.route_kind,
            "lane_key": decision.lane_key,
            "platform": decision.platform,
        },
        "job": routed_job,
        "controls": controls,
        "stale_controls": stale_controls,
        "unknown": {
            "route_kind": denied.route_kind,
            "feedback": denied_adapter.outbound[-1].payload["markdown"],
        },
    }


async def scheduler_fixture() -> dict[str, Any]:
    started: list[AgentJob] = []
    release_first = asyncio.Event()
    hold_others = asyncio.Event()

    async def executor(job: AgentJob, _handle: RunHandle) -> None:
        started.append(job)
        if job.job_id == "j1":
            await release_first.wait()
        else:
            await hold_others.wait()

    scheduler = SessionScheduler(executor=executor, max_concurrency=2)
    await scheduler.enqueue(_agent_job("s1", "j1"))
    await scheduler.enqueue(_agent_job("s1", "j2"))
    await scheduler.enqueue(_agent_job("s2", "j3"))
    while len(started) < 2:
        await asyncio.sleep(0)
    initial = [item.job_id for item in started]
    handle = scheduler.active_run("s1")
    assert handle is not None
    handle.push_steering("first", response_route_id="route-steer-1", message_id="message-steer-1")
    handle.push_steering("second", response_route_id="route-steer-2", message_id="message-steer-2")
    release_first.set()
    while len(started) < 3:
        await asyncio.sleep(0)
    requeued = started[2].to_dict()
    requeued["job_id"] = "<generated>"
    await scheduler.stop()

    stop_started = asyncio.Event()
    stop_release = asyncio.Event()

    async def stop_executor(_job: AgentJob, _handle: RunHandle) -> None:
        stop_started.set()
        await stop_release.wait()

    stop_scheduler = SessionScheduler(executor=stop_executor, max_concurrency=1)
    await stop_scheduler.enqueue(_agent_job("stop", "active"))
    await stop_started.wait()
    await stop_scheduler.enqueue(_agent_job("stop", "queued"))
    cleared = stop_scheduler.clear_pending("stop")
    stopped = stop_scheduler.request_stop("stop")
    cancelled = bool(stop_scheduler.active_run("stop") and stop_scheduler.active_run("stop").cancelled)
    stop_release.set()
    await stop_scheduler.stop()

    heartbeat_scheduler = SimpleNamespace()
    heartbeat = HeartbeatWakeManager(scheduler=heartbeat_scheduler)  # type: ignore[arg-type]
    heartbeat._queue_pending("s1", "retry", "route-old")
    heartbeat._queue_pending("s1", "exec-event", "")
    wake = heartbeat._pending["s1"]

    outputs: list[dict[str, Any]] = []
    worker_started = asyncio.Event()
    worker_release = asyncio.Event()

    async def write_envelope(value: dict[str, Any]) -> None:
        outputs.append(value)

    async def turn_handler(job: AgentJob, **_kwargs: Any) -> None:
        _ = job
        worker_started.set()
        await worker_release.wait()

    worker = RuntimeWorker(
        write_envelope=write_envelope,
        turn_handler=turn_handler,
        initialize_storage=lambda: None,
        close_storage=lambda: None,
    )
    await worker.start()
    worker_job = _agent_job("worker", "worker-run").to_dict()
    await worker.handle_message(
        {
            "protocol_version": "1",
            "message_id": "start-worker",
            "reply_to": None,
            "run_id": "worker-run",
            "seq": 0,
            "kind": "turn.start",
            "payload": worker_job,
        }
    )
    await worker_started.wait()
    before_completion = [item["kind"] for item in outputs]
    worker_release.set()
    while not any(item["kind"] == "runtime.turn.completed" for item in outputs):
        await asyncio.sleep(0)
    after_completion = [item["kind"] for item in outputs]
    await worker.shutdown()
    return {
        "initial_started": initial,
        "remaining_requeued": requeued,
        "stop": {"cleared": cleared, "stopped": stopped, "cancelled": cancelled},
        "steering": [{"text": "first"}, {"text": "second"}],
        "heartbeat": {"session_id": wake.session_id, "reason": wake.reason, "response_route_id": wake.response_route_id},
        "worker_lifecycle": {"before_completion": before_completion, "after_completion": after_completion},
    }


async def build_fixture() -> dict[str, Any]:
    return {
        "env": env_fixture(),
        "permission": permission_fixture(),
        "sessions": session_fixture(),
        "router": await router_fixture(),
        "scheduler": await scheduler_fixture(),
    }


if __name__ == "__main__":
    print(json.dumps(asyncio.run(build_fixture()), ensure_ascii=False, sort_keys=True))
