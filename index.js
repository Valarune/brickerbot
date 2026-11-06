const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');

// ---- Settings (set these as environment variables in FadeHost) ----
const TOKEN = process.env.DISCORD_TOKEN;                  // required
const GUILD_ID = process.env.GUILD_ID;                    // recommended: your server ID (commands appear instantly)
const MANAGER_ROLE_ID = process.env.MANAGER_ROLE_ID;      // role that lets people send offers
const FREE_AGENT_ROLE_ID = process.env.FREE_AGENT_ROLE_ID; // optional: only players with this role can be offered

if (!TOKEN) {
  console.error('Missing DISCORD_TOKEN environment variable.');
  process.exit(1);
}

// Roles with any of these permissions can never be handed out as a "team".
const DANGEROUS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
];

const commands = [
  new SlashCommandBuilder()
    .setName('offer')
    .setDescription('Offer a free agent a spot on your team')
    .addUserOption((o) => o.setName('player').setDescription('The player to offer').setRequired(true))
    .addRoleOption((o) => o.setName('team').setDescription('The team role').setRequired(true))
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('release')
    .setDescription('Remove a player from your team')
    .addUserOption((o) => o.setName('player').setDescription('The player to release').setRequired(true))
    .addRoleOption((o) => o.setName('team').setDescription('The team role').setRequired(true))
    .setDMPermission(false),
].map((c) => c.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', async () => {
  try {
    if (GUILD_ID) {
      await client.application.commands.set(commands, GUILD_ID);
    } else {
      await client.application.commands.set(commands);
    }
    console.log(`Logged in as ${client.user.tag}. Commands registered.`);
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
});

// ---- Helpers ----
function canManage(member) {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return MANAGER_ROLE_ID ? member.roles.cache.has(MANAGER_ROLE_ID) : false;
}

function isAdmin(member) {
  return member.permissions.has(PermissionFlagsBits.Administrator);
}

// Returns an error string if the role can't be used as a team, otherwise null.
function checkTeamRole(role, manager) {
  if (role.managed || role.id === role.guild.id) return 'That role cannot be used as a team.';
  if (DANGEROUS.some((p) => role.permissions.has(p))) {
    return 'That role has staff-level permissions, so it cannot be used as a team.';
  }
  if (!role.editable) {
    return "I can't give out that role. Move my bot role above it in Server Settings → Roles.";
  }
  if (!isAdmin(manager) && !manager.roles.cache.has(role.id)) {
    return 'You can only manage a team you are on.';
  }
  return null;
}

function reply(interaction, content) {
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

// ---- Slash commands ----
async function handleOffer(interaction) {
  const manager = interaction.member;
  const targetUser = interaction.options.getUser('player');
  const role = interaction.options.getRole('team');

  if (!canManage(manager)) return reply(interaction, 'You need the manager role to send offers.');

  const problem = checkTeamRole(role, manager);
  if (problem) return reply(interaction, problem);

  if (targetUser.bot) return reply(interaction, "You can't offer a bot a contract.");

  const target = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
  if (!target) return reply(interaction, "I couldn't find that player in this server.");

  if (target.roles.cache.has(role.id)) return reply(interaction, `${target} is already on ${role.name}.`);

  if (FREE_AGENT_ROLE_ID && !target.roles.cache.has(FREE_AGENT_ROLE_ID)) {
    return reply(interaction, `${target} is not a free agent.`);
  }

  const embed = new EmbedBuilder()
    .setTitle('Contract offer')
    .setDescription(`${manager} is offering ${target} a spot on **${role.name}**.\n\nDo you accept?`)
    .setColor(role.color || 0x5865f2)
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`offer:accept:${target.id}:${role.id}:${manager.id}`)
      .setLabel('Accept')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`offer:deny:${target.id}:${role.id}:${manager.id}`)
      .setLabel('Deny')
      .setStyle(ButtonStyle.Danger),
  );

  return interaction.reply({
    content: `${target}`,
    embeds: [embed],
    components: [row],
    allowedMentions: { users: [target.id] },
  });
}

async function handleRelease(interaction) {
  const manager = interaction.member;
  const targetUser = interaction.options.getUser('player');
  const role = interaction.options.getRole('team');

  if (!canManage(manager)) return reply(interaction, 'You need the manager role to release players.');

  const problem = checkTeamRole(role, manager);
  if (problem) return reply(interaction, problem);

  const target = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
  if (!target) return reply(interaction, "I couldn't find that player in this server.");
  if (!target.roles.cache.has(role.id)) return reply(interaction, `${target} is not on ${role.name}.`);

  await target.roles.remove(role);
  if (FREE_AGENT_ROLE_ID) await target.roles.add(FREE_AGENT_ROLE_ID).catch(() => {});

  return interaction.reply({
    content: `${target} has been released from **${role.name}**.`,
    allowedMentions: { users: [target.id] },
  });
}

// ---- Accept / Deny buttons ----
async function handleButton(interaction) {
  const [, action, playerId, roleId, managerId] = interaction.customId.split(':');

  if (interaction.user.id !== playerId) {
    return reply(interaction, 'This offer is not for you.');
  }

  const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
  if (!role) return reply(interaction, 'That team role no longer exists.');

  if (action === 'deny') {
    const embed = new EmbedBuilder()
      .setTitle('Offer declined')
      .setDescription(`<@${playerId}> declined the offer from <@${managerId}> to join **${role.name}**.`)
      .setColor(0xed4245);
    return interaction.update({ content: '', embeds: [embed], components: [] });
  }

  // Accept
  try {
    const member = await interaction.guild.members.fetch(playerId);
    await member.roles.add(role);
    if (FREE_AGENT_ROLE_ID) await member.roles.remove(FREE_AGENT_ROLE_ID).catch(() => {});

    const embed = new EmbedBuilder()
      .setTitle('Offer accepted')
      .setDescription(`<@${playerId}> has signed with **${role.name}**! Welcome to the team.`)
      .setColor(0x57f287);
    return interaction.update({ content: '', embeds: [embed], components: [] });
  } catch (err) {
    console.error('Failed to give role:', err);
    return reply(
      interaction,
      "I couldn't give you the role. Ask an admin to move my bot role above the team role.",
    );
  }
}

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'offer') return await handleOffer(interaction);
      if (interaction.commandName === 'release') return await handleRelease(interaction);
    } else if (interaction.isButton() && interaction.customId.startsWith('offer:')) {
      return await handleButton(interaction);
    }
  } catch (err) {
    console.error(err);
    if (interaction.replied || interaction.deferred) return;
    interaction.reply({ content: 'Something went wrong.', flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

client.login(TOKEN);
