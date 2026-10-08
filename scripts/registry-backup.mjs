import { spawn } from 'node:child_process';
import { lstat, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const checkoutRoot = path.resolve(scriptDirectory, '..');
const workspaceRoot = path.dirname(checkoutRoot);
const serviceCheckouts = [
  'j-auth',
  'j-groupware',
  'j-messenger',
  'j-mail',
  'j-customer-auth-db',
  'j-approval',
  'j-talk',
  'j-web',
].map((name) => path.join(workspaceRoot, name));
const defaultRuntimeRoot = path.resolve(path.dirname(checkoutRoot), '.suite-runtime', 'verdaccio');

function usage() {
  return 'Usage: node scripts/registry-backup.mjs --output <archive.tar.gz> [--storage <runtime/storage>] [--auth <runtime/htpasswd>]';
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help' || key === '-h') {
      options.help = true;
      continue;
    }
    if (!['--output', '--storage', '--auth'].includes(key)) {
      throw new Error('Unknown option. ' + usage());
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error('Missing option value. ' + usage());
    }
    if (options[key.slice(2)] !== undefined) {
      throw new Error('Option provided more than once. ' + usage());
    }
    options[key.slice(2)] = value;
    index += 1;
  }
  return options;
}

function canonicalForComparison(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isWithin(parent, candidate) {
  const relative = path.relative(canonicalForComparison(parent), canonicalForComparison(candidate));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

async function assertNoSymlinkComponents(target, label) {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  let current = root;
  const components = path.relative(root, resolved).split(path.sep).filter(Boolean);
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    let entry;
    try {
      entry = await lstat(current);
    } catch {
      throw new Error(label + ' path does not exist or cannot be inspected.');
    }
    if (entry.isSymbolicLink()) throw new Error(label + ' path contains a symlink or junction.');
    if (index < components.length - 1 && !entry.isDirectory()) {
      throw new Error(label + ' path has a non-directory parent component.');
    }
  }
}

function isInsideAnyCheckout(candidate) {
  return serviceCheckouts.some((root) => isWithin(root, candidate));
}

async function findTar() {
  const names = process.platform === 'win32' ? ['tar.exe', 'tar'] : ['tar'];
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      try {
        const file = await stat(candidate);
        if (file.isFile()) return candidate;
      } catch {
        // Continue searching without printing PATH entries.
      }
    }
  }
  throw new Error('The system tar utility is required to create the backup archive.');
}

async function runTar(executable, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.once('error', () => reject(new Error('Could not start the archive utility.')));
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('The archive utility failed with exit code ' + String(code) + '.'));
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage() + '\n');
    return;
  }
  if (!options.output) throw new Error(usage());

  const storagePath = path.resolve(options.storage || path.join(defaultRuntimeRoot, 'storage'));
  const authPath = path.resolve(options.auth || path.join(defaultRuntimeRoot, 'htpasswd'));
  const runtimeRoot = path.dirname(storagePath);
  const outputPath = path.resolve(options.output);

  if (path.basename(storagePath) !== 'storage' || path.basename(authPath) !== 'htpasswd' || path.dirname(authPath) !== runtimeRoot) {
    throw new Error('Storage and auth must be the runtime storage directory and htpasswd file under the same directory.');
  }
  if (isInsideAnyCheckout(outputPath)) {
    throw new Error('Backup archive must be written outside all service repository checkouts.');
  }
  if (isWithin(runtimeRoot, outputPath)) {
    throw new Error('Backup archive must be outside the registry runtime directory.');
  }

  let storageStat;
  let authStat;
  let outputParentStat;
  try {
    await assertNoSymlinkComponents(runtimeRoot, 'Registry runtime');
    await assertNoSymlinkComponents(path.dirname(outputPath), 'Backup archive parent');
    storageStat = await lstat(storagePath);
    authStat = await lstat(authPath);
    outputParentStat = await lstat(path.dirname(outputPath));
  } catch {
    throw new Error('Storage, htpasswd, and the output directory must already exist.');
  }
  if (!storageStat.isDirectory() || storageStat.isSymbolicLink()) {
    throw new Error('Registry storage must be a real directory, not a symlink.');
  }
  if (!authStat.isFile() || authStat.isSymbolicLink()) {
    throw new Error('Registry htpasswd must be a real file, not a symlink.');
  }
  if (!outputParentStat.isDirectory() || outputParentStat.isSymbolicLink()) {
    throw new Error('The archive parent must be an existing real directory, not a symlink.');
  }
  if (isInsideAnyCheckout(outputPath) || isWithin(runtimeRoot, outputPath)) {
    throw new Error('Resolved backup archive path must remain outside all checkouts and the registry runtime.');
  }
  try {
    await lstat(outputPath);
    throw new Error('Backup archive already exists; choose a new filename.');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Backup archive already exists')) throw error;
    if (!error || error.code !== 'ENOENT') throw new Error('Could not safely inspect the backup destination.');
  }

  const tar = await findTar();
  await runTar(tar, ['-czf', outputPath, '-C', runtimeRoot, 'storage', 'htpasswd']);
  const archiveStat = await stat(outputPath);
  if (!archiveStat.isFile() || archiveStat.size === 0) {
    throw new Error('The backup archive was not created correctly.');
  }

  process.stdout.write('Created backup archive: ' + outputPath + '\n');
  process.stdout.write('This archive contains private package contents and password hashes. Store it with restricted access; the archive is not encrypted.\n');
}

main().catch((error) => {
  process.stderr.write((error instanceof Error ? error.message : 'Registry backup failed.') + '\n');
  process.exitCode = 1;
});
