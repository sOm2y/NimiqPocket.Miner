// https://stackoverflow.com/questions/17554688/has-anyone-tried-using-the-uv-threadpool-size-environment-variable
const os = require('os');
const ip = require('ip');
const maxThreads = os.cpus().length;
process.env.UV_THREADPOOL_SIZE = maxThreads;

const Nimiq = require('@nimiq/core');
const argv = require('minimist')(process.argv.slice(2));
const readFromFile = require('./src/Config.js');
const NimiqPocketMiner = require('./src/NimiqPocketMiner.js');
let Finder = require('./src/ServerFinder.js');
const ServerFinder = new Finder();
const readlineSync = require('readline-sync');
var fs = require('fs');
const pjson = require('./package.json');

const START = Date.now();
const TAG = 'Nimiqpocket';
const $ = {};
const defaultConfigFile = 'config.txt';

const servers = [
    'hk1a.nimiqpocket.cn'
];
const poolPort = 1023;

Nimiq.Log.instance.level = 'info';

if (argv.hasOwnProperty('address')) {
    Nimiq.Log.i(TAG, 'Reading config from argv');
    const askAddress = argv['address'];
    const askNumThreads = argv.hasOwnProperty('threads') ? argv['threads'] : maxThreads;
    const askName = argv.hasOwnProperty('name') ? argv['name'] : '';
    const ask = {
        address: askAddress,
        threads: askNumThreads,
        name: askName
    };
    const data = JSON.stringify(ask, null, 4);
    fs.writeFileSync(defaultConfigFile, data);
    config = readFromFile(defaultConfigFile);
} else {
    Nimiq.Log.i(TAG, `Trying ${defaultConfigFile}`);
    config = readFromFile(defaultConfigFile);
    if (!config) {
        Nimiq.Log.i(TAG, 'No configuration file found. Please answer the following questions:');
        const askAddress = readlineSync.question('Enter Nimiq Wallet Address (e.g. NQXX .... ....): ', {
            limit: function (input) {
                try {
                    Nimiq.Address.fromUserFriendlyAddress(input);
                } catch (err) {
                    return false
                }
                return true;
            },
            limitMessage: '$<lastInput> is not a valid Nimiq Wallet Address'
        });
        const askName = argv.hasOwnProperty('name') ? argv['name'] : readlineSync.question(`Enter a name for this miner (press Enter to use ${os.hostname}): `);
        const query = `Enter the number of threads to use for mining (max ${maxThreads}): `;
        const askNumThreads = argv.hasOwnProperty('threads') ? argv['threads'] : readlineSync.questionInt(query);
        const ask = {
            address: askAddress,
            threads: askNumThreads,
            name: askName
        };
        const data = JSON.stringify(ask, null, 4);
        fs.writeFileSync(defaultConfigFile, data);
        config = readFromFile(defaultConfigFile);
    }
}



config = Object.assign(config, argv);
config.poolMining.enabled = true;
config.poolMining.port = poolPort;
config.miner.enabled = true;

if (argv.hasOwnProperty('test')){
    Nimiq.Log.w('----- YOU ARE CONNECTING TO TESTNET -----');
    config.network = 'test';
} else {
    config.network = 'main';
}

if(config.hasOwnProperty('threads')){
    config.miner.threads = config.threads;
    delete config.threads;
}
if (typeof config.miner.threads !== 'number' && config.miner.threads !== 'auto') {
    Nimiq.Log.e(TAG, 'Specify a valid thread number');
    process.exit(1);
}

