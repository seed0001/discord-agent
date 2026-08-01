"""Minimal async OpenRouter chat-completions client with tool-calling support.

Background calls (classification, memory maintenance, assessments) are
rate-capped per hour as a spend breaker and every call's token usage is
logged under the "llm" logger so cost hot-spots show up in the dashboard.
"""
import json
import logging
import time
from collections import deque

import httpx

import config

API_URL = "https://openrouter.ai/api/v1/chat/completions"

log = logging.getLogger("llm")

_bg_calls: deque = deque()  # timestamps of background calls, last hour


class OpenRouterError(Exception):
    pass


# One model in the free pool answers everything with a bare safety verdict
# ("user safety safe") — detect it and re-roll the request so the free
# router picks a different model.
import re as _re
_JUNK_VERDICT_RE = _re.compile(
    r"^\W*(user\s*safety\W*)?(safe|unsafe)\W*$", _re.IGNORECASE)
JUNK_RETRIES = 2


def _is_junk_verdict(content: str) -> bool:
    text = (content or "").strip()
    return len(text) < 40 and bool(_JUNK_VERDICT_RE.match(text))


def _bg_budget_check() -> None:
    cap = config.OPENROUTER_BG_HOURLY_CAP
    if cap <= 0:
        return
    now = time.time()
    while _bg_calls and now - _bg_calls[0] > 3600:
        _bg_calls.popleft()
    if len(_bg_calls) >= cap:
        raise OpenRouterError(
            f"background call budget exhausted ({cap}/hour) — skipping")
    _bg_calls.append(now)


async def chat(
    messages: list[dict],
    model: str | None = None,
    max_tokens: int = 1000,
    temperature: float = 0.7,
    tools: list[dict] | None = None,
    tool_handler=None,
    max_tool_rounds: int = 4,
    background: bool = False,
    on_tool_calls=None,
) -> str:
    """Send a chat completion request and return the assistant's reply text.

    If `tools` and `tool_handler` are given, runs an agent loop: when the model
    requests tool calls, each is executed via `await tool_handler(name, args)`
    and the results are fed back, up to `max_tool_rounds` rounds. The last
    round is forced tool-free so the model always produces a final answer.

    If `on_tool_calls` is given, it's awaited with the raw tool_calls list the
    first time the model requests any — before they run — so a caller can
    surface "working on it" feedback for a slow multi-step action.
    """
    if not config.OPENROUTER_API_KEY:
        raise OpenRouterError("OPENROUTER_API_KEY is not set")
    if background:
        _bg_budget_check()
    headers = {
        "Authorization": f"Bearer {config.OPENROUTER_API_KEY}",
        "X-Title": "Discord Agent",
    }
    messages = list(messages)
    use_tools = bool(tools and tool_handler)
    junk_retries = 0

    async with httpx.AsyncClient(timeout=90) as client:
        for round_no in range(max_tool_rounds + 1 + JUNK_RETRIES):
            payload = {
                "model": model or config.OPENROUTER_MODEL,
                "messages": messages,
                "max_tokens": max_tokens,
                "temperature": temperature,
            }
            if use_tools and round_no < max_tool_rounds:
                payload["tools"] = tools
            resp = await client.post(API_URL, headers=headers, json=payload)
            if resp.status_code != 200:
                text = resp.text[:300]
                # Free-pool (and some budget) models don't support tool
                # calling — degrade to a plain reply instead of failing.
                if "tools" in payload and resp.status_code in (400, 404) \
                        and "tool" in text.lower():
                    log.warning("model rejected tool use — retrying without tools (%s)",
                                text[:120])
                    use_tools = False
                    continue
                raise OpenRouterError(f"OpenRouter returned {resp.status_code}: {text}")
            data = resp.json()
            try:
                reply = data["choices"][0]["message"]
            except (KeyError, IndexError) as exc:
                raise OpenRouterError(f"Unexpected OpenRouter response: {data}") from exc
            usage = data.get("usage") or {}
            log.info("%s%s in=%s out=%s", payload["model"],
                     " [bg]" if background else "",
                     usage.get("prompt_tokens", "?"), usage.get("completion_tokens", "?"))

            tool_calls = reply.get("tool_calls")
            if not (tool_calls and use_tools):
                content = reply.get("content") or ""
                if _is_junk_verdict(content) and junk_retries < JUNK_RETRIES:
                    junk_retries += 1
                    log.info("junk safety verdict from %s — re-rolling (%d/%d)",
                             payload["model"], junk_retries, JUNK_RETRIES)
                    continue
                return content

            messages.append(reply)
            if on_tool_calls is not None:
                await on_tool_calls(tool_calls)
                on_tool_calls = None  # only announce once, on the first round
            for call in tool_calls:
                try:
                    args = json.loads(call["function"].get("arguments") or "{}")
                except json.JSONDecodeError:
                    args = {}
                result = await tool_handler(call["function"]["name"], args)
                messages.append({
                    "role": "tool",
                    "tool_call_id": call.get("id", ""),
                    "content": result,
                })
    raise OpenRouterError("Tool loop ended without a final answer")
