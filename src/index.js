import { Telegraf, Markup } from 'telegraf';
import express from 'express';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = process.env.VERCEL ? path.join('/tmp', 'data') : path.join(__dirname, '..', 'data');

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

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Load or initialize catalog database (Local caching)
let catalog = {
  activeFolder: 'Kansha',
  folders: {
    'Umum': {
      name: 'Umum',
      tag: '#Folder_Umum',
      createdAt: new Date().toISOString(),
      fileCount: 0,
      totalBytes: 0,
      dividerSent: false
    },
    'Kansha': {
      name: 'Kansha',
      tag: '#Folder_Kansha',
      createdAt: new Date().toISOString(),
      fileCount: 1,
      totalBytes: 1352663,
      dividerSent: true
    }
  },
  files: [
    {
      id: "file_1794726953000_6528",
      name: "IMG_6528.mov",
      type: "video",
      fileId: "BAACAgUAAxkBAAMZavlcJwiICSbxjcYk7tbDp7J56VoAApEmAAI18shXSITZ8QxNep09BA",
      sizeBytes: 1352663,
      sizeFormatted: "1.29 MB",
      date: "2026-11-15T07:15:53.000Z",
      channelMessageId: 13,
      folder: "Kansha",
      folderTag: "#Folder_Kansha"
    }
  ]
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

// Telegraf Bot Initialization
const token = process.env.TELEGRAM_BOT_TOKEN;
const channelId = process.env.STORAGE_CHANNEL_ID;

if (!token || !token.includes(':')) {
  console.error('\n⚠️ TELEGRAM_BOT_TOKEN belum diisi di file .env!');
  console.error('Silakan isi TELEGRAM_BOT_TOKEN dan STORAGE_CHANNEL_ID di file .env terlebih dahulu.\n');
  process.exit(1);
}

const bot = new Telegraf(token);

let botUsername = 'storageabim_bot';
bot.telegram.getMe().then(me => {
  if (me && me.username) botUsername = me.username;
}).catch(() => {});

// ============================================================================
// SERVERLESS PERSISTENCE VIA TELEGRAM CLOUD (Channel Pinned Divider & Database Sync)
// Vercel serverless has ephemeral /tmp, so Telegram channel stores all data!
// ============================================================================

let isSyncing = false;
async function syncCatalogToTelegram() {
  if (!channelId || isSyncing) return;
  isSyncing = true;
  try {
    const dataBuf = Buffer.from(JSON.stringify({
      files: catalog.files,
      folders: catalog.folders,
      activeFolder: catalog.activeFolder,
      updatedAt: new Date().toISOString()
    }));

    const sent = await bot.telegram.sendDocument(
      channelId,
      { source: dataBuf, filename: `vault_catalog_${Date.now()}.json` },
      { caption: `💾 #SYSTEM_VAULT_DB_SYNC`, disable_notification: true }
    );
    const fileId = sent.document.file_id;

    const folders = await getFoldersList();
    const desc = `Vault Storage | Folders: ${folders.join(', ')} | DB:${fileId}`.substring(0, 255);
    await bot.telegram.setChatDescription(channelId, desc);
    saveCatalog();
  } catch (err) {
    console.warn('[Sync DB Warning]:', err.message);
  } finally {
    isSyncing = false;
  }
}

async function loadCatalogFromTelegram() {
  if (!channelId) return;
  try {
    const chat = await bot.telegram.getChat(channelId);
    if (chat.description) {
      const match = chat.description.match(/DB:([a-zA-Z0-9_-]+)/);
      if (match && match[1]) {
        const fileId = match[1];
        const link = await bot.telegram.getFileLink(fileId);
        const res = await fetch(link.href);
        const data = await res.json();
        if (data && Array.isArray(data.files) && data.files.length > 0) {
          catalog.files = data.files;
          if (data.folders) catalog.folders = { ...catalog.folders, ...data.folders };
          if (data.activeFolder) catalog.activeFolder = data.activeFolder;
          saveCatalog();
          console.log(`[DB Cloud] Loaded ${catalog.files.length} files from Telegram Cloud!`);
        }
      }
    }
  } catch (err) {
    console.warn('[Load DB Warning]:', err.message);
  }
}

// 1. Get active folder directly from Telegram channel pinned message
async function getActiveFolder() {
  if (!channelId) return catalog.activeFolder || 'Umum';
  try {
    const chat = await bot.telegram.getChat(channelId);
    if (chat.pinned_message && chat.pinned_message.text) {
      const match = chat.pinned_message.text.match(/FOLDER(?:\s*AKTIF)?:\s*\[\s*([^\]]+)\s*\]/i);
      if (match && match[1]) {
        const active = match[1].trim();
        catalog.activeFolder = active;
        return active;
      }
    }
  } catch (err) {
    console.warn('[GetActiveFolder Warning]:', err.message);
  }
  return catalog.activeFolder || 'Umum';
}

