'use strict';
/*
 * Project Reverse — grants server + Discord bot.
 *
 * - HTTP:  GET /grants/:discordId  -> { full, packs:[], items:[] }  (the launcher reads this at startup)
 *          GET /health             -> ok
 *          POST /register          -> register a player { accountId, displayName }
 *          GET /lookup?name=<n>    -> find a player by display name
 * - Discord slash commands (admin-role gated):
 *          /give   user:<@u> pack:<name>   add a pack (or "Full Locker") to a user
 *          /giveitem user:<@u> id:<templateId>   add one cosmetic by id
 *          /remove user:<@u> [pack:<name>]   remove a pack, or everything
 *          /locker user:<@u>   show what a user owns
 *
 * Persistence: the grants JSON is kept as a file attachment on one message in a
 * storage channel, so it survives restarts/redeploys without any database.
 *
 * Env vars (set these in Render):
 *   DISCORD_TOKEN   - your bot token (required)
 *   CLIENT_ID       - the bot application id (required, to register commands)
 *   GUILD_ID        - your Discord server id (optional; makes commands appear instantly)
 *   ADMIN_ROLE_ID   - role allowed to run /give etc. (optional; if unset, needs Manage Server)
 *   STORAGE_CHANNEL_ID - a private channel the bot uses to store the grants file (required for persistence)
 *   PORT            - set by Render automatically
 */

const http = require('http');
const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, PermissionFlagsBits, AttachmentBuilder
} = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN || '';
const CLIENT_ID = process.env.CLIENT_ID || '';
const GUILD_ID = process.env.GUILD_ID || '';
const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID || '';
const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID || '';
const PORT = process.env.PORT || 3000;

const PACKS = ['Full Locker', 'All Skins', 'OG Pack'];

let grants = {};
let client = null;
let storageMsg = null;

// ---- player registry: { [discordUsername_lower]: { accountId, displayName, lastSeen } } ----
let players = {};

function entry(id) {
  if (!grants[id]) grants[id] = { full: false, packs: [], items: [] };
  return grants[id];
}

async function loadGrants() {
  if (!STORAGE_CHANNEL_ID || !client) return;
  try {
    const ch = await client.channels.fetch(STORAGE_CHANNEL_ID);
    const msgs = await ch.messages.fetch({ limit: 25 });
    const mine = msgs.filter((m) => m.author.id === client.user.id && m.attachments.size);
    const msg = mine.first();
    if (!msg) return;
    storageMsg = msg;
    const att = msg.attachments.first();
    const txt = await fetch(att.url).then((r) => r.text());
    grants = JSON.parse(txt) || {};
    console.log('[grants] loaded', Object.keys(grants).length, 'users');
  } catch (e) { console.log('[grants] load failed:', e.message); }
}

let saving = false, saveAgain = false;
async function saveGrants() {
  if (!STORAGE_CHANNEL_ID || !client) return;
  if (saving) { saveAgain = true; return; }
  saving = true;
  try {
    const ch = await client.channels.fetch(STORAGE_CHANNEL_ID);
    const buf = Buffer.from(JSON.stringify(grants, null, 2));
    const file = new AttachmentBuilder(buf, { name: 'grants.json' });
    if (storageMsg) { await storageMsg.edit({ content: 'Project Reverse grants (do not delete).', files: [file] }); }
    else { storageMsg = await ch.send({ content: 'Project Reverse grants (do not delete).', files: [file] }); }
  } catch (e) { console.log('[grants] save failed:', e.message); }
  saving = false;
  if (saveAgain) { saveAgain = false; saveGrants(); }
}

// ---------- HTTP API ----------
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const rawUrl = req.url || '';
  const url = rawUrl.split('?')[0];
  const params = new URLSearchParams(rawUrl.includes('?') ? rawUrl.split('?')[1] : '');

  if (url === '/health' || url === '/') { res.writeHead(200); return res.end('ok'); }

  const mg = /^\/grants\/([^/]+)$/.exec(url);
  if (mg) {
    const g = grants[decodeURIComponent(mg[1])] || { full: false, packs: [], items: [] };
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(g));
  }

  if (url === '/register' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const { accountId, displayName } = JSON.parse(body);
        if (accountId && displayName) {
          const key = String(displayName).toLowerCase();
          players[key] = { accountId, displayName, lastSeen: Date.now() };
          console.log('[players] registered', displayName, '->', accountId);
        }
      } catch (e) {}
      res.writeHead(204); res.end();
    });
    return;
  }

  if (url === '/lookup') {
    const name = (params.get('name') || '').toLowerCase().trim();
    const found = name ? players[name] : null;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(found || null));
  }

  if (url === '/players') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(players));
  }

  res.writeHead(404); res.end('not found');
}).listen(PORT, () => console.log('[http] listening on', PORT));

