// Connects your Telegram bot: finds your chat id and sends a test message.  Usage: npm run telegram:setup
//   1. Create a bot with @BotFather in Telegram and put its token in .env as TELEGRAM_BOT_TOKEN
//   2. Open the bot in Telegram and press Start (or send it any message)
//   3. Run this: it waits up to 2 minutes for your message, prints the TELEGRAM_CHAT_ID line to add to .env and sends a test message
import 'dotenv/config';
import { requestJson } from '../src/lib/http.js';
import { sendTelegram } from '../src/services/telegram.js';

const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const WAIT_SECONDS = 120;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const api = (method) => requestJson({ service: 'Telegram', url: `https://api.telegram.org/bot${token}/${method}`, hint401: '(¿TELEGRAM_BOT_TOKEN correcto?)' });

try {
  if (!token) throw new Error('Falta TELEGRAM_BOT_TOKEN en tu .env: créalo hablando con @BotFather en Telegram (/newbot).');
  const { result: bot } = await api('getMe');
  console.log(`Bot conectado: @${bot.username}`);

  let chatId = (process.env.TELEGRAM_CHAT_ID || '').trim();
  if (!chatId) {
    // Telegram only lets a bot write to you after you wrote to it: wait for that message (long polling returns as soon as it arrives)
    console.log(`Ahora abre @${bot.username} en Telegram y pulsa Start (o escríbele "hola"). Espero hasta ${WAIT_SECONDS} segundos...`);
    const chats = new Map();
    for (const deadline = Date.now() + WAIT_SECONDS * 1000; !chats.size && Date.now() < deadline;) {
      const { result: updates } = await api('getUpdates?timeout=20');
      for (const c of updates.map(u => u.message?.chat).filter(Boolean)) chats.set(c.id, c);
      if (!updates.length) await sleep(500);
    }
    if (!chats.size) throw new Error(`No me ha llegado ningún mensaje a @${bot.username}. Comprueba que abres ESE bot (no BotFather), pulsa Start y vuelve a ejecutar esto.`);
    for (const c of chats.values()) console.log(`  chat ${c.id} — ${[c.first_name, c.last_name].filter(Boolean).join(' ') || c.title || ''}${c.username ? ` (@${c.username})` : ''}`);
    if (chats.size > 1) throw new Error('Hay varios chats: copia en tu .env la línea TELEGRAM_CHAT_ID=<número> del tuyo y vuelve a ejecutar esto.');
    chatId = String([...chats.keys()][0]);
    console.log(`\nAñade esta línea a tu .env:\nTELEGRAM_CHAT_ID=${chatId}\n`);
  }

  const r = await sendTelegram('✅ Telegram conectado: aquí recibirás los avisos de Web Creator 360.', { env: { ...process.env, TELEGRAM_CHAT_ID: chatId }, dryRun: false });
  if (!r.ok) throw new Error(`No se pudo enviar el mensaje de prueba: ${r.error || 'revisa el token y el chat'}`);
  console.log('Mensaje de prueba enviado: míralo en Telegram.');
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
