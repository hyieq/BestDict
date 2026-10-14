// Keep full output as an artifact and expose failures through GitHub check annotations.
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';

const [name, command, ...args] = process.argv.slice(2);
if (!name || !command || !/^[a-z-]+$/.test(name)) throw new Error('Usage: ci-command.mjs <log-name> <command> [...args]');
mkdirSync('test-results', { recursive: true });
const log = createWriteStream(path.join('test-results', `${name}.log`));
let tail = '';
const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
const timer = setTimeout(() => {
  const message = `Command exceeded ${process.env.BESTDICT_CI_TIMEOUT_MS || 900000} ms; terminating its process group.\n`;
  tail += message;
  log.write(message);
  console.error(message);
  try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch {}
}, Number(process.env.BESTDICT_CI_TIMEOUT_MS || 900000));
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
  process.stdout.write(data);
  log.write(data);
  tail = (tail + data.toString()).slice(-12000);
});
child.on('error', error => { tail += error.message; });
child.on('close', code => {
  clearTimeout(timer);
  log.end();
  if (code !== 0) {
    // GitHub truncates annotation messages. Preserve actual TAP failures instead
    // of filling the visible annotation with earlier successful test output.
    const failures = tail.match(/(?:^|\n)not ok[^\n]*[\s\S]*?(?=\n(?:# Subtest:|ok \d|not ok \d|1\.\.)|$)/g);
    const details = (failures?.length ? failures.join('\n') : tail.slice(-3500)).slice(0, 3500);
    const message = details.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    console.error(`::error title=${name} failed::${message}`);
  }
  process.exitCode = code ?? 1;
});
