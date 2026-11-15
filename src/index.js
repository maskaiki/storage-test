import { Telegraf, Markup } from 'telegraf';
import express from 'express';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const CATALOG_PATH = path.join(DATA_DIR, 'catalog.json');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

// Helper formatting bytes
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function toFolderTag(name) {
  return '#Folder_' + name.trim().replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
}

// Load or initialize catalog database
let catalog = {
  activeFolder: 'Umum',
  folders: {
    'Umum': {
      name: 'Umum',
      tag: '#Folder_Umum',
      createdAt: new Date().toISOString(),
      fileCount: 0,
      totalBytes: 0,
      dividerSent: false
    }
  },
  files: []
};

if (fs.existsSync(CATALOG_PATH)) {
  try {
    const raw = fs.readFileSync(CATALOG_PATH, 'utf8');
    catalog = { ...catalog, ...JSON.parse(raw) };
  } catch (e) {
    console.error('[Catalog] Error reading catalog.json, using defaults:', e.message);
  }
}

function saveCatalog() {
  try {
    fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2), 'utf8');
  } catch (e) {
    console.error('[Catalog] Error saving catalog:', e.message);
  }
}

// Load config (dynamic ownerId pairing)
let runtimeConfig = {
  ownerChatId: process.env.OWNER_CHAT_ID ? String(process.env.OWNER_CHAT_ID).trim() : null
};

if (fs.existsSync(CONFIG_PATH)) {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    runtimeConfig = { ...runtimeConfig, ...JSON.parse(raw) };
  } catch (e) {}
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(runtimeConfig, null, 2), 'utf8');
  } catch (e) {}
}

// Express App for Cloud Healthcheck (Render, Railway, Koyeb)
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>Vault Bot Server</title></head>
      <body style="font-family:sans-serif; background:#0f172a; color:#f8fafc; padding:2rem; text-align:center;">
        <h1>🗄️ Telegram Vault Storage Bot</h1>
        <p style="color:#10b981;">✅ Bot is running and healthy!</p>
        <p>Total Files Stored: <b>${catalog.files.length}</b></p>
        <p>Total Storage: <b>${formatBytes(catalog.files.reduce((acc, f) => acc + (f.sizeBytes || 0), 0))}</b></p>
      </body>
    </html>
  `);
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    totalFiles: catalog.files.length,
    activeFolder: catalog.activeFolder,
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`[Web Server] Healthcheck running on port ${PORT}`);
});

// Telegraf Bot Initialization
const token = process.env.TELEGRAM_BOT_TOKEN;
const channelId = process.env.STORAGE_CHANNEL_ID;

if (!token || !token.includes(':')) {
  console.error('\n⚠️ TELEGRAM_BOT_TOKEN belum diisi di file .env!');
  console.error('Silakan isi TELEGRAM_BOT_TOKEN dan STORAGE_CHANNEL_ID di file .env terlebih dahulu.\n');
  process.exit(1);
}

const bot = new Telegraf(token);

// Middleware: Owner Authentication & Auto-Pairing
bot.use(async (ctx, next) => {
  const fromId = ctx.from ? String(ctx.from.id) : null;
  if (!fromId) return next();

  // If ownerChatId is not set, pair with the first user who contacts the bot!
  if (!runtimeConfig.ownerChatId) {
    runtimeConfig.ownerChatId = fromId;
    saveConfig();
    console.log(`[Auto-Pair] Bot otomatis dikunci untuk pemilik dengan Telegram ID: ${fromId} (${ctx.from.first_name || ''})`);
  }

  // Allow only the owner to access the bot
  if (fromId !== runtimeConfig.ownerChatId) {
    if (ctx.chat?.type === 'private') {
      await ctx.reply(
        '⛔ <b>Akses Ditolak</b>\n\nBot ini adalah brankas penyimpanan pribadi yang dilindungi. Hanya pemilik bot yang dapat menggunakan layanan ini.',
        { parse_mode: 'HTML' }
      );
    }
    return;
  }

  return next();
});

// Helper: Ensure folder divider in channel
async function ensureFolderDivider(folderName) {
  if (!channelId) return;
  const f = catalog.folders[folderName];
  if (!f || f.dividerSent) return;

  try {
    const dividerText = 
`━━━━━━━━━━━━━━━━━━━━━━━━━━
📁 <b>FOLDER: [ ${f.name} ]</b>
🏷️ <b>Tag Folder:</b> <code>${f.tag}</code>
📅 <b>Dibuat:</b> ${new Date(f.createdAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })}
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Semua file berikutnya di bawah ini tersimpan rapi di dalam folder ini.</i>`;

    const sent = await bot.telegram.sendMessage(channelId, dividerText, { parse_mode: 'HTML' });
    try {
      await bot.telegram.pinChatMessage(channelId, sent.message_id, { disable_notification: true });
    } catch (e) {}

    f.dividerSent = true;
    saveCatalog();
  } catch (err) {
    console.warn('[Channel Divider Warning]:', err.message);
  }
}

// 1. /start Command
bot.command('start', async (ctx) => {
  const name = ctx.from.first_name || 'Teman';
  const totalFiles = catalog.files.length;
  const totalBytes = catalog.files.reduce((a, b) => a + (b.sizeBytes || 0), 0);

  const welcomeText = 
`👋 <b>Halo, ${name}! Selamat datang di Brankas Pribadi Telegram kamu!</b>