// 2. Get list of folders from Telegram channel description & pinned message
async function getFoldersList() {
  const folders = new Set(['Umum']);
  if (catalog.folders) {
    Object.keys(catalog.folders).forEach(f => folders.add(f));
  }

  if (channelId) {
    try {
      const chat = await bot.telegram.getChat(channelId);
      if (chat.description) {
        const match = chat.description.match(/Folders:\s*([^|]+)/i);
        if (match && match[1]) {
          match[1].split(',').map(s => s.trim()).filter(Boolean).forEach(f => folders.add(f));
        }
      }
      if (chat.pinned_message && chat.pinned_message.text) {
        const pMatch = chat.pinned_message.text.match(/FOLDER(?:\s*AKTIF)?:\s*\[\s*([^\]]+)\s*\]/i);
        if (pMatch && pMatch[1]) folders.add(pMatch[1].trim());
      }
    } catch (err) {
      console.warn('[GetFoldersList Warning]:', err.message);
    }
  }
  return Array.from(folders);
}

// 3. Save new folder to channel description (acts as persistent list)
async function saveFolderToChannel(newFolder) {
  if (!channelId) return;
  try {
    const currentList = await getFoldersList();
    if (!currentList.some(f => f.toLowerCase() === newFolder.toLowerCase())) {
      currentList.push(newFolder);
    }
    const desc = `Vault Storage Bot | Folders: ${currentList.join(', ')}`.substring(0, 255);
    await bot.telegram.setChatDescription(channelId, desc);
  } catch (err) {
    console.warn('[SaveToChannelDesc Warning]:', err.message);
  }
}

// 4. Send and pin folder divider in channel WITH Interactive Action Button
async function sendAndPinDivider(folderName, isNew = false) {
  if (!channelId) return;
  try {
    const tag = toFolderTag(folderName);
    const dateStr = new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
    const text = isNew ?
`━━━━━━━━━━━━━━━━━━━━━━━━━━
📁 <b>FOLDER: [ ${folderName} ]</b>
🏷️ <b>Tag Folder:</b> <code>${tag}</code>
📅 <b>Dibuat:</b> ${dateStr}
━━━━━━━━━━━━━━━━━━━━━━━━━━
<i>Semua file berikutnya di bawah ini tersimpan rapi di dalam folder ini.</i>` :
`━━━━━━━━━━━━━━━━━━━━━━━━━━
📁 <b>FOLDER AKTIF: [ ${folderName} ]</b>
🏷️ <b>Tag Folder:</b> <code>${tag}</code>
📅 <b>Diaktifkan:</b> ${dateStr}
━━━━━━━━━━━━━━━━━━━━━━━━━━
🎯 <i>Target upload aktif dialihkan ke folder ini.</i>`;

    const buttonUrl = `https://t.me/${botUsername}?start=bundle_${encodeURIComponent(folderName)}`;
    const sent = await bot.telegram.sendMessage(channelId, text, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: `📦 Buka Bundle & Ambil Semua Isi Folder [ ${folderName} ]`,
              url: buttonUrl
            }
          ]
        ]
      }
    });

    try {
      await bot.telegram.pinChatMessage(channelId, sent.message_id, { disable_notification: true });
    } catch (e) {
      console.warn('[Pin Warning]:', e.message);
    }

    if (!catalog.folders[folderName]) {
      catalog.folders[folderName] = {
        name: folderName,
        tag: tag,
        createdAt: new Date().toISOString(),
        fileCount: 0,
        totalBytes: 0,
        dividerSent: true
      };
    } else {
      catalog.folders[folderName].dividerSent = true;
    }
    catalog.activeFolder = folderName;
    saveCatalog();
  } catch (err) {
    console.warn('[Divider Warning]:', err.message);
  }
}

