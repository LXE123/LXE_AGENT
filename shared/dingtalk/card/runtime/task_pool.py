from __future__ import annotations

import asyncio
import time
from typing import Any, Awaitable, Callable, Dict, Literal, Optional, Set

from shared.config import config
from shared.logging import logger

DedupPolicy = Literal["drop", "replace", "allow"]


def _int_cfg(name: str, default: int) -> int:
    value = getattr(config, name, default)
    try:
        return int(value)
    except Exception:
        return default


class CardTaskPool:
    """Global async task pool for card-side background jobs."""

    def __init__(
        self,
        global_concurrency: int = 16,
        scope_concurrency: int = 2,
        default_timeout_s: float = 120.0,
    ) -> None:
        self._global_limit = max(1, int(global_concurrency))
        self._scope_limit = max(1, int(scope_concurrency))
        self._default_timeout_s = float(default_timeout_s)

        self._global_sem = asyncio.Semaphore(self._global_limit)
        self._scope_sems: Dict[str, asyncio.Semaphore] = {}
        self._scope_tasks: Dict[str, Set[asyncio.Task]] = {}
        self._scope_key_tasks: Dict[str, Dict[str, asyncio.Task]] = {}
        self._lock = asyncio.Lock()
        self._allow_seq = 0
        self._closed = False

    async def submit(
        self,
        *,
        scope: str,
        key: str,
        coro_factory: Callable[[], Awaitable[Any]],
        timeout_s: Optional[float] = None,
        dedup_policy: DedupPolicy = "drop",
    ) -> asyncio.Task:
        """Submit a background task.

        - scope: usually out_track_id (or business-prefixed id).
        - key: task key for dedup.
        - dedup_policy:
          - drop: keep existing running task.
          - replace: cancel existing task, run latest task.
          - allow: allow multiple tasks with same base key.
        """
        safe_scope = str(scope or "default").strip() or "default"
        safe_key = str(key or "task").strip() or "task"
        policy: DedupPolicy = dedup_policy if dedup_policy in {"drop", "replace", "allow"} else "drop"
        timeout = self._default_timeout_s if timeout_s is None else float(timeout_s)

        async with self._lock:
            if self._closed:
                raise RuntimeError("CardTaskPool is closed")
            key_map = self._scope_key_tasks.setdefault(safe_scope, {})
            existing = key_map.get(safe_key)
            if existing and not existing.done():
                if policy == "drop":
                    logger.info(
                        f"[CardTaskPool] drop duplicate task scope={safe_scope}, key={safe_key}"
                    )
                    return existing
                if policy == "replace":
                    logger.info(
                        f"[CardTaskPool] replace running task scope={safe_scope}, key={safe_key}"
                    )
                    existing.cancel()

            store_key = safe_key
            if policy == "allow":
                store_key = f"{safe_key}#{self._allow_seq}"
                self._allow_seq += 1

            task = asyncio.create_task(
                self._run_task(
                    scope=safe_scope,
                    store_key=store_key,
                    display_key=safe_key,
                    coro_factory=coro_factory,
                    timeout_s=timeout,
                ),
                name=f"card_task:{safe_scope}:{store_key}",
            )

            key_map[store_key] = task
            self._scope_tasks.setdefault(safe_scope, set()).add(task)
            task.add_done_callback(
                lambda done_task, _scope=safe_scope, _key=store_key: asyncio.create_task(
                    self._on_task_done(_scope, _key, done_task)
                )
            )
            return task

    def submit_nowait(
        self,
        *,
        scope: str,
        key: str,
        coro_factory: Callable[[], Awaitable[Any]],
        timeout_s: Optional[float] = None,
        dedup_policy: DedupPolicy = "drop",
    ) -> asyncio.Task:
        """Non-async submit helper for sync callbacks."""
        return asyncio.create_task(
            self.submit(
                scope=scope,
                key=key,
                coro_factory=coro_factory,
                timeout_s=timeout_s,
                dedup_policy=dedup_policy,
            ),
            name=f"card_task_submit:{scope}:{key}",
        )

    async def cancel_scope(self, scope: str, *, exclude_current: bool = False) -> int:
        safe_scope = str(scope or "default").strip() or "default"
        current = asyncio.current_task() if exclude_current else None
        async with self._lock:
            tasks = list(self._scope_tasks.get(safe_scope, set()))
        if not tasks:
            return 0

        cancel_targets = [task for task in tasks if task is not current]
        for task in tasks:
            if task is current:
                continue
            if not task.done():
                task.cancel()

        if cancel_targets:
            await asyncio.gather(*cancel_targets, return_exceptions=True)
        await self._cleanup_scope_if_empty(safe_scope)
        logger.info(
            f"[CardTaskPool] cancelled scope={safe_scope}, task_count={len(cancel_targets)}"
        )
        return len(cancel_targets)

    async def drain_scope(self, scope: str, timeout_s: float = 2.0) -> None:
        safe_scope = str(scope or "default").strip() or "default"
        async with self._lock:
            tasks = [task for task in self._scope_tasks.get(safe_scope, set()) if not task.done()]
        if not tasks:
            return
        done, pending = await asyncio.wait(tasks, timeout=float(timeout_s))
        if pending:
            logger.warning(
                f"[CardTaskPool] drain timeout scope={safe_scope}, pending={len(pending)}"
            )
        else:
            logger.info(
                f"[CardTaskPool] drained scope={safe_scope}, completed={len(done)}"
            )

    async def shutdown(self, timeout_s: float = 5.0) -> None:
        async with self._lock:
            self._closed = True
            tasks = []
            for task_set in self._scope_tasks.values():
                tasks.extend(task for task in task_set if not task.done())
        if not tasks:
            logger.info("[CardTaskPool] shutdown complete: no active tasks")
            return

        for task in tasks:
            task.cancel()

        done, pending = await asyncio.wait(tasks, timeout=float(timeout_s))
        if pending:
            logger.warning(f"[CardTaskPool] shutdown timeout, pending={len(pending)}")
        else:
            logger.info(f"[CardTaskPool] shutdown complete, cancelled={len(done)}")

    async def _run_task(
        self,
        *,
        scope: str,
        store_key: str,
        display_key: str,
        coro_factory: Callable[[], Awaitable[Any]],
        timeout_s: float,
    ) -> Any:
        scope_sem = await self._get_scope_sem(scope)
        started = time.time()
        await self._global_sem.acquire()
        await scope_sem.acquire()
        try:
            logger.info(f"[CardTaskPool] task_start scope={scope}, key={display_key}")
            awaitable = coro_factory()
            if timeout_s and timeout_s > 0:
                result = await asyncio.wait_for(awaitable, timeout=timeout_s)
            else:
                result = await awaitable
            elapsed_ms = int((time.time() - started) * 1000)
            logger.info(
                f"[CardTaskPool] task_done scope={scope}, key={display_key}, elapsed_ms={elapsed_ms}"
            )
            return result
        except asyncio.TimeoutError:
            logger.error(
                f"[CardTaskPool] task_timeout scope={scope}, key={display_key}, timeout_s={timeout_s}"
            )
            return None
        except asyncio.CancelledError:
            logger.warning(f"[CardTaskPool] task_cancelled scope={scope}, key={display_key}")
            raise
        except Exception as error:
            logger.error(
                f"[CardTaskPool] task_error scope={scope}, key={display_key}, error={error}"
            )
            return None
        finally:
            scope_sem.release()
            self._global_sem.release()

    async def _on_task_done(self, scope: str, store_key: str, task: asyncio.Task) -> None:
        async with self._lock:
            key_map = self._scope_key_tasks.get(scope)
            if key_map:
                current = key_map.get(store_key)
                if current is task:
                    key_map.pop(store_key, None)
                if not key_map:
                    self._scope_key_tasks.pop(scope, None)

            task_set = self._scope_tasks.get(scope)
            if task_set:
                task_set.discard(task)
                if not task_set:
                    self._scope_tasks.pop(scope, None)

            if scope not in self._scope_tasks and scope not in self._scope_key_tasks:
                self._scope_sems.pop(scope, None)

    async def _get_scope_sem(self, scope: str) -> asyncio.Semaphore:
        async with self._lock:
            sem = self._scope_sems.get(scope)
            if sem is None:
                sem = asyncio.Semaphore(self._scope_limit)
                self._scope_sems[scope] = sem
            return sem

    async def _cleanup_scope_if_empty(self, scope: str) -> None:
        async with self._lock:
            if self._scope_tasks.get(scope):
                return
            if self._scope_key_tasks.get(scope):
                return
            self._scope_tasks.pop(scope, None)
            self._scope_key_tasks.pop(scope, None)
            self._scope_sems.pop(scope, None)

    def stats(self) -> Dict[str, Any]:
        active = 0
        for task_set in self._scope_tasks.values():
            active += sum(1 for task in task_set if not task.done())
        return {
            "global_limit": self._global_limit,
            "scope_limit": self._scope_limit,
            "scope_count": len(self._scope_tasks),
            "active_tasks": active,
        }


card_task_pool = CardTaskPool(
    global_concurrency=_int_cfg("CARD_TASK_GLOBAL_CONCURRENCY", 16),
    scope_concurrency=_int_cfg("CARD_TASK_SCOPE_CONCURRENCY", 2),
    default_timeout_s=float(getattr(config, "CARD_TASK_DEFAULT_TIMEOUT_S", 120.0) or 120.0),
)