🗄️ <b>Status Brankas:</b>
• <b>Target Upload Aktif:</b> 📂 <code>${catalog.activeFolder}</code>
• <b>Total File Tersimpan:</b> ${totalFiles} file (${formatBytes(totalBytes)})
• <b>Kapasitas:</b> ♾️ Unlimited Telegram Cloud

<b>Cara Penggunaan:</b>
1. Kirim <b>Foto, Video, Lagu, atau Dokumen</b> apa saja ke chat ini, file langsung otomatis masuk ke Channel Private kamu!
2. Gunakan tombol di bawah atau ketik <code>/mkdir &lt;nama&gt;</code> untuk membuat folder baru.`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📁 Kelola Folder', 'menu_folders')],
    [Markup.button.callback('🎯 Ubah Folder Aktif', 'menu_switch_folder')],
    [Markup.button.callback('ℹ️ Bantuan & Perintah', 'menu_help')]
  ]);

  await ctx.reply(welcomeText, { parse_mode: 'HTML', ...keyboard });
});

// 2. /folders Command
bot.command('folders', async (ctx) => {
  await showFoldersMenu(ctx);
});

async function showFoldersMenu(ctx) {
  const foldersList = Object.values(catalog.folders);
  let text = `📂 <b>DAFTAR FOLDER PENYIMPANAN</b>\n\n`;

  foldersList.forEach((fd, i) => {
    const isActive = fd.name.toLowerCase() === catalog.activeFolder.toLowerCase();
    text += `${i + 1}. ${isActive ? '🟢 <b>[AKTIF]</b> ' : '📁 '}<b>${fd.name}</b>\n`;
    text += `   • Isi: ${fd.fileCount || 0} file (${formatBytes(fd.totalBytes || 0)})\n`;
    text += `   • Tag: <code>${fd.tag}</code>\n\n`;
  });

  text += `<i>Klik tombol di bawah untuk memilih folder tujuan upload baru:</i>`;

  const buttons = foldersList.map(fd => {
    const isActive = fd.name.toLowerCase() === catalog.activeFolder.toLowerCase();
    return [Markup.button.callback(`${isActive ? '🎯 ' : '📁 '}${fd.name}`, `set_active_${encodeURIComponent(fd.name)}`)];
  });

  buttons.push([Markup.button.callback('➕ Buat Folder Baru', 'prompt_mkdir')]);

  const keyboard = Markup.inlineKeyboard(buttons);

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
  }
}

// 3. /mkdir <nama_folder> Command
bot.command('mkdir', async (ctx) => {
  const parts = ctx.message.text.split(' ').slice(1);
  const folderName = parts.join(' ').trim();

  if (!folderName) {
    return ctx.reply('⚠️ Harap masukkan nama folder!\nContoh: <code>/mkdir Liburan Bali</code>', { parse_mode: 'HTML' });
  }

  if (catalog.folders[folderName]) {
    catalog.activeFolder = folderName;
    saveCatalog();
    return ctx.reply(`📂 Folder <b>"${folderName}"</b> sudah ada.\n🎯 Folder aktif sekarang diubah ke: <b>${folderName}</b>`, { parse_mode: 'HTML' });
  }

  catalog.folders[folderName] = {
    name: folderName,
    tag: toFolderTag(folderName),
    createdAt: new Date().toISOString(),
    fileCount: 0,
    totalBytes: 0,
    dividerSent: false
  };
  catalog.activeFolder = folderName;
  saveCatalog();

  await ensureFolderDivider(folderName);

  await ctx.reply(
    `✅ <b>Folder Baru Berhasil Dibuat!</b>\n\n` +
    `📁 <b>Nama Folder:</b> <code>${folderName}</code>\n` +
    `🏷️ <b>Tag Channel:</b> <code>${toFolderTag(folderName)}</code>\n` +
    `🎯 <b>Target Upload:</b> Langsung dijadikan folder aktif!\n\n` +
    `<i>Sekarang semua foto/file yang kamu kirim otomatis masuk ke folder "${folderName}".</i>`,
    { parse_mode: 'HTML' }
  );
});

// 4. /use <nama_folder> Command
bot.command('use', async (ctx) => {
  const parts = ctx.message.text.split(' ').slice(1);
  const folderName = parts.join(' ').trim();

  if (!folderName) {
    return ctx.reply('⚠️ Harap masukkan nama folder!\nContoh: <code>/use Umum</code>', { parse_mode: 'HTML' });
  }

  const found = Object.keys(catalog.folders).find(k => k.toLowerCase() === folderName.toLowerCase());
  if (!found) {
    return ctx.reply(`❌ Folder "${folderName}" tidak ditemukan. Ketik <code>/folders</code> untuk melihat daftar folder.`, { parse_mode: 'HTML' });
  }

  catalog.activeFolder = catalog.folders[found].name;
  saveCatalog();

  await ctx.reply(`🎯 <b>Target Upload Diubah!</b>\nSemua file berikutnya akan masuk ke: <b>${catalog.activeFolder}</b>`, { parse_mode: 'HTML' });
});

// Actions / Callbacks
bot.action('menu_folders', async (ctx) => {
  await ctx.answerCbQuery();
  await showFoldersMenu(ctx);
});

bot.action('menu_switch_folder', async (ctx) => {
  await ctx.answerCbQuery();
  await showFoldersMenu(ctx);
});

bot.action('prompt_mkdir', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('💡 Untuk membuat folder baru, ketik:\n<code>/mkdir &lt;Nama Folder&gt;</code>\n\nContoh:\n<code>/mkdir Dokumen Kantor</code>\n<code>/mkdir Liburan Jogja</code>', { parse_mode: 'HTML' });
});

bot.action('menu_help', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    `📖 <b>PANDUAN PERINTAH BOT</b>\n\n` +
    `• <b>Kirim Foto/Video Langsung:</b> File otomatis masuk ke folder aktif saat ini.\n` +
    `• <code>/folders</code> : Lihat semua folder dan statistik file.\n` +
    `• <code>/mkdir &lt;nama&gt;</code> : Buat folder baru.\n` +
    `• <code>/use &lt;nama&gt;</code> : Ganti tujuan folder aktif.\n` +
    `• <code>/start</code> : Menu utama bot.`,
    { parse_mode: 'HTML' }
  );
});

bot.action(/^set_active_(.+)$/, async (ctx) => {
  const folderName = decodeURIComponent(ctx.match[1]);
  if (catalog.folders[folderName]) {
    catalog.activeFolder = folderName;
    saveCatalog();
    await ctx.answerCbQuery(`Folder aktif: ${folderName}`);
    await showFoldersMenu(ctx);
  } else {
    await ctx.answerCbQuery('Folder tidak ditemukan!');
  }
});

// ==========================================
// MEDIA UPLOAD HANDLER
// (Photos, Videos, Documents, Audio, Voice)
// ==========================================
bot.on(['photo', 'video', 'document', 'audio', 'voice'], async (ctx) => {
  if (!channelId) {
    return ctx.reply('⚠️ STORAGE_CHANNEL_ID belum dikonfigurasi di file .env.');
  }

  const folderName = catalog.activeFolder || 'Umum';
  if (!catalog.folders[folderName]) {
    catalog.folders[folderName] = {
      name: folderName,
      tag: toFolderTag(folderName),
      createdAt: new Date().toISOString(),
      fileCount: 0,
      totalBytes: 0,
      dividerSent: false
    };
  }

  await ensureFolderDivider(folderName);

  let fileId = '';
  let fileName = 'File';
  let fileType = 'document';
  let sizeBytes = 0;

  if (ctx.message.photo) {
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    fileId = largest.file_id;
    fileName = `Foto_${Date.now()}.jpg`;
    fileType = 'photo';
    sizeBytes = largest.file_size || 0;
  } else if (ctx.message.video) {
    const v = ctx.message.video;
    fileId = v.file_id;
    fileName = v.file_name || `Video_${Date.now()}.mp4`;
    fileType = 'video';
    sizeBytes = v.file_size || 0;
  } else if (ctx.message.document) {
    const d = ctx.message.document;
    fileId = d.file_id;
    fileName = d.file_name || `Doc_${Date.now()}`;
    fileType = 'document';
    sizeBytes = d.file_size || 0;
  } else if (ctx.message.audio) {
    const a = ctx.message.audio;
    fileId = a.file_id;
    fileName = a.file_name || `${a.title || 'Audio'}.mp3`;
    fileType = 'audio';
    sizeBytes = a.file_size || 0;
  } else if (ctx.message.voice) {
    fileId = ctx.message.voice.file_id;
    fileName = `Voice_${Date.now()}.ogg`;
    fileType = 'voice';
    sizeBytes = ctx.message.voice.file_size || 0;
  }

  const folderTag = toFolderTag(folderName);
  const caption = 
`📁 <b>FOLDER: [ ${folderName} ]</b>
🏷️ <b>Tag Folder:</b> ${folderTag}