// ============================================================================
// BUNDLE HANDLER (Kumpulkan semua file folder dalam 1 pesan album yang menarik)
// ============================================================================
async function sendFolderBundle(ctx, folderName) {
  if (catalog.files.length === 0) {
    await loadCatalogFromTelegram();
  }

  const matchingFiles = catalog.files.filter(
    f => f.folder && f.folder.toLowerCase() === folderName.toLowerCase()
  );

  const folderTag = toFolderTag(folderName);

  if (matchingFiles.length === 0) {
    const emptyCard = 
`╔══════════════════════════════════════╗
   📁  <b>K O L E K S I   F O L D E R</b>
   📂  <b>[ ${escapeHtml(folderName.toUpperCase())} ]</b>
╚══════════════════════════════════════╝

🏷️ <b>Tag Channel:</b> <code>${folderTag}</code>
📊 <b>Status:</b> 📭 <i>Folder ini saat ini masih kosong.</i>

💡 <i>Kirim foto, video, atau dokumen ke chat ini sekarang untuk langsung menyimpannya ke folder "${folderName}"!</i>`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(`🎯 Jadikan "${folderName}" Target Upload`, `set_active_${encodeURIComponent(folderName)}`)],
      [Markup.button.callback('📁 Kelola Folder Lainnya', 'menu_folders')]
    ]);

    return ctx.reply(emptyCard, { parse_mode: 'HTML', ...keyboard });
  }

  // Calculate statistics
  const totalFiles = matchingFiles.length;
  const totalBytes = matchingFiles.reduce((acc, f) => acc + (f.sizeBytes || 0), 0);
  const photoCount = matchingFiles.filter(f => f.type === 'photo').length;
  const videoCount = matchingFiles.filter(f => f.type === 'video').length;
  const docCount = matchingFiles.filter(f => f.type === 'document').length;
  const audioCount = matchingFiles.filter(f => f.type === 'audio' || f.type === 'voice').length;

  let breakdownParts = [];
  if (photoCount) breakdownParts.push(`🖼️ ${photoCount} Foto`);
  if (videoCount) breakdownParts.push(`🎬 ${videoCount} Video`);
  if (docCount) breakdownParts.push(`📄 ${docCount} Dokumen`);
  if (audioCount) breakdownParts.push(`🎵 ${audioCount} Audio`);

  // Build file list (top 10 preview)
  const previewList = matchingFiles.slice(0, 10).map((f, i) => {
    const icon = f.type === 'photo' ? '🖼️' : f.type === 'video' ? '🎬' : f.type === 'audio' ? '🎵' : '📄';
    return `${i + 1}. ${icon} <code>${escapeHtml(f.name)}</code> (${f.sizeFormatted || formatBytes(f.sizeBytes)})`;
  }).join('\n');

  const moreText = totalFiles > 10 ? `\n<i>...dan ${totalFiles - 10} file lainnya tersimpan.</i>` : '';

  const bundleCard = 
