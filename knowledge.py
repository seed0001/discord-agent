"""Max's knowledge base: procedural memory, not factual memory.

memory.py remembers facts (about people, about the guild). This remembers
*how to do things* — multi-step procedures Max has already been walked
through once and shouldn't need re-explaining every time: "spin up a Node
repo" means clone, npm install, then npm run dev; "deploy to Railway" means
these three steps in this order. Guild-wide, not per-member, and nothing
here is ever written by AI consolidation — an entry only exists because it
was explicitly saved, either because Max already knew the procedure or
because a human just walked him through it.

The expected loop (see the ai_capability_prompt KB instruction in db.py):
before improvising an unfamiliar multi-step task, or before asking how to
do something, check kb_search first. If there's a matching entry, follow it
without re-litigating it. If there isn't, and it's genuinely unclear how to
proceed, ask — then once it's resolved, kb_save it, so the next time this
comes up nobody has to explain it again.
"""
import json
import re

import db

SLUG_MAX = 80
SEARCH_LIMIT = 10


def slugify(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.strip().lower()).strip("-")
    return (slug or "entry")[:SLUG_MAX]


def _format_entries(entries: list[dict], with_content: bool) -> str:
    if not entries:
        return "No matching knowledge base entries."
    lines = []
    for e in entries:
        lines.append(f"### {e['title']} (slug: {e['slug']})")
        if with_content:
            lines.append(e["content"])
    return "\n\n".join(lines)


async def search(guild_id: int, query: str) -> str:
    entries = await db.kb_search(guild_id, query, limit=SEARCH_LIMIT)
    return _format_entries(entries, with_content=True)


async def list_entries(guild_id: int) -> str:
    entries = await db.kb_list(guild_id)
    if not entries:
        return "Knowledge base is empty."
    return "\n".join(f"- {e['title']} (slug: {e['slug']})" for e in entries)


async def save(guild_id: int, title: str, content: str) -> str:
    title = (title or "").strip()
    content = (content or "").strip()
    if not title or not content:
        return "Both a title and content are required to save a knowledge base entry."
    slug = slugify(title)
    existing = await db.kb_get(guild_id, slug)
    await db.kb_save(guild_id, slug, title, content)
    return (f"Updated existing entry {title!r}." if existing
            else f"Saved new knowledge base entry {title!r}.")


KB_TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "kb_search",
            "description": (
                "Search your knowledge base of known procedures (\"how to do "
                "X\") by keyword. Check this BEFORE improvising an unfamiliar "
                "multi-step task or asking how to do something — if there's "
                "a matching entry, follow it instead of re-figuring it out "
                "or asking again."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Keyword(s) to search titles/content for"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "kb_list",
            "description": "List every knowledge base entry's title (no content) — use to see what's already known.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "kb_save",
            "description": (
                "Save or update a knowledge base entry — a reusable procedure "
                "for how to do something. Use this once a new procedure is "
                "confirmed (you figured it out, or someone just walked you "
                "through it) so it never has to be re-explained. Saving with "
                "the same title as an existing entry overwrites/corrects it."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Short, specific title, e.g. 'spin up a Node repo'"},
                    "content": {"type": "string",
                               "description": "The actual procedure — concrete steps, commands, gotchas"},
                },
                "required": ["title", "content"],
            },
        },
    },
]


async def run_tool(guild_id: int, name: str, args: dict) -> str:
    if name == "kb_search":
        return await search(guild_id, str(args.get("query", "")))
    if name == "kb_list":
        return await list_entries(guild_id)
    if name == "kb_save":
        return await save(guild_id, str(args.get("title", "")), str(args.get("content", "")))
    return f"Unknown knowledge base tool: {name}"
