require("dotenv").config();

const fs = require("fs");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  EmbedBuilder,
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("Missing env vars: DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID");
  process.exit(1);
}

const deckPath = path.join(__dirname, "deck.json");
if (!fs.existsSync(deckPath)) {
  console.error("Missing deck.json in the same folder as index.js");
  process.exit(1);
}
const deck = JSON.parse(fs.readFileSync(deckPath, "utf8"));

/* -------------------- helpers -------------------- */

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function draw(pile, n) {
  const out = [];
  while (out.length < n) {
    if (pile.length === 0) break;
    out.push(pile.pop());
  }
  return out;
}

// ✅ count {blank}
function countBlanks(blackCard) {
  const m = String(blackCard).match(/\{blank\}/g);
  return Math.max(1, m ? m.length : 0);
}

// ✅ fill {blank}
function fillBlack(black, whites) {
  let out = String(black);
  for (const w of whites) {
    out = out.replace(/\{blank\}/, `**${w}**`);
  }
  if (whites.length && !out.includes("**")) {
    out = `${black} **${whites.join(" / ")}**`;
  }
  return out;
}

function clampInt(v, min, max, fallback) {
  const x = Number(v);
  if (!Number.isInteger(x)) return fallback;
  return Math.min(max, Math.max(min, x));
}

/* -------------------- in-memory games -------------------- */

const games = new Map();

function newGame(channelId) {
  return {
    channelId,
    players: new Set(),
    scores: new Map(),
    judgeId: null,
    round: 0,
    phase: "lobby", // lobby | collecting | judging
    blackPile: shuffle(deck.black || []),
    whitePile: shuffle(deck.white || []),
    hands: new Map(),
    submissions: new Map(),
    currentBlack: null,
    requiredPicks: 1,
    soloMode: false,
  };
}

function ensureGame(channelId) {
  if (!games.has(channelId)) games.set(channelId, newGame(channelId));
  return games.get(channelId);
}

function topUpHand(game, userId, targetSize = 10) {
  let hand = game.hands.get(userId);
  if (!hand) hand = [];

  while (hand.length < targetSize) {
    const d = draw(game.whitePile, 1);
    if (d.length === 0) {
      game.whitePile = shuffle(deck.white || []);
      const d2 = draw(game.whitePile, 1);
      if (d2.length === 0) break;
      hand.push(d2[0]);
    } else {
      hand.push(d[0]);
    }
  }

  game.hands.set(userId, hand);
  return hand;
}

function prettyHand(hand) {
  return hand.map((c, i) => `**${i + 1}.** ${c}`).join("\n");
}

function buildHandMenu(hand, picks, customId) {
  return new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(`Pick ${picks} card${picks > 1 ? "s" : ""}`)
    .setMinValues(picks)
    .setMaxValues(picks)
    .addOptions(
      hand.slice(0, 25).map((text, idx) => ({
        label: `${idx + 1}. ${text}`.slice(0, 100),
        value: String(idx),
      }))
    );
}

function makeNPCId(channelId, n) {
  return `npc:${channelId}:${n}`;
}

function ensureNPCs(game, channelId, count) {
  for (let i = 1; i <= count; i++) {
    const npcId = makeNPCId(channelId, i);
    game.players.add(npcId);
    if (!game.scores.has(npcId)) game.scores.set(npcId, 0);
    topUpHand(game, npcId);
  }
}

function displayName(pid) {
  if (pid.startsWith("npc:")) {
    const parts = pid.split(":");
    const n = parts[2] || "X";
    return `NPC ${n}`;
  }
  return `<@${pid}>`;
}

function awardLine(pid, sc) {
  if (pid.startsWith("npc:")) return `• **${displayName(pid)}** — **${sc}** Skye Miles 😄`;
  return `• ${displayName(pid)} — **${sc}** Skye Miles 😄`;
}

/* -------------------- commands -------------------- */