`╔══════════════════════════════════════╗
   📁  <b>K O L E K S I   F O L D E R</b>
   📂  <b>[ ${escapeHtml(folderName.toUpperCase())} ]</b>
╚══════════════════════════════════════╝

🏷️ <b>Tag Channel:</b> <code>${folderTag}</code>
📊 <b>Ringkasan Bundle:</b>
• 🗂️ <b>Total Berkas:</b> <b>${totalFiles} file</b> (${formatBytes(totalBytes)})
• 📦 <b>Rincian:</b> ${breakdownParts.join(' • ') || 'Campuran'}
• 🕒 <b>Update Terakhir:</b> ${new Date(matchingFiles[0].date).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📑 <b>DAFTAR BERKAS TERKUMPUL:</b>
${previewList}${moreText}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✨ <i>Semua media di atas telah dikemas dan dikirimkan dalam 1 pesan di bawah ini! 👇</i>`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📥 Kirim Ulang Album Media', `bundle_send_album_${encodeURIComponent(folderName)}`)],
    [Markup.button.callback(`🎯 Jadikan "${folderName}" Target Upload`, `set_active_${encodeURIComponent(folderName)}`)],
    [Markup.button.callback('📁 Kelola Folder Lainnya', 'menu_folders')]
  ]);

  // Send the aesthetic bundle summary card
  await ctx.reply(bundleCard, { parse_mode: 'HTML', ...keyboard });

  // Send all media files gathered in ONE single message (MediaGroup Album mosaic)
  const mediaItems = matchingFiles.filter(f => f.type === 'photo' || f.type === 'video');
  if (mediaItems.length > 0) {
    try {
      const batch = mediaItems.slice(0, 10);
      const album = batch.map((item, idx) => ({
        type: item.type === 'video' ? 'video' : 'photo',
        media: item.fileId,
        caption: idx === 0 
          ? `📁 <b>Bundle Folder: [ ${escapeHtml(folderName)} ]</b> (${mediaItems.length} media)\n🏷️ <code>${folderTag}</code>`
          : undefined,
        parse_mode: 'HTML'
      }));

      await ctx.replyWithMediaGroup(album);
    } catch (err) {
      console.warn('[MediaGroup Warning]:', err.message);
      // Fallback: Copy first media from channel
      try {
        const first = mediaItems[0];
        if (first.channelMessageId && channelId) {
          await ctx.telegram.copyMessage(ctx.chat.id, channelId, first.channelMessageId);
        }
      } catch (e) {}
    }
  }

  // If there are documents/audio files, send them
  const docItems = matchingFiles.filter(f => f.type === 'document' || f.type === 'audio' || f.type === 'voice');
  if (docItems.length > 0 && docItems.length <= 5) {
    for (const doc of docItems) {
      try {
        if (doc.fileId) {
          await ctx.replyWithDocument(doc.fileId, {
            caption: `📄 <b>${escapeHtml(doc.name)}</b> (${doc.sizeFormatted})\n📁 Folder: [ ${folderName} ]`,
            parse_mode: 'HTML'
          });
        }
      } catch (e) {}
    }
  }
}

async function showBundlePickerMenu(ctx) {
  const folders = await getFoldersList();
  let text = `📦 <b>PILIH BUNDLE FOLDER</b>\n\n`;
  text += `Pilih folder di bawah untuk mengumpulkan semua foto & video di dalamnya dan dikirimkan <b>dalam 1 pesan album cantik</b>:\n`;

  const buttons = folders.map(f => [
    Markup.button.callback(`📦 Koleksi [ ${f} ]`, `bundle_view_${encodeURIComponent(f)}`)
  ]);

  const keyboard = Markup.inlineKeyboard(buttons);
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
    } catch (e) {
      await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
    }
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
  }
}

// Express App (Healthcheck & Webhook for Vercel/Render)
const app = express();
app.use(express.json());

app.get('/', async (req, res) => {
  const active = await getActiveFolder();
  const folders = await getFoldersList();
  res.send(`
    <html>
      <head><title>Vault Bot Server</title></head>
      <body style="font-family:sans-serif; background:#0f172a; color:#f8fafc; padding:2rem; text-align:center;">
        <h1>🗄️ Telegram Vault Storage Bot</h1>
        <p style="color:#10b981;">✅ Bot is running and healthy on Vercel!</p>
        <p>Active Target Folder: <b>${active}</b></p>
        <p>Known Folders: <b>${folders.join(', ')}</b></p>
        <p>Total Files in DB: <b>${catalog.files.length}</b></p>
      </body>
    </html>
  `);
});

app.get('/health', async (req, res) => {
  const active = await getActiveFolder();
  const folders = await getFoldersList();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    activeFolder: active,
    folders: folders,
    totalFiles: catalog.files.length,
    timestamp: new Date().toISOString()
  });
});