📄 <b>Nama File:</b> <code>${fileName}</code>
📦 <b>Ukuran:</b> ${formatBytes(sizeBytes)}
📅 <b>Waktu:</b> ${new Date().toLocaleString('id-ID')}
👤 <b>Pengirim:</b> ${ctx.from.first_name || 'Pemilik'}`;

  try {
    // Forward / Copy message directly to the Private Channel
    const forwarded = await ctx.telegram.copyMessage(channelId, ctx.chat.id, ctx.message.message_id, {
      caption: caption,
      parse_mode: 'HTML'
    });

    // Update catalog state
    const entry = {
      id: `file_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      name: fileName,
      type: fileType,
      sizeBytes: sizeBytes,
      sizeFormatted: formatBytes(sizeBytes),
      date: new Date().toISOString(),
      channelMessageId: forwarded.message_id,
      folder: folderName,
      folderTag: folderTag
    };

    catalog.files.unshift(entry);
    catalog.folders[folderName].fileCount = (catalog.folders[folderName].fileCount || 0) + 1;
    catalog.folders[folderName].totalBytes = (catalog.folders[folderName].totalBytes || 0) + sizeBytes;
    saveCatalog();

    // Confirm to user in private chat
    await ctx.reply(
      `✅ <b>Berhasil Disimpan!</b>\n\n` +
      `📁 <b>Folder:</b> <code>${folderName}</code>\n` +
      `📦 <b>Ukuran:</b> ${formatBytes(sizeBytes)}\n` +
      `🔗 <b>Tag di Channel:</b> ${folderTag}\n\n` +
      `<i>File kamu sudah aman di Telegram Private Vault.</i>`,
      {
        parse_mode: 'HTML',
        reply_to_message_id: ctx.message.message_id
      }
    );
  } catch (err) {
    console.error('[Upload Error]:', err.message);
    await ctx.reply(`❌ Gagal menyimpan file ke channel: ${err.message}`);
  }
});

// Launch Telegraf Bot
bot.launch()
  .then(() => {
    console.log(`\n======================================================`);
    console.log(`✅ Telegram Personal Vault Bot AKTIF!`);
    console.log(`👉 Channel Target: ${channelId}`);
    if (runtimeConfig.ownerChatId) {
      console.log(`👤 Dikunci untuk Owner ID: ${runtimeConfig.ownerChatId}`);
    } else {
      console.log(`🔓 Mode Auto-Pairing: Menunggu chat pertama dari pemilik...`);
    }
    console.log(`======================================================\n`);
  })
  .catch((err) => {
    console.error('❌ Gagal menjalankan bot Telegram:', err.message);
  });

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
