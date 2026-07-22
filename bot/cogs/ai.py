"""AI chat via OpenRouter.

The bot replies when mentioned in any channel, or to every message in
channels listed in the ai_channels setting. Per-channel short-term memory.
"""
import logging
from collections import defaultdict, deque

import discord
from discord import app_commands
from discord.ext import commands

import db
import openrouter
import tools

log = logging.getLogger("ai")

HISTORY_LEN = 20  # messages of context kept per channel
MAX_AUTO_REPOS = 2  # GitHub links auto-analyzed per message

FEATURES = (
    "Beyond slash commands, you also handle: automod (banned words, invite "
    "blocking, mention spam), welcome/goodbye messages with an optional "
    "autorole, moderation logging, and a mobile web dashboard where admins "
    "configure all of this (including your AI settings and this very persona)."
)

ABILITIES = (
    "You can look things up: you have a web_search tool (DuckDuckGo) for "
    "current events, docs, or anything you're unsure about, and a github_repo "
    "tool that pulls a repository's description, stats, languages, and README. "
    "When someone shares a GitHub link, the repo's details are attached to "
    "their message automatically — dig in and actually work with them on it: "
    "what it does, the stack, how it's structured, what's cool, what could be "
    "better, ideas for where to take it. Use tools when they'd help; don't "
    "guess at things you can check."
)


class AI(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.history: dict[int, deque] = defaultdict(lambda: deque(maxlen=HISTORY_LEN))

    async def build_system_prompt(self, guild: discord.Guild) -> str:
        """Persona from settings plus a self-awareness section: who the bot is,
        which server it manages, and its actual command list."""
        persona = await db.get_setting(guild.id, "ai_system_prompt")
        command_lines = "\n".join(
            f"- /{cmd.name}: {cmd.description}"
            for cmd in sorted(self.bot.tree.get_commands(), key=lambda c: c.name)
        )
        return (
            f"{persona}\n\n"
            f"You are {self.bot.user.display_name}, the bot that manages the Discord "
            f'server "{guild.name}" ({guild.member_count} members). '
            "You are not just a chatbot — you run this place. "
            "Server members interact with you by mentioning you or using your slash commands:\n"
            f"{command_lines}\n"
            f"{FEATURES}\n"
            f"{ABILITIES}\n"
            "You can't invoke commands yourself from chat, so when someone asks you to "
            "do something (kick, ban, make a channel, etc.), point them to the right "
            "slash command instead of pretending you did it."
        )

    async def generate_reply(self, message: discord.Message) -> str:
        guild_id = message.guild.id
        system_prompt = await self.build_system_prompt(message.guild)
        model = await db.get_setting(guild_id, "ai_model")
        channel_history = self.history[message.channel.id]

        content = message.content.replace(self.bot.user.mention, "").strip() or "(no text)"

        # Auto-attach repo details when the message contains GitHub links, so
        # the bot can analyze them (and follow-ups keep the context in history).
        for owner, name in tools.find_repo_refs(content)[:MAX_AUTO_REPOS]:
            info = await tools.run_tool("github_repo", {"repo": f"{owner}/{name}"})
            content += f"\n\n[attached context for github.com/{owner}/{name}]\n{info}"

        channel_history.append({"role": "user", "content": f"{message.author.display_name}: {content}"})

        messages = [{"role": "system", "content": system_prompt}, *channel_history]
        reply = await openrouter.chat(
            messages, model=model,
            tools=tools.TOOL_SCHEMAS, tool_handler=tools.run_tool,
        )
        channel_history.append({"role": "assistant", "content": reply})
        return reply

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        if message.guild is None or message.author.bot:
            return
        if not await db.get_setting(message.guild.id, "ai_enabled"):
            return
        ai_channels = await db.get_setting(message.guild.id, "ai_channels") or []
        mentioned = self.bot.user in message.mentions
        in_ai_channel = str(message.channel.id) in [str(c) for c in ai_channels]
        if not (mentioned or in_ai_channel):
            return

        async with message.channel.typing():
            try:
                reply = await self.generate_reply(message)
            except openrouter.OpenRouterError as exc:
                log.warning("OpenRouter error: %s", exc)
                await message.reply("AI is unavailable right now.", mention_author=False)
                return
        # Discord message limit is 2000 chars
        for chunk in [reply[i:i + 1990] for i in range(0, len(reply), 1990)] or ["..."]:
            await message.reply(chunk, mention_author=False)

    @app_commands.command(description="Ask the AI a question")
    @app_commands.describe(question="What do you want to ask?")
    async def ask(self, interaction: discord.Interaction, question: str):
        if not await db.get_setting(interaction.guild.id, "ai_enabled"):
            await interaction.response.send_message("AI is disabled on this server.", ephemeral=True)
            return
        await interaction.response.defer()
        system_prompt = await self.build_system_prompt(interaction.guild)
        model = await db.get_setting(interaction.guild.id, "ai_model")
        try:
            reply = await openrouter.chat(
                [{"role": "system", "content": system_prompt},
                 {"role": "user", "content": question}],
                model=model,
                tools=tools.TOOL_SCHEMAS, tool_handler=tools.run_tool,
            )
        except openrouter.OpenRouterError as exc:
            log.warning("OpenRouter error: %s", exc)
            await interaction.followup.send("AI is unavailable right now.")
            return
        await interaction.followup.send(reply[:1990])

    @app_commands.command(description="Clear the AI's memory of this channel")
    async def aireset(self, interaction: discord.Interaction):
        self.history.pop(interaction.channel.id, None)
        await interaction.response.send_message("AI memory cleared for this channel.", ephemeral=True)


async def setup(bot: commands.Bot):
    await bot.add_cog(AI(bot))
