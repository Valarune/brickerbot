import os
import sys

import discord
from discord import app_commands

# ---- Settings (set these as environment variables in FadeHost) ----
TOKEN = os.environ.get("DISCORD_TOKEN")                      # required
GUILD_ID = os.environ.get("GUILD_ID")                        # recommended: commands appear instantly
MANAGER_ROLE_ID = os.environ.get("MANAGER_ROLE_ID")          # role that lets people send offers
FREE_AGENT_ROLE_ID = os.environ.get("FREE_AGENT_ROLE_ID")    # optional: only these players can be offered

if not TOKEN:
    print("Missing DISCORD_TOKEN environment variable.")
    sys.exit(1)

# Roles with any of these permissions can never be used as a "team".
DANGEROUS = discord.Permissions(
    administrator=True,
    manage_guild=True,
    manage_roles=True,
    manage_channels=True,
    kick_members=True,
    ban_members=True,
).value


# ---- Bot setup ----
class TeamBot(discord.Client):
    def __init__(self):
        # default intents include "guilds", which is all we need.
        # No privileged intents are required.
        super().__init__(intents=discord.Intents.default())
        self.tree = app_commands.CommandTree(self)

    async def setup_hook(self):
        # Runs once at startup: register the slash commands with Discord.
        if GUILD_ID:
            guild = discord.Object(id=int(GUILD_ID))
            self.tree.copy_global_to(guild=guild)
            await self.tree.sync(guild=guild)
        else:
            await self.tree.sync()

    async def on_ready(self):
        print(f"Logged in as {self.user}. Commands registered.")


bot = TeamBot()


# ---- Helpers ----
def is_admin(member: discord.Member) -> bool:
    return member.guild_permissions.administrator


def can_manage(member: discord.Member) -> bool:
    if is_admin(member):
        return True
    if not MANAGER_ROLE_ID:
        return False
    return any(r.id == int(MANAGER_ROLE_ID) for r in member.roles)


def check_team_role(role: discord.Role, manager: discord.Member):
    """Return an error message if the role can't be used as a team, else None."""
    if role.managed or role.is_default():
        return "That role cannot be used as a team."
    if role.permissions.value & DANGEROUS:
        return "That role has staff-level permissions, so it cannot be used as a team."
    if not role.is_assignable():
        return "I can't give out that role. Move my bot role above it in Server Settings → Roles."
    if not is_admin(manager) and role not in manager.roles:
        return "You can only manage a team you are on."
    return None


async def reply(interaction: discord.Interaction, message: str):
    # ephemeral = only the person who used the command can see it
    await interaction.response.send_message(message, ephemeral=True)


# ---- /offer ----
@bot.tree.command(name="offer", description="Offer a free agent a spot on your team")
@app_commands.guild_only()
@app_commands.describe(player="The player to offer", team="The team role")
async def offer(interaction: discord.Interaction, player: discord.Member, team: discord.Role):
    manager = interaction.user

    if not can_manage(manager):
        return await reply(interaction, "You need the manager role to send offers.")

    problem = check_team_role(team, manager)
    if problem:
        return await reply(interaction, problem)

    if player.bot:
        return await reply(interaction, "You can't offer a bot a contract.")

    if team in player.roles:
        return await reply(interaction, f"{player.mention} is already on {team.name}.")

    if FREE_AGENT_ROLE_ID and not any(r.id == int(FREE_AGENT_ROLE_ID) for r in player.roles):
        return await reply(interaction, f"{player.mention} is not a free agent.")

    embed = discord.Embed(
        title="Contract offer",
        description=f"{manager.mention} is offering {player.mention} a spot on **{team.name}**.\n\nDo you accept?",
        color=team.color if team.color.value else discord.Color.blurple(),
        timestamp=discord.utils.utcnow(),
    )

    # The button IDs carry the offer details, so they still work after a restart.
    view = discord.ui.View(timeout=None)
    view.add_item(discord.ui.Button(
        label="Accept",
        style=discord.ButtonStyle.success,
        custom_id=f"offer:accept:{player.id}:{team.id}:{manager.id}",
    ))
    view.add_item(discord.ui.Button(
        label="Deny",
        style=discord.ButtonStyle.danger,
        custom_id=f"offer:deny:{player.id}:{team.id}:{manager.id}",
    ))

    await interaction.response.send_message(
        content=player.mention,
        embed=embed,
        view=view,
        allowed_mentions=discord.AllowedMentions(users=[player]),
    )


# ---- /release ----
@bot.tree.command(name="release", description="Remove a player from your team")
@app_commands.guild_only()
@app_commands.describe(player="The player to release", team="The team role")
async def release(interaction: discord.Interaction, player: discord.Member, team: discord.Role):
    manager = interaction.user

    if not can_manage(manager):
        return await reply(interaction, "You need the manager role to release players.")

    problem = check_team_role(team, manager)
    if problem:
        return await reply(interaction, problem)

    if team not in player.roles:
        return await reply(interaction, f"{player.mention} is not on {team.name}.")

    await player.remove_roles(team)
    if FREE_AGENT_ROLE_ID:
        free_agent_role = interaction.guild.get_role(int(FREE_AGENT_ROLE_ID))
        if free_agent_role:
            await player.add_roles(free_agent_role)

    await interaction.response.send_message(
        f"{player.mention} has been released from **{team.name}**.",
        allowed_mentions=discord.AllowedMentions(users=[player]),
    )


# ---- Accept / Deny buttons ----
@bot.event
async def on_interaction(interaction: discord.Interaction):
    # This event fires for every interaction. We only care about our buttons.
    if interaction.type != discord.InteractionType.component:
        return
    custom_id = interaction.data.get("custom_id", "")
    if not custom_id.startswith("offer:"):
        return

    _, action, player_id, role_id, manager_id = custom_id.split(":")

    if interaction.user.id != int(player_id):
        return await reply(interaction, "This offer is not for you.")

    role = interaction.guild.get_role(int(role_id))
    if role is None:
        return await reply(interaction, "That team role no longer exists.")

    if action == "deny":
        embed = discord.Embed(
            title="Offer declined",
            description=f"<@{player_id}> declined the offer from <@{manager_id}> to join **{role.name}**.",
            color=discord.Color.red(),
        )
        return await interaction.response.edit_message(content=None, embed=embed, view=None)

    # Accept
    try:
        member = await interaction.guild.fetch_member(int(player_id))
        await member.add_roles(role)
        if FREE_AGENT_ROLE_ID:
            free_agent_role = interaction.guild.get_role(int(FREE_AGENT_ROLE_ID))
            if free_agent_role and free_agent_role in member.roles:
                await member.remove_roles(free_agent_role)

        embed = discord.Embed(
            title="Offer accepted",
            description=f"<@{player_id}> has signed with **{role.name}**! Welcome to the team.",
            color=discord.Color.green(),
        )
        await interaction.response.edit_message(content=None, embed=embed, view=None)
    except discord.Forbidden:
        await reply(interaction, "I couldn't give you the role. Ask an admin to move my bot role above the team role.")


bot.run(TOKEN)
