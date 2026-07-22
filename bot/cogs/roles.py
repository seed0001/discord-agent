"""Role management slash commands."""
import discord
from discord import app_commands
from discord.ext import commands

from bot.utils import log_action


class Roles(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @app_commands.command(description="Give a role to a member")
    @app_commands.describe(member="Member to give the role to", role="Role to give")
    @app_commands.default_permissions(manage_roles=True)
    async def giverole(self, interaction: discord.Interaction, member: discord.Member, role: discord.Role):
        await member.add_roles(role)
        await log_action(interaction.guild, "role_add", interaction.user, member, role.name)
        await interaction.response.send_message(
            f"Gave **{role.name}** to **{member}**.", ephemeral=True)

    @app_commands.command(description="Remove a role from a member")
    @app_commands.describe(member="Member to remove the role from", role="Role to remove")
    @app_commands.default_permissions(manage_roles=True)
    async def takerole(self, interaction: discord.Interaction, member: discord.Member, role: discord.Role):
        await member.remove_roles(role)
        await log_action(interaction.guild, "role_remove", interaction.user, member, role.name)
        await interaction.response.send_message(
            f"Removed **{role.name}** from **{member}**.", ephemeral=True)

    @app_commands.command(description="Create a new role")
    @app_commands.describe(name="Name for the new role", color="Hex color, e.g. #5865F2")
    @app_commands.default_permissions(manage_roles=True)
    async def createrole(self, interaction: discord.Interaction, name: str, color: str | None = None):
        colour = discord.Colour.default()
        if color:
            try:
                colour = discord.Colour(int(color.lstrip("#"), 16))
            except ValueError:
                await interaction.response.send_message("Invalid hex color.", ephemeral=True)
                return
        role = await interaction.guild.create_role(name=name, colour=colour)
        await log_action(interaction.guild, "role_create", interaction.user, role.name, None)
        await interaction.response.send_message(f"Created role **{role.name}**.", ephemeral=True)

    @app_commands.command(description="Delete a role")
    @app_commands.describe(role="Role to delete")
    @app_commands.default_permissions(manage_roles=True)
    async def deleterole(self, interaction: discord.Interaction, role: discord.Role):
        name = role.name
        await role.delete()
        await log_action(interaction.guild, "role_delete", interaction.user, name, None)
        await interaction.response.send_message(f"Deleted role **{name}**.", ephemeral=True)


async def setup(bot: commands.Bot):
    await bot.add_cog(Roles(bot))