// Telegram Webhook Handler (untuk Vercel Serverless)
app.post('/api/webhook', async (req, res) => {
  try {
    if (catalog.files.length === 0) {
      await loadCatalogFromTelegram();
    }
    await bot.handleUpdate(req.body, res);
    if (!res.headersSent) res.status(200).send('OK');
  } catch (err) {
    console.error('[Webhook Error]:', err.message);
    if (!res.headersSent) res.status(500).send('Error');
  }
});

// Auto-Register Webhook Helper
app.get('/api/setup-webhook', async (req, res) => {
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const webhookUrl = `${proto}://${host}/api/webhook`;
    await bot.telegram.setWebhook(webhookUrl);
    res.send(`✅ Webhook berhasil dipasang ke: <b>${webhookUrl}</b>! Bot Telegram sekarang terhubung ke Vercel!`);
  } catch (err) {
    res.status(500).send(`❌ Gagal set webhook: ${err.message}`);
  }
});

// Middleware: Owner Authentication & Auto-Pairing
bot.use(async (ctx, next) => {
  const fromId = ctx.from ? String(ctx.from.id) : null;
  if (!fromId) return next();

  if (ctx.chat?.type === 'channel') return next();

  if (!runtimeConfig.ownerChatId) {
    runtimeConfig.ownerChatId = fromId;
    saveConfig();
    console.log(`[Auto-Pair] Bot otomatis dikunci untuk Telegram ID: ${fromId} (${ctx.from.first_name || ''})`);
  }

  if (fromId === runtimeConfig.ownerChatId) {
    return next();
  }

  if (channelId) {
    try {
      const member = await bot.telegram.getChatMember(channelId, fromId);
      if (['creator', 'administrator', 'member'].includes(member.status)) {
        return next();
      }
    } catch (e) {}
  }

  if (ctx.chat?.type === 'private') {
    await ctx.reply(
      '⛔ <b>Akses Ditolak</b>\n\nBot ini adalah brankas penyimpanan pribadi yang dilindungi. Hanya pemilik bot dan anggota channel yang dapat menggunakan layanan ini.',
      { parse_mode: 'HTML' }
    );
  }
  return;
});

// 1. /start Command (Supports Deep-Link: /start bundle_<folderName>)
bot.command('start', async (ctx) => {
  const parts = ctx.message.text.split(' ');
  const payload = parts[1];

  if (payload && payload.startsWith('bundle_')) {
    const folderName = decodeURIComponent(payload.replace('bundle_', ''));
    return sendFolderBundle(ctx, folderName);
  }

  const name = ctx.from.first_name || 'Teman';
  const activeFolder = await getActiveFolder();
  const foldersList = await getFoldersList();

  const welcomeText = 
`👋 <b>Halo, ${name}! Selamat datang di Brankas Pribadi Telegram kamu!</b>

🗄️ <b>Status Brankas:</b>
• <b>Target Upload Aktif:</b> 📂 <code>${activeFolder}</code>
• <b>Total Folder:</b> ${foldersList.length} folder
• <b>Total File Terkatalog:</b> ${catalog.files.length} file
• <b>Kapasitas:</b> ♾️ Unlimited Telegram Cloud

<b>Cara Penggunaan:</b>
1. Kirim <b>Foto, Video, Lagu, atau Dokumen</b> apa saja ke chat ini, file langsung otomatis masuk ke Channel Private kamu di folder <code>${activeFolder}</code>!
2. Ketik nama folder (contoh: <code>Kansha</code>) atau gunakan tombol <b>📦 Ambil Bundle</b> untuk mengumpulkan semua file dalam 1 pesan album!
3. Gunakan tombol di bawah atau ketik <code>/mkdir &lt;nama&gt;</code> untuk membuat folder baru.`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📦 Kumpulkan & Ambil Bundle Folder', 'menu_pick_bundle')],
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
  const foldersList = await getFoldersList();
  const currentActive = await getActiveFolder();
  let text = `📂 <b>DAFTAR FOLDER PENYIMPANAN</b>\n\n`;

  foldersList.forEach((folderName, i) => {
    const isActive = folderName.toLowerCase() === currentActive.toLowerCase();
    text += `${i + 1}. ${isActive ? '🟢 <b>[AKTIF]</b> ' : '📁 '}<b>${folderName}</b>\n`;
    text += `   • Tag: <code>${toFolderTag(folderName)}</code>\n\n`;
  });

  text += `<i>Klik tombol di bawah untuk memilih target upload atau mengambil bundle file:</i>`;

  const buttons = foldersList.map(folderName => {
    const isActive = folderName.toLowerCase() === currentActive.toLowerCase();
    return [
      Markup.button.callback(`${isActive ? '🟢 Target: ' : '🎯 Pilih: '}${folderName}`, `set_active_${encodeURIComponent(folderName)}`),
      Markup.button.callback(`📦 Ambil File`, `bundle_view_${encodeURIComponent(folderName)}`)
    ];
  });

  buttons.push([Markup.button.callback('➕ Buat Folder Baru', 'prompt_mkdir')]);

  const keyboard = Markup.inlineKeyboard(buttons);

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
    } catch (e) {
      await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
    }
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

  await saveFolderToChannel(folderName);
  await sendAndPinDivider(folderName, true);
  syncCatalogToTelegram().catch(() => {});

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

  const foldersList = await getFoldersList();
  const found = foldersList.find(f => f.toLowerCase() === folderName.toLowerCase());
  const targetFolder = found || folderName;

  await saveFolderToChannel(targetFolder);
  await sendAndPinDivider(targetFolder, false);

  await ctx.reply(`🎯 <b>Target Upload Diubah!</b>\nSemua file berikutnya akan masuk ke: <b>${targetFolder}</b>`, { parse_mode: 'HTML' });
});

