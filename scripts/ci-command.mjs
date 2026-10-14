// Keep full output as an artifact and expose failures through GitHub check annotations.
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';

const [name, command, ...args] = process.argv.slice(2);
if (!name || !command || !/^[a-z-]+$/.test(name)) throw new Error('Usage: ci-command.mjs <log-name> <command> [...args]');
mkdirSync('test-results', { recursive: true });
const log = createWriteStream(path.join('test-results', `${name}.log`));
let tail = '';
const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
  process.stdout.write(data);
  log.write(data);
  tail = (tail + data.toString()).slice(-12000);
});
child.on('error', error => { tail += error.message; });
child.on('close', code => {
  log.end();
  if (code !== 0) {
    const message = tail.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    console.error(`::error title=${name} failed::${message}`);
  }
  process.exitCode = code ?? 1;
});
