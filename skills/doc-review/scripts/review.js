'use strict';
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const candidates = [
  path.join(__dirname, 'runtime', 'server', 'client.js'),
  path.resolve(__dirname, '..', '..', '..', 'server', 'client.js'),
];
const client = candidates.find(p => fs.existsSync(p));
if (!client) throw new Error('Run install.cmd from the complete Doc Review package.');
const result = spawnSync(process.execPath, [client, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
