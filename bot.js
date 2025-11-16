const fs = require('fs-extra');
const axios = require('axios');
const cheerio = require('cheerio');
const TelegramBot = require('node-telegram-bot-api');

// ============ CONFIG ============
const BOT_TOKEN = process.env.BOT_TOKEN;
const SOURCE_CHANNEL = parseInt(process.env.SOURCE_CHANNEL);
const ALERT_CHANNEL = parseInt(process.env.ALERT_CHANNEL);
const WALLET_FILE = './wallets.json';
const CHAINS_FILE = './chains.json';

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// Load wallets
let wallets = fs.existsSync(WALLET_FILE) ? fs.readJsonSync(WALLET_FILE) : [];
wallets = wallets.map(w => ({ address: w.address || w, lastTx: w.lastTx || {} }));

// Load chains
let chains = fs.existsSync(CHAINS_FILE) ? fs.readJsonSync(CHAINS_FILE) : [];

// ============ HELPERS ============
function saveWallets() {
    fs.writeJsonSync(WALLET_FILE, wallets, { spaces: 2 });
}

function extractAddress(text) {
    const match = text.match(/0x[a-fA-F0-9]{40}/);
    return match ? match[0] : null;
}

async function getTxCount(wallet, chain) {
    try {
        const { data } = await axios.get(chain.explorer + wallet);
        const $ = cheerio.load(data);
        const txText = $(chain.selector).text();
        return parseInt(txText.replace(/[^0-9]/g, '') || 0);
    } catch (e) {
        console.error(`Error fetching ${chain.name} tx count for ${wallet}:`, e.message);
        return 0;
    }
}

async function checkWallet(walletObj) {
    let txs = {};
    for (let chain of chains) {
        txs[chain.name] = await getTxCount(walletObj.address, chain);
    }
    return txs;
}

async function sendAlert(wallet, txs, delta) {
    let msg = `🧠 Transaction Alert Found!\n🧾 Address: ${wallet}\n`;
    for (let chain of chains) {
        msg += `📊 ${chain.name}: ${txs[chain.name]} tx ${delta[chain.name] > 0 ? `(+${delta[chain.name]})` : ''}\n`;
    }
    msg += "🔗 Explorers\n";
    for (let chain of chains) {
        msg += `${chain.name}: ${chain.explorer}${wallet}\n`;
    }
    await bot.sendMessage(ALERT_CHANNEL, msg);
}

// ============ FETCH NEW WALLETS ============
async function fetchSourceMessages() {
    try {
        const updates = await bot.getUpdates(0, 100, 0);
        for (let u of updates) {
            if (u.message?.chat.id === SOURCE_CHANNEL) {
                const walletAddr = extractAddress(u.message.text);
                if (walletAddr && !wallets.some(w => w.address === walletAddr)) {
                    wallets.push({ address: walletAddr, lastTx: {} });
                    saveWallets();
                    console.log('Saved new wallet:', walletAddr);
                }
            }
        }
    } catch (e) {
        console.error('Error fetching source messages:', e.message);
    }
}

// ============ MAIN ============
(async () => {
    await fetchSourceMessages();

    for (let w of wallets) {
        const txs = await checkWallet(w);
        const delta = {};
        for (let chain of chains) {
            const last = w.lastTx[chain.name] || 0;
            delta[chain.name] = txs[chain.name] - last;
        }

        const hasNewTx = Object.values(delta).some(v => v > 0);
        if (hasNewTx) {
            await sendAlert(w.address, txs, delta);
            w.lastTx = txs;
            saveWallets();
        }
    }

    console.log('GitHub Action run finished ✅');
})();
