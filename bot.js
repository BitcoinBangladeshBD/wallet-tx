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
const CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes

// ============ INIT BOT ============
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Load wallets
let wallets = fs.existsSync(WALLET_FILE) ? fs.readJsonSync(WALLET_FILE) : [];
wallets = wallets.map(w => ({ address: w.address || w, lastTx: w.lastTx || {} }));

// Load chains
let chains = fs.existsSync(CHAINS_FILE) ? fs.readJsonSync(CHAINS_FILE) : [
    { name: "Ethereum", explorer: "https://etherscan.io/address/", selector: ".u-label" },
    { name: "BSC", explorer: "https://bscscan.com/address/", selector: ".u-label" },
    { name: "Polygon", explorer: "https://polygonscan.com/address/", selector: ".u-label" },
    { name: "Base", explorer: "https://basescan.org/address/", selector: ".u-label" }
];

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
        const txText = $(chain.selector).first().text();
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

// ============ REAL-TIME WALLET DETECTION ============
bot.on('message', async (msg) => {
    if (msg.chat.id === SOURCE_CHANNEL) {
        const walletAddr = extractAddress(msg.text);
        if (walletAddr && !wallets.some(w => w.address === walletAddr)) {
            wallets.push({ address: walletAddr, lastTx: {} });
            saveWallets();
            console.log('Saved new wallet:', walletAddr);

            // Immediately check transactions
            const txs = await checkWallet({ address: walletAddr, lastTx: {} });
            const delta = {};
            for (let chain of chains) {
                delta[chain.name] = txs[chain.name];
            }
            const hasNewTx = Object.values(delta).some(v => v > 0);
            if (hasNewTx) {
                await sendAlert(walletAddr, txs, delta);
                wallets.find(w => w.address === walletAddr).lastTx = txs;
                saveWallets();
            }
        }
    }
});

// ============ PERIODIC CHECK FOR EXISTING WALLETS ============
setInterval(async () => {
    console.log("Checking all wallets...");
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
    console.log('Periodic check finished ✅');
}, CHECK_INTERVAL);

console.log("Bot started ✅ Listening to source channel...");