const commands = [
  new SlashCommandBuilder()
    .setName("cah")
    .setDescription("Possum CAH (ephemeral hands + optional solo mode)")
    .addSubcommand(s => s.setName("start").setDescription("Start/reset a game in this channel (you become judge)"))
    .addSubcommand(s => s.setName("join").setDescription("Join the game in this channel"))
    .addSubcommand(s => s.setName("leave").setDescription("Leave the game in this channel"))
    .addSubcommand(s => s.setName("hand").setDescription("Show your hand (ephemeral)"))
    .addSubcommand(s => s.setName("round").setDescription("Start the next round (judge only unless solo mode)"))
    .addSubcommand(s => s.setName("play").setDescription("Submit your card(s) for this round (ephemeral picker)"))
    .addSubcommand(s => s.setName("scores").setDescription("Show scores (public)"))
    .addSubcommand(s =>
      s.setName("solo")
        .setDescription("Toggle solo mode (you vs NPC submissions)")
        .addStringOption(opt =>
          opt.setName("mode")
            .setDescription("on or off")
            .setRequired(true)
            .addChoices(
              { name: "on", value: "on" },
              { name: "off", value: "off" }
            )
        )
    ),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log("✅ Registered /cah commands");
}

/* -------------------- client -------------------- */

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once("ready", () => console.log(`🤖 Logged in as ${client.user.tag}`));

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === "cah") {
      const channelId = interaction.channelId;
      const sub = interaction.options.getSubcommand();
      const game = ensureGame(channelId);
      const userId = interaction.user.id;

      const isInGame = game.players.has(userId);
      const isJudge = game.judgeId === userId;

      if (sub === "start") {
        games.set(channelId, newGame(channelId));
        const g = games.get(channelId);

        g.players.add(userId);
        g.judgeId = userId;
        g.scores.set(userId, 0);
        topUpHand(g, userId);

        await interaction.reply({
          content: `👑 Game started in this channel.\nJudge: <@${userId}>\nPlayers join with \`/cah join\`.\nSolo mode: **${g.soloMode ? "ON" : "OFF"}** (toggle with \`/cah solo on|off\`)`,
        });
        return;
      }

      if (sub === "solo") {
        const mode = interaction.options.getString("mode");
        if (!isJudge) {
          await interaction.reply({ content: "Only the judge can toggle solo mode.", ephemeral: true });
          return;
        }
        game.soloMode = mode === "on";

        if (game.soloMode) {
          ensureNPCs(game, channelId, 2);
        } else {
          for (const pid of [...game.players]) {
            if (pid.startsWith("npc:")) {
              game.players.delete(pid);
              game.hands.delete(pid);
              game.submissions.delete(pid);
              game.scores.delete(pid);
            }
          }
        }

        await interaction.reply({
          content: `🧪 Solo mode is now **${game.soloMode ? "ON" : "OFF"}**.`,
          ephemeral: true
        });
        return;
      }

      if (sub === "join") {
        game.players.add(userId);
        if (!game.scores.has(userId)) game.scores.set(userId, 0);
        const hand = topUpHand(game, userId);

        const embed = new EmbedBuilder()
          .setTitle("🂠 You joined the game")
          .setDescription(`Here’s your hand (private):\n\n${prettyHand(hand)}`)
          .setFooter({ text: "Use /cah play during a round to submit." });

        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }

      if (sub === "leave") {
        game.players.delete(userId);
        game.hands.delete(userId);
        game.submissions.delete(userId);

        if (game.judgeId === userId) game.judgeId = null;

        await interaction.reply({ content: "👋 You left the game.", ephemeral: true });
        return;
      }

      if (sub === "hand") {
        if (!isInGame) {
          await interaction.reply({ content: "Use `/cah join` first.", ephemeral: true });
          return;
        }
        const hand = topUpHand(game, userId);
        const embed = new EmbedBuilder()
          .setTitle("🂠 Your Hand (private)")
          .setDescription(prettyHand(hand));

        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }

      if (sub === "scores") {
        if (game.scores.size === 0) {
          await interaction.reply("No scores yet.");
          return;
        }
        const lines = [...game.scores.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([pid, sc]) => awardLine(pid, sc))
          .join("\n");

        await interaction.reply(`📈 **Scores**\n${lines}`);
        return;
      }

      if (sub === "round") {
        if (!isJudge) {
          await interaction.reply({ content: "Only the judge can start a round.", ephemeral: true });
          return;
        }

        if (!game.soloMode && game.players.size < 2) {
          await interaction.reply({ content: "Need at least 2 players (or enable solo mode with `/cah solo on`).", ephemeral: true });
          return;
        }

        if (game.soloMode) {
          game.players.add(userId);
          ensureNPCs(game, channelId, 2);
        }

        game.round += 1;
        game.phase = "collecting";
        game.submissions.clear();

        if (game.blackPile.length === 0) game.blackPile = shuffle(deck.black || []);
        game.currentBlack = game.blackPile.pop() || "The King demanded {blank} immediately.";
        game.requiredPicks = countBlanks(game.currentBlack);

        for (const pid of game.players) topUpHand(game, pid);

        const embed = new EmbedBuilder()
          .setTitle(`🂡 Round ${game.round}${game.soloMode ? " (SOLO)" : ""}`)
          .setDescription(
            `**Black:** ${game.currentBlack}\n\n` +
            `Pick: **${game.requiredPicks}** | Players: **${game.players.size}**\n\n` +
            `Submit with **/cah play** (your picker is private).`
          );

        await interaction.reply({ embeds: [embed] });

        if (game.soloMode) {
          const neededNPCs = [...game.players].filter(pid => pid.startsWith("npc:"));
          for (const pid of neededNPCs) {
            const npcHand = topUpHand(game, pid);
            const picks = clampInt(game.requiredPicks, 1, 3, 1);
            const chosen = npcHand.slice(0, picks);
            npcHand.splice(0, picks);
            game.hands.set(pid, npcHand);
            game.submissions.set(pid, chosen);
            topUpHand(game, pid);
          }
        }

        return;
      }

      if (sub === "play") {
        if (!isInGame && !game.soloMode) {
          await interaction.reply({ content: "Use `/cah join` first.", ephemeral: true });
          return;
        }
        if (game.phase !== "collecting" || !game.currentBlack) {
          await interaction.reply({ content: "No active round. Judge should run `/cah round`.", ephemeral: true });
          return;
        }
        if (game.submissions.has(userId)) {
          await interaction.reply({ content: "You already submitted this round.", ephemeral: true });
          return;
        }

        if (!game.soloMode && userId === game.judgeId) {
          await interaction.reply({ content: "Judge doesn’t submit this round.", ephemeral: true });
          return;
        }

        if (game.soloMode) {
          game.players.add(userId);
          if (!game.scores.has(userId)) game.scores.set(userId, 0);
        }

        const hand = topUpHand(game, userId);
        const picks = clampInt(game.requiredPicks, 1, 3, 1);
        if (hand.length < picks) {
          await interaction.reply({ content: "Not enough cards in your hand.", ephemeral: true });
          return;
        }

        const menu = buildHandMenu(hand, picks, `cah_submit:${channelId}:${userId}`);
        const row = new ActionRowBuilder().addComponents(menu);

        const embed = new EmbedBuilder()
          .setTitle("🂠 Submit (private)")
          .setDescription(`**Black:** ${game.currentBlack}\n\nPick **${picks}** from your hand:`);

        await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
        return;
      }
    }

    if (interaction.isStringSelectMenu()) {
      const parts = interaction.customId.split(":");
      if (parts[0] !== "cah_submit") return;

      const channelId = parts[1];
      const userId = parts[2];

      if (interaction.user.id !== userId) {
        await interaction.reply({ content: "That picker isn’t for you.", ephemeral: true });
        return;
      }

      const game = games.get(channelId);
      if (!game || game.phase !== "collecting") {
        await interaction.reply({ content: "Round isn’t active.", ephemeral: true });
        return;
      }
      if (game.submissions.has(userId)) {
        await interaction.reply({ content: "You already submitted.", ephemeral: true });
        return;
      }

      const hand = game.hands.get(userId) || [];
      const indices = interaction.values.map(v => parseInt(v, 10)).sort((a, b) => b - a);
      const chosen = indices.map(i => hand[i]).filter(Boolean);

      for (const idx of indices) {
        if (idx >= 0 && idx < hand.length) hand.splice(idx, 1);
      }
      game.hands.set(userId, hand);
      game.submissions.set(userId, chosen);

      topUpHand(game, userId);

      const filled = fillBlack(game.currentBlack, chosen);
      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setTitle("✅ Submitted (private)")
            .setDescription(`Your submission:\n${filled}\n\nHand replenished.`)
        ],
        components: []
      });

      const needed = game.soloMode
        ? [...game.players].filter(pid => !pid.startsWith("npc:"))
        : [...game.players].filter(pid => pid !== game.judgeId);

      const allIn = needed.every(pid => game.submissions.has(pid));

      if (allIn) {
        game.phase = "judging";

        const submitters = [...game.submissions.keys()];
        const submissionsList = submitters.map((pid, i) => ({
          pid,
          label: String.fromCharCode(65 + i),
          cards: game.submissions.get(pid) || []
        }));

        const revealText = submissionsList.map(s => {
          const filled = fillBlack(game.currentBlack, s.cards);
          return `**${s.label}.** ${filled}`;
        }).join("\n\n");

        const embed = new EmbedBuilder()
          .setTitle("🗳️ Judge Pick")
          .setDescription(`**Black:** ${game.currentBlack}\n\n${revealText}`);

        const buttons = new ActionRowBuilder().addComponents(
          submissionsList.slice(0, 5).map(s =>
            new ButtonBuilder()
              .setCustomId(`cah_pick|${channelId}|${s.pid}`) // ✅ FIX: use | delimiter
              .setLabel(s.label)
              .setStyle(ButtonStyle.Primary)
          )
        );

        const channel = await client.channels.fetch(channelId);
        await channel.send({
          content: `<@${game.judgeId}> pick the winner:`,
          embeds: [embed],
          components: [buttons]
        });
      }

      return;
    }

    if (interaction.isButton()) {
      // ✅ FIX: parse pick id using |
      const parts = interaction.customId.split("|");
      if (parts[0] !== "cah_pick") return;

      const channelId = parts[1];
      const winnerPid = parts.slice(2).join("|"); // safe even if pid contains | (it won’t)

      const game = games.get(channelId);
      if (!game || game.phase !== "judging") {
        await interaction.reply({ content: "Not in judging phase.", ephemeral: true });
        return;
      }
      if (interaction.user.id !== game.judgeId) {
        await interaction.reply({ content: "Only the judge can pick.", ephemeral: true });
        return;
      }

      const prev = game.scores.get(winnerPid) ?? 0;
      game.scores.set(winnerPid, prev + 1);

      const winnerCards = game.submissions.get(winnerPid) || [];
      const filled = fillBlack(game.currentBlack, winnerCards);

      const scoreLines = [...game.scores.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([pid, sc]) => awardLine(pid, sc))
        .join("\n");

      game.phase = "lobby";
      game.currentBlack = null;
      game.requiredPicks = 1;
      game.submissions.clear();

      await interaction.update({
        content:
          `🏆 **Winner:** ${displayName(winnerPid)}\n` +
          `${filled}\n\n` +
          `📈 **Scores**\n${scoreLines}\n\n` +
          `Judge starts next round with **/cah round**.\n` +
          `Solo mode: **${game.soloMode ? "ON" : "OFF"}**`,
        embeds: [],
        components: []
      });

      return;
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      try {
        await interaction.reply({
          content: "Something broke, but it’s fixable. Check terminal output.",
          ephemeral: true
        });
      } catch {}
    }
  }
});

(async () => {
  await registerCommands();
  await client.login(TOKEN);
})();