// 5. /bundle or /cari or /get Command
bot.command(['bundle', 'folder', 'get', 'cari', 'search'], async (ctx) => {
  const parts = ctx.message.text.split(' ').slice(1);
  const query = parts.join(' ').trim();

  if (!query) {
    return showBundlePickerMenu(ctx);
  }

  const folders = await getFoldersList();
  const matched = folders.find(f => f.toLowerCase() === query.toLowerCase());
  if (matched) {
    return sendFolderBundle(ctx, matched);
  }

  const partials = folders.filter(f => f.toLowerCase().includes(query.toLowerCase()));
  if (partials.length === 1) {
    return sendFolderBundle(ctx, partials[0]);
  } else if (partials.length > 1) {
    const buttons = partials.map(p => [Markup.button.callback(`📦 Ambil Bundle: ${p}`, `bundle_view_${encodeURIComponent(p)}`)]);
    return ctx.reply(
      `🔍 Ditemukan <b>${partials.length} folder</b> cocok dengan "<b>${escapeHtml(query)}</b>":`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }
    );
  }

  return ctx.reply(`❌ Folder "<b>${escapeHtml(query)}</b>" tidak ditemukan.\nKetik <code>/folders</code> untuk melihat semua folder.`, { parse_mode: 'HTML' });
});

// Actions / Callbacks
bot.action('menu_folders', async (ctx) => {
  await ctx.answerCbQuery();
  await showFoldersMenu(ctx);
});

bot.action('menu_pick_bundle', async (ctx) => {
  await ctx.answerCbQuery();
  await showBundlePickerMenu(ctx);
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
    `• <b>Ketik Nama Folder (cth: <code>Kansha</code>):</b> Bot langsung mengumpulkan semua file folder tersebut dalam 1 pesan album!\n` +
    `• <code>/bundle &lt;nama&gt;</code> : Ambil bundle semua file dalam folder.\n` +
    `• <code>/folders</code> : Lihat semua folder dan statistik file.\n` +
    `• <code>/mkdir &lt;nama&gt;</code> : Buat folder baru & langsung aktif.\n` +
    `• <code>/use &lt;nama&gt;</code> : Ganti tujuan folder aktif.\n` +
    `• <code>/start</code> : Menu utama bot.`,
    { parse_mode: 'HTML' }
  );
});

bot.action(/^set_active_(.+)$/, async (ctx) => {
  const folderName = decodeURIComponent(ctx.match[1]);
  await sendAndPinDivider(folderName, false);
  await ctx.answerCbQuery(`Folder aktif: ${folderName}`);
  await showFoldersMenu(ctx);
});

