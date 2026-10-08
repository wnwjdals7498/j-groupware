import { spawn } from 'node:child_process';
import { access, readFile, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';

const ALLOWED_SCOPES = new Set([
  '@j-auth',
  '@j-groupware',
  '@j-messenger',
  '@j-customer-auth-db',
  '@j-mail',
  '@j-approval',
  '@j-talk',
  '@j-web',
]);

const DEFAULT_REGISTRY = 'http://127.0.0.1:4873/';

function usage() {
  return 'Usage: node scripts/registry-publish.mjs --package <directory-or-package.json> [--registry <loopback-url>] [--npmrc <file>]';
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help' || key === '-h') {
      options.help = true;
      continue;
    }
    if (!['--package', '--registry', '--npmrc'].includes(key)) {
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

function normalizeRegistry(value) {
  let url;
  try {
    url = new URL(value || DEFAULT_REGISTRY);
  } catch {
    throw new Error('The registry URL is invalid.');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const isLoopback = hostname === 'localhost' || hostname === 'localhost.' || hostname === '::1' || (isIP(hostname) === 4 && hostname.startsWith('127.'));
  if (!isLoopback || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only an HTTP(S) loopback registry is allowed.');
  }
  if (url.port === '3001') {
    throw new Error('Registry port 3001 is reserved and cannot be used.');
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('Registry URL must not contain credentials, a path, a query, or a fragment.');
  }
  url.pathname = '/';
  return url.toString();
}

function isExactSemver(value) {
  if (typeof value !== 'string') return false;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match) return false;
  if (match[4]) {
    for (const part of match[4].split('.')) {
      if (/^\d+$/.test(part) && part.length > 1 && part.startsWith('0')) return false;
    }
  }
  return true;
}

async function locateNpmCli() {
  const candidates = [];
  if (process.env.npm_execpath) candidates.push(process.env.npm_execpath);

  const nodeDirectory = path.dirname(process.execPath);
  candidates.push(path.join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  candidates.push(path.join(nodeDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));

  for (const entry of (process.env.PATH || '').split(path.delimiter)) {
    if (!entry) continue;
    candidates.push(path.join(entry, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    candidates.push(path.join(entry, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }

  for (const candidate of candidates) {
    if (!candidate.toLowerCase().endsWith('.js')) continue;
    try {
      await access(candidate);
      const file = await stat(candidate);
      if (file.isFile()) return path.resolve(candidate);
    } catch {
      // Try the next Node installation path without printing environment paths.
    }
  }
  throw new Error('Could not locate the installed npm CLI JavaScript entry point.');
}

function npmEnvironment() {
  return {
    ...process.env,
    NPM_CONFIG_LOGLEVEL: 'silent',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  };
}

async function runNpm(npmCli, args, { cwd, npmrc, registry } = {}) {
  // npm config/view do not support implicit workspace selection. Publish only
  // the explicit package directory, even when it belongs to a workspace root.
  const npmArgs = [...args, '--workspaces=false'];
  if (npmrc) npmArgs.push('--userconfig', npmrc);
  npmArgs.push('--registry', registry || DEFAULT_REGISTRY);

  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npmCli, ...npmArgs], {
      cwd,
      env: npmEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const keepTail = (current, chunk) => (current + chunk.toString()).slice(-32768);
    child.stdout.on('data', (chunk) => { stdout = keepTail(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = keepTail(stderr, chunk); });
    child.once('error', () => reject(new Error('Could not start npm.')));
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function verifyScopeRegistry(npmCli, scope, { cwd, npmrc, registry }) {
  const result = await runNpm(npmCli, ['config', 'get', scope + ':registry'], { cwd, npmrc, registry });
  if (result.code !== 0) {
    throw new Error('Could not inspect npm scope registry configuration; publication was stopped.');
  }
  const configuredRegistry = result.stdout.trim();
  if (!configuredRegistry || configuredRegistry === 'undefined' || configuredRegistry === 'null') return;
  let normalized;
  try {
    normalized = normalizeRegistry(configuredRegistry);
  } catch {
    throw new Error('An npm scope-specific registry points outside loopback; publication was stopped.');
  }
  if (normalized !== registry) {
    throw new Error('An npm scope-specific registry does not match the selected local registry; publication was stopped.');
  }
}

async function readManifest(packageArgument) {
  const resolved = path.resolve(packageArgument);
  const manifestPath = path.basename(resolved).toLowerCase() === 'package.json'
    ? resolved
    : path.join(resolved, 'package.json');
  let parsed;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    throw new Error('Could not read a valid package.json from the selected package path.');
  }
  return { packageDirectory: path.dirname(manifestPath), manifest: parsed };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage() + '\n');
    return;
  }
  if (!options.package) throw new Error(usage());

  const registry = normalizeRegistry(options.registry || DEFAULT_REGISTRY);
  const { packageDirectory, manifest } = await readManifest(options.package);
  const name = manifest.name;
  const version = manifest.version;
  if (typeof name !== 'string' || !/^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/.test(name)) {
    throw new Error('Package name must be an exact scoped package name.');
  }
  const scope = name.slice(0, name.indexOf('/'));
  if (!ALLOWED_SCOPES.has(scope)) throw new Error('Package scope is not in the local publish allowlist.');
  if (!isExactSemver(version)) throw new Error('Package version must be an exact semantic version.');
  if (manifest.private === true) throw new Error('A private package cannot be published.');
  if (manifest.publishConfig?.registry !== undefined) {
    let configuredRegistry;
    try {
      configuredRegistry = normalizeRegistry(manifest.publishConfig.registry);
    } catch {
      throw new Error('Package publishConfig.registry must point to the selected loopback registry.');
    }
    if (configuredRegistry !== registry) {
      throw new Error('Package publishConfig.registry does not match the selected loopback registry.');
    }
  }

  let npmrc;
  if (options.npmrc) {
    npmrc = path.resolve(options.npmrc);
    try {
      if (!(await stat(npmrc)).isFile()) throw new Error();
    } catch {
      throw new Error('The selected npm user configuration file does not exist.');
    }
  } else if (process.env.NPM_CONFIG_USERCONFIG) {
    npmrc = path.resolve(process.env.NPM_CONFIG_USERCONFIG);
  } else {
    npmrc = path.join(os.homedir(), '.npmrc');
  }

  const npmCli = await locateNpmCli();
  await verifyScopeRegistry(npmCli, scope, { cwd: packageDirectory, npmrc, registry });
  const existing = await runNpm(npmCli, ['view', name + '@' + version, 'version', '--json'], {
    cwd: packageDirectory,
    npmrc,
    registry,
  });
  if (existing.code === 0) {
    throw new Error('That exact package version already exists; published versions are immutable.');
  }
  if (!/\bE404\b|\b404 Not Found\b/i.test(existing.stdout + '\n' + existing.stderr)) {
    throw new Error('Could not verify the exact package version with the selected registry; publication was stopped.');
  }

  const published = await runNpm(npmCli, ['publish', packageDirectory], {
    cwd: packageDirectory,
    npmrc,
    registry,
  });
  if (published.code !== 0) {
    throw new Error('npm publish failed with exit code ' + String(published.code) + '. npm output was withheld to prevent credential disclosure.');
  }
  process.stdout.write('Published ' + name + '@' + version + ' to the selected local registry.\n');
}

main().catch((error) => {
  process.stderr.write((error instanceof Error ? error.message : 'Registry publication failed.') + '\n');
  process.exitCode = 1;
});
