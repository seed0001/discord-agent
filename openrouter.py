"""Minimal async OpenRouter chat-completions client."""
import httpx

import config

API_URL = "https://openrouter.ai/api/v1/chat/completions"


class OpenRouterError(Exception):
    pass


async def chat(
    messages: list[dict],
    model: str | None = None,
    max_tokens: int = 1000,
    temperature: float = 0.7,
    tools: list[dict] | None = None,
) -> dict:
    """Send a chat completion request and return the assistant message dict.

    The returned dict has "content" (str or None) and, when the model wants
    to act, "tool_calls" (OpenAI function-calling format).
    """
    if not config.OPENROUTER_API_KEY:
        raise OpenRouterError("OPENROUTER_API_KEY is not set")
    headers = {
        "Authorization": f"Bearer {config.OPENROUTER_API_KEY}",
        "X-Title": "Discord Agent",
    }
    payload = {
        "model": model or config.OPENROUTER_MODEL,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    if tools:
        payload["tools"] = tools
    async with httpx.AsyncClient(timeout=90) as client:
        resp = await client.post(API_URL, headers=headers, json=payload)
    if resp.status_code != 200:
        raise OpenRouterError(f"OpenRouter returned {resp.status_code}: {resp.text[:300]}")
    data = resp.json()
    try:
        return data["choices"][0]["message"]
    except (KeyError, IndexError) as exc:
        raise OpenRouterError(f"Unexpected OpenRouter response: {data}") from exc