// Keep-alive
const SELF_URL = process.env.RENDER_EXTERNAL_URL || '';
if (SELF_URL) {
  setInterval(() => { fetch(SELF_URL + '/health').catch(() => {}); }, 10 * 60 * 1000);
  console.log('[keepalive] pinging', SELF_URL + '/health', 'every 10 min');
}

// Log env var status so we can debug on Render
console.log('[bot] DISCORD_TOKEN:', TOKEN ? 'SET (' + TOKEN.length + ' chars)' : 'MISSING');
console.log('[bot] CLIENT_ID:', CLIENT_ID || 'MISSING');
console.log('[bot] GUILD_ID:', GUILD_ID || 'not set');
console.log('[bot] STORAGE_CHANNEL_ID:', STORAGE_CHANNEL_ID || 'not set');

if (!TOKEN) { console.log('[bot] no DISCORD_TOKEN set; running HTTP only.'); return; }

const commands = [
  new SlashCommandBuilder().setName('give').setDescription('Give a pack to a player')
    .addUserOption((o) => o.setName('user').setDescription('Player').setRequired(true))
    .addStringOption((o) => { o.setName('pack').setDescription('Pack').setRequired(true); PACKS.forEach((p) => o.addChoices({ name: p, value: p })); return o; }),
  new SlashCommandBuilder().setName('giveitem').setDescription('Give one cosmetic by template id')
    .addUserOption((o) => o.setName('user').setDescription('Player').setRequired(true))
    .addStringOption((o) => o.setName('id').setDescription('e.g. AthenaCharacter:CID_028_Athena_Commando_F').setRequired(true)),
  new SlashCommandBuilder().setName('remove').setDescription('Remove a pack (or all) from a player')
    .addUserOption((o) => o.setName('user').setDescription('Player').setRequired(true))
    .addStringOption((o) => { o.setName('pack').setDescription('Pack (leave empty to clear everything)'); PACKS.forEach((p) => o.addChoices({ name: p, value: p })); return o; }),
  new SlashCommandBuilder().setName('locker').setDescription('Show what a player owns')
    .addUserOption((o) => o.setName('user').setDescription('Player').setRequired(true))
].map((c) => c.toJSON());

async function registerCommands() {
  if (!CLIENT_ID) { console.log('[bot] no CLIENT_ID; skipping command registration'); return; }
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    if (GUILD_ID) await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    else await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('[bot] slash commands registered', GUILD_ID ? '(guild)' : '(global, ~1h to appear)');
  } catch (e) { console.log('[bot] command register failed:', e.message); }
}

function isAdmin(member) {
  if (!member) return false;
  if (ADMIN_ROLE_ID) return member.roles.cache.has(ADMIN_ROLE_ID);
  return member.permissions.has(PermissionFlagsBits.ManageGuild);
}

client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log('[bot] logged in as', client.user.tag);
  await loadGrants();
});

client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;
  // Defer immediately to get 15 minutes instead of 3 seconds
  await i.deferReply({ ephemeral: true });
  if (!isAdmin(i.member)) return i.editReply({ content: 'You do not have permission to manage grants.' });
  const u = i.options.getUser('user');
  const e = entry(u.id);
  if (i.commandName === 'give') {
    const pack = i.options.getString('pack');
    if (pack === 'Full Locker') { e.full = true; }
    else if (!e.packs.includes(pack)) e.packs.push(pack);
    await saveGrants();
    return i.editReply({ content: `Gave **${pack}** to ${u}. It applies next time they launch.`, allowedMentions: { parse: [] } });
  }
  if (i.commandName === 'giveitem') {
    const id = i.options.getString('id').trim();
    if (!e.items.includes(id)) e.items.push(id);
    await saveGrants();
    return i.editReply({ content: `Gave \`${id}\` to ${u}.`, allowedMentions: { parse: [] } });
  }
  if (i.commandName === 'remove') {
    const pack = i.options.getString('pack');
    if (!pack) { grants[u.id] = { full: false, packs: [], items: [] }; }
    else if (pack === 'Full Locker') { e.full = false; }
    else { e.packs = e.packs.filter((p) => p !== pack); }
    await saveGrants();
    return i.editReply({ content: pack ? `Removed **${pack}** from ${u}.` : `Cleared everything from ${u}.`, allowedMentions: { parse: [] } });
  }
  if (i.commandName === 'locker') {
    const parts = [];
    if (e.full) parts.push('**Full Locker** (every item)');
    if (e.packs.length) parts.push('Packs: ' + e.packs.join(', '));
    if (e.items.length) parts.push('Items: ' + e.items.length);
    return i.editReply({ content: parts.length ? `${u} owns:\n` + parts.join('\n') : `${u} has no grants yet.`, allowedMentions: { parse: [] } });
  }
});

registerCommands().then(() => {
  console.log('[bot] attempting login...');
  return client.login(TOKEN);
}).then(() => {
  console.log('[bot] login successful');
}).catch((e) => console.log('[bot] login error:', e.message, e.code || ''));