bot.action(/^bundle_view_(.+)$/, async (ctx) => {
  const folderName = decodeURIComponent(ctx.match[1]);
  await ctx.answerCbQuery(`Memuat bundle ${folderName}...`);
  await sendFolderBundle(ctx, folderName);
});

bot.action(/^bundle_send_album_(.+)$/, async (ctx) => {
  const folderName = decodeURIComponent(ctx.match[1]);
  await ctx.answerCbQuery(`Mengirim album ${folderName}...`);
  await sendFolderBundle(ctx, folderName);
});

// Text message handler (Natural Search / Typing Folder Name Directly)
bot.on('text', async (ctx, next) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return next();

  const folders = await getFoldersList();
  const matched = folders.find(f => f.toLowerCase() === text.toLowerCase());
  if (matched) {
    return sendFolderBundle(ctx, matched);
  }

  const partials = folders.filter(f => f.toLowerCase().includes(text.toLowerCase()));
  if (partials.length === 1) {
    return sendFolderBundle(ctx, partials[0]);
  } else if (partials.length > 1) {
    const buttons = partials.map(p => [Markup.button.callback(`📦 Ambil Bundle: ${p}`, `bundle_view_${encodeURIComponent(p)}`)]);
    return ctx.reply(
      `🔍 Ditemukan <b>${partials.length} folder</b> dengan kata kunci "<b>${escapeHtml(text)}</b>":\nSilakan pilih folder:`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }
    );
  }

  return next();
});

// ==========================================
// MEDIA UPLOAD HANDLER
// (Photos, Videos, Documents, Audio, Voice)
// ==========================================
bot.on(['photo', 'video', 'document', 'audio', 'voice'], async (ctx) => {
  if (!channelId) {
    return ctx.reply('⚠️ STORAGE_CHANNEL_ID belum dikonfigurasi di file .env.');
  }

  // Read active folder directly from Telegram channel pinned divider!
  const folderName = await getActiveFolder();
  const folderTag = toFolderTag(folderName);

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

    // Update catalog with fileId for instant media group bundling
    const entry = {
      id: `file_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      name: fileName,
      type: fileType,
      fileId: fileId,
      sizeBytes: sizeBytes,
      sizeFormatted: formatBytes(sizeBytes),
      date: new Date().toISOString(),
      channelMessageId: forwarded.message_id,
      folder: folderName,
      folderTag: folderTag
    };

    catalog.files.unshift(entry);
    if (!catalog.folders[folderName]) {
      catalog.folders[folderName] = {
        name: folderName,
        tag: folderTag,
        createdAt: new Date().toISOString(),
        fileCount: 1,
        totalBytes: sizeBytes,
        dividerSent: true
      };
    } else {
      catalog.folders[folderName].fileCount = (catalog.folders[folderName].fileCount || 0) + 1;
      catalog.folders[folderName].totalBytes = (catalog.folders[folderName].totalBytes || 0) + sizeBytes;
    }
    saveCatalog();

    // Sync state to Telegram cloud in background
    syncCatalogToTelegram().catch(() => {});

    // Confirm to user in private chat with instant bundle shortcut
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(`📦 Lihat Bundle [ ${folderName} ]`, `bundle_view_${encodeURIComponent(folderName)}`)]
    ]);

    await ctx.reply(
      `✅ <b>Berhasil Disimpan!</b>\n\n` +
      `📁 <b>Folder:</b> <code>${folderName}</code>\n` +
      `📦 <b>Ukuran:</b> ${formatBytes(sizeBytes)}\n` +
      `🔗 <b>Tag di Channel:</b> ${folderTag}\n\n` +
      `<i>File kamu sudah aman di Telegram Private Vault.</i>`,
      {
        parse_mode: 'HTML',
        reply_to_message_id: ctx.message.message_id,
        ...keyboard
      }
    );
  } catch (err) {
    console.error('[Upload Error]:', err.message);
    await ctx.reply(`❌ Gagal menyimpan file ke channel: ${err.message}`);
  }
});

// Launch Telegraf Bot (Local / Container Long-Polling)
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`[Web Server] Running on port ${PORT}`);
  });

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
} else {
  console.log(`⚡ Telegram Vault Bot running in Vercel Serverless Webhook mode!`);
}

export default app;