function humanHashes(bytes) {
    let thresh = 1000;
    if(Math.abs(bytes) < thresh) {
        return bytes + ' H/s';
    }
    let units = ['kH/s','MH/s','GH/s','TH/s','PH/s','EH/s','ZH/s','YH/s'];
    let u = -1;
    do {
        bytes /= thresh;
        ++u;
    } while(Math.abs(bytes) >= thresh && u < units.length - 1);
    return bytes.toFixed(1)+' '+units[u];
}
(async () => {
    //fs.writeFileSync(defaultConfigFile, data);
    let currentServerIndex = 0;

    Nimiq.Log.i(TAG, `Finding closest server.`);
    const serversSorted = await ServerFinder.findClosestServers(servers, config.poolMining.port);
    const closestServer = serversSorted[0];
    if(!config.server) {
        config.server = closestServer.host;
        Nimiq.Log.i(TAG, `Closest server: 香港`);
    }
    config.poolMining.host = config.server;

    let deviceName = config.name || '*';
    if (deviceName === '*') {
        deviceName = [ip.address(), os.platform(), os.arch(), os.release()].join(' ');
        Nimiq.Log.i(`自动设置矿机名称为 ${deviceName}`)
    }
    Nimiq.Log.i(TAG, `口袋矿工 ${pjson.version} 开始启动`);
    // Nimiq.Log.i(TAG, `- 网络          = ${config.network}`);
    Nimiq.Log.i(TAG, `- 线程数   = ${config.miner.threads}`);
    // Nimiq.Log.i(TAG, `- pool server      = ${config.poolMining.host}`);
    Nimiq.Log.i(TAG, `- 钱包地址 = ${config.address}`);
    Nimiq.Log.i(TAG, `- 矿机名称 = ${deviceName}`);
    Nimiq.Log.i(TAG, `请等待共识建立.`);

    Nimiq.GenesisConfig.init(Nimiq.GenesisConfig.CONFIGS[config.network]);
    Nimiq.GenesisConfig.SEED_PEERS.push(Nimiq.WssPeerAddress.seed('jp.nimiqpocket.com', 8448));
    const networkConfig = new Nimiq.DumbNetworkConfig();
    $.consensus = await Nimiq.Consensus.light(networkConfig);
    $.blockchain = $.consensus.blockchain;
    $.accounts = $.blockchain.accounts;
    $.mempool = $.consensus.mempool;
    $.network = $.consensus.network;

    $.walletStore = await new Nimiq.WalletStore();
    if (!config.address) {
        // Load or create default wallet.
        $.wallet = await $.walletStore.getDefault();
    } else {
        const address = Nimiq.Address.fromUserFriendlyAddress(config.address);
        $.wallet = {address: address};
        // Check if we have a full wallet in store.
        const wallet = await $.walletStore.get(address);
        if (wallet) {
            $.wallet = wallet;
            await $.walletStore.setDefault(wallet.address);
        }
    }

    const account = await $.accounts.get($.wallet.address);
    Nimiq.Log.i(TAG, `钱包初始化成功 ${$.wallet.address.toUserFriendlyAddress()}.`
        + ` 钱包金额: ${Nimiq.Policy.satoshisToCoins(account.balance)} NIM`);
    Nimiq.Log.i(TAG, `区块链状态: 高度=${$.blockchain.height}, headHash=${$.blockchain.headHash}`);

    // connect to pool
    const deviceId = Nimiq.BasePoolMiner.generateDeviceId(networkConfig);
    const startDifficulty = config.startDifficulty || 1;
    $.miner = new NimiqPocketMiner('smart', $.blockchain, $.accounts, $.mempool, $.network.time, $.wallet.address, deviceId, deviceName, startDifficulty);

    $.consensus.on('established', () => {
        Nimiq.Log.i(TAG, `已连接至口袋矿池 香港节点 使用 ${deviceName}  作为矿机.`);
        $.miner.connect(config.poolMining.host, config.poolMining.port);
    });

    $.miner.on('pool-disconnected', function () {
        let nextServerIndex = currentServerIndex+1;
        if(!serversSorted[nextServerIndex]){
            nextServerIndex = 0;
        }
        let nextServer = serversSorted[nextServerIndex];
        if(nextServer) {
            Nimiq.Log.w(TAG, `失去矿池连接 ${config.poolMining.host}, 切换至 ${nextServer.host}`);
            config.poolMining.host = nextServer.host;
            $.miner.changeServer(config.poolMining.host, config.poolMining.port);
            currentServerIndex = nextServerIndex;
        }
    });

    $.blockchain.on('head-changed', (head) => {
        if ($.consensus.established || head.height % 100 === 0) {
            Nimiq.Log.i(TAG, `当前区块高度: ${head.height}`);
        }
    });

    $.network.on('peer-joined', (peer) => {
        Nimiq.Log.i(TAG, `Connected to ${peer.peerAddress.toString()}`);
    });

    $.network.on('peer-left', (peer) => {
        Nimiq.Log.i(TAG, `Disconnected from ${peer.peerAddress.toString()}`);
    });

    $.network.connect();
    $.consensus.on('established', () => $.miner.startWork());
    $.consensus.on('lost', () => $.miner.stopWork());
    if (typeof config.miner.threads === 'number') {
        $.miner.threads = config.miner.threads;
    }

    $.consensus.on('established', () => {
        Nimiq.Log.i(TAG, `区块链共识建立完成，用时 ${(Date.now() - START) / 1000}s.`);
        Nimiq.Log.i(TAG, `当前状态: 高度=${$.blockchain.height}, totalWork=${$.blockchain.totalWork}, headHash=${$.blockchain.headHash}`);
    });

    $.miner.on('block-mined', (block) => {
        Nimiq.Log.i(TAG, `挖到区块: #${block.header.height}, hash=${block.header.hash()}`);
    });

    
    // Output regular statistics
    const hashrates = [];
    const outputInterval = 5;
    $.miner.on('hashrate-changed', async (hashrate) => {
        hashrates.push(hashrate);

        if (hashrates.length >= outputInterval) {
            const account = await $.accounts.get($.wallet.address);
            const sum = hashrates.reduce((acc, val) => acc + val, 0);
            Nimiq.Log.i(TAG, `Hashrate: ${humanHashes((sum / hashrates.length).toFixed(2).padStart(7))}`
                + ` - 钱包金额: ${Nimiq.Policy.satoshisToCoins(account.balance)} NIM`
                + ` - Mempool: ${$.mempool.getTransactions().length} tx`);
            hashrates.length = 0;
        }
    });

})().catch(e => {
    console.error(e);
    process.exit(1);
});

