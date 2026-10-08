import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const checkoutRoot = path.resolve(testDirectory, '..', '..');
const registryDirectory = path.join(checkoutRoot, 'tools', 'registry');
const requireVerdaccioConfig = createRequire(path.join(registryDirectory, 'package.json'));
const { fromJStoYAML, parseConfigFile } = requireVerdaccioConfig('@verdaccio/config');
const verdaccioEntry = path.join(registryDirectory, 'node_modules', 'verdaccio', 'bin', 'verdaccio');
const publishScript = path.join(checkoutRoot, 'scripts', 'registry-publish.mjs');
const backupScript = path.join(checkoutRoot, 'scripts', 'registry-backup.mjs');
const registryUrl = 'http://127.0.0.1:4873/';

function isWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sanitizedNpmOutput(result, privateValues = []) {
  let output = result.stdout + '\n' + result.stderr;
  for (const value of privateValues) {
    if (value) output = output.split(value).join('[redacted]');
  }
  return output
    .replace(/(_authToken\s*=\s*)\S+/gi, '$1[redacted]')
    .replace(/(Bearer\s+)\S+/gi, '$1[redacted]')
    .slice(-2000);
}

async function runProcess(executable, args, { cwd, env, timeoutMs = 45000 } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill();
      reject(new Error('A local registry process exceeded its time limit.'));
      settled = true;
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', () => {
      if (settled) return;
      clearTimeout(timeout);
      settled = true;
      reject(new Error('Could not start a local registry process.'));
    });
    child.once('close', (code) => {
      if (settled) return;
      clearTimeout(timeout);
      settled = true;
      resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

async function npmCliPath() {
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
      return path.resolve(candidate);
    } catch {
      // Keep probing without printing environment paths.
    }
  }
  throw new Error('Could not locate the npm CLI JavaScript entry point.');
}

function isolatedNpmEnvironment(home, userConfig, globalConfig) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    NPM_CONFIG_USERCONFIG: userConfig,
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    NPM_CONFIG_CACHE: path.join(home, 'cache'),
    NPM_CONFIG_LOGLEVEL: 'error',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  };
}

async function runNpm(npmCli, args, { cwd, env, timeoutMs, npmrc, registry } = {}) {
  const npmArgs = [...args];
  if (npmrc) npmArgs.push('--userconfig', npmrc);
  if (registry) npmArgs.push('--registry', registry);
  const result = await runProcess(process.execPath, [npmCli, ...npmArgs], { cwd, env, timeoutMs });
  return {
    code: result.code,
    stdout: result.stdout.toString('utf8'),
    stderr: result.stderr.toString('utf8'),
  };
}

async function runNode(args, { cwd, env, timeoutMs } = {}) {
  const result = await runProcess(process.execPath, args, { cwd, env, timeoutMs });
  return {
    code: result.code,
    stdout: result.stdout.toString('utf8'),
    stderr: result.stderr.toString('utf8'),
  };
}

async function waitForVerdaccio(child, getStartupOutput, timeoutMs = 20000) {
  const start = Date.now();
  let lastSocketError = 'none';
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) throw new Error('The local Verdaccio process exited before becoming ready. ' + getStartupOutput());
    const listening = await new Promise((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port: 4873 });
      let settled = false;
      const finish = (connected, errorCode) => {
        if (settled) return;
        settled = true;
        if (errorCode) lastSocketError = errorCode;
        socket.destroy();
        resolve(connected);
      };
      socket.setTimeout(700, () => finish(false));
      socket.once('connect', () => finish(true));
      socket.once('error', (error) => finish(false, error.code || 'socket-error'));
    });
    if (listening) return;
    await delay(150);
  }
  throw new Error('The local Verdaccio process did not become ready on 127.0.0.1:4873; last socket error: ' + lastSocketError + '. ' + getStartupOutput());
}

async function assertFixturePortAvailable() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', () => reject(new Error('Port 4873 is already in use; refusing to touch an existing registry.')));
    server.listen(4873, '127.0.0.1', () => {
      server.close((error) => {
        if (error) reject(new Error('Could not safely release the temporary 4873 port check.'));
        else resolve();
      });
    });
  });
}

async function stopVerdaccio(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await Promise.race([once(child, 'exit'), delay(5000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function findFiles(directory, predicate, found = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await findFiles(fullPath, predicate, found);
    else if (entry.isFile() && predicate(fullPath)) found.push(fullPath);
  }
  return found;
}

test('local Verdaccio login, publish, immutable install, policy checks, and backup', { timeout: 180000 }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'jgw-registry-x1-'));
  const temporaryAbsolute = path.resolve(temporaryRoot);
  const osTempAbsolute = path.resolve(os.tmpdir());
  let verdaccio;
  try {
    assert.ok(isWithin(osTempAbsolute, temporaryAbsolute), 'Fixture must remain under the operating system temporary directory.');
    await access(verdaccioEntry);

    const runtimeRoot = path.join(temporaryRoot, 'runtime');
    const storagePath = path.join(runtimeRoot, 'storage');
    const authPath = path.join(runtimeRoot, 'htpasswd');
    const configPath = path.join(temporaryRoot, 'verdaccio-config.yaml');
    await mkdir(storagePath, { recursive: true });
    await writeFile(authPath, '', { flag: 'wx' });
    const sharedConfigPath = path.join(registryDirectory, 'config.yaml');
    const sharedConfig = parseConfigFile(sharedConfigPath);
    const expectedScopes = ['@j-auth', '@j-groupware', '@j-messenger', '@j-customer-auth-db', '@j-mail', '@j-approval', '@j-talk', '@j-web'];
    for (const scope of expectedScopes) {
      const rule = sharedConfig.packages[scope + '/*'];
      assert.ok(rule, 'The shared config must define scope ' + scope + '.');
      assert.equal(rule.access, '$all', 'The shared scope access rule must come from the real config.');
      assert.equal(rule.publish, '$authenticated', 'The shared scope publish rule must come from the real config.');
      assert.equal(rule.unpublish, '__registry_unpublish_disabled__:deny', 'The shared scope unpublish rule must come from the real config.');
    }
    assert.equal(sharedConfig.packages['**'].publish, undefined, 'The shared catch-all must not permit publication.');
    assert.equal(sharedConfig.packages['**'].unpublish, '__registry_unpublish_disabled__:deny', 'The shared catch-all must deny unpublishing.');
    assert.equal(sharedConfig.auth.htpasswd.max_users, 1, 'The shared registry must limit registration to the intended account.');

    const fixtureConfig = structuredClone(sharedConfig);
    delete fixtureConfig.configPath;
    delete fixtureConfig.config_path;
    fixtureConfig.storage = storagePath;
    fixtureConfig.auth.htpasswd.file = authPath;
    fixtureConfig.listen = '127.0.0.1:4873';
    fixtureConfig.uplinks = {};
    for (const rule of Object.values(fixtureConfig.packages)) delete rule.proxy;
    const expectedFixturePackages = structuredClone(sharedConfig.packages);
    for (const rule of Object.values(expectedFixturePackages)) delete rule.proxy;
    assert.deepEqual(fixtureConfig.packages, expectedFixturePackages, 'The fixture must preserve shared access, publish, and unpublish ACLs exactly.');
    await writeFile(configPath, fromJStoYAML(fixtureConfig), { flag: 'wx' });

    await assertFixturePortAvailable();
    let startupOutput = '';
    verdaccio = spawn(process.execPath, [verdaccioEntry, '--config', configPath], {
      cwd: registryDirectory,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const captureStartupOutput = (chunk) => {
      startupOutput = (startupOutput + chunk.toString('utf8')).slice(-6000);
    };
    verdaccio.stdout.on('data', captureStartupOutput);
    verdaccio.stderr.on('data', captureStartupOutput);
    await waitForVerdaccio(verdaccio, () => startupOutput.replace(/(password|secret|token)(\s*[:=]\s*)\S+/gi, '$1$2[redacted]'));
    startupOutput = '';

    const npmCli = await npmCliPath();
    const isolatedHome = path.join(temporaryRoot, 'npm-home');
    await mkdir(isolatedHome, { recursive: true });
    const globalConfig = path.join(isolatedHome, 'global.npmrc');
    const emptyUserConfig = path.join(isolatedHome, 'empty.npmrc');
    const userConfig = path.join(isolatedHome, 'user.npmrc');
    await writeFile(globalConfig, '', { flag: 'wx' });
    await writeFile(emptyUserConfig, '', { flag: 'wx' });
    await writeFile(userConfig, '', { flag: 'wx' });
    const unauthenticatedEnvironment = isolatedNpmEnvironment(isolatedHome, emptyUserConfig, globalConfig);

    const patchVersion = (Date.now() % 100000000) * 1000 + (randomBytes(2).readUInt16BE(0) % 1000);
    const version = '0.1.' + String(patchVersion);
    const packageName = '@j-auth/contracts';
    const workspaceDirectory = path.join(temporaryRoot, 'workspace');
    const packageDirectory = path.join(workspaceDirectory, 'package');
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(path.join(workspaceDirectory, 'package.json'), JSON.stringify({
      name: 'registry-workspace-fixture', private: true, workspaces: ['package'],
    }) + '\n', { flag: 'wx' });
    await writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({
      name: packageName,
      version,
      type: 'module',
      main: './index.js',
      exports: { '.': './index.js' },
    }, null, 2) + '\n', { flag: 'wx' });
    await writeFile(path.join(packageDirectory, 'index.js'), 'export const registryFixture = "x1-package";\n', { flag: 'wx' });

    const unauthenticatedPublish = await runNpm(npmCli, [
      'publish', packageDirectory,
      '--userconfig', emptyUserConfig,
      '--registry', registryUrl,
    ], { cwd: packageDirectory, env: unauthenticatedEnvironment });
    assert.notEqual(unauthenticatedPublish.code, 0, 'Unauthenticated publishing must be rejected.');

    const username = 'x1-' + randomBytes(8).toString('hex');
    const password = 'x1-' + randomBytes(32).toString('hex');
    const email = 'registry-test@registry.invalid';
    const loginEnvironment = isolatedNpmEnvironment(isolatedHome, userConfig, globalConfig);
    const deniedUsername = '__registry_unpublish_disabled__:deny';
    const deniedUserId = 'org.couchdb.user:' + deniedUsername;
    const deniedRegistration = await fetch(new URL('-/user/' + deniedUserId, registryUrl), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ _id: deniedUserId, name: deniedUsername, password: randomBytes(32).toString('hex'), email, type: 'user', roles: [] }),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(deniedRegistration.status, 409, 'The htpasswd plugin must reject registration of the non-URI-safe unpublish-deny group.');
    assert.match(await deniedRegistration.text(), /non-uri-safe characters/i, 'The registration rejection must come from username validation, not max_users.');
    assert.equal(await readFile(authPath, 'utf8'), '', 'The rejected sentinel account must not consume the one allowed account slot.');
    const userId = 'org.couchdb.user:' + username;
    const registration = await fetch(new URL('-/user/' + userId, registryUrl), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ _id: userId, name: username, password, email, type: 'user', roles: [] }),
      signal: AbortSignal.timeout(10000),
    });
    assert.ok(registration.ok, 'A synthetic account must be created through the real Verdaccio npm user endpoint.');
    const registrationResult = await registration.json();
    assert.equal(typeof registrationResult.token, 'string', 'Verdaccio must return a real authentication token for the temporary account.');
    await writeFile(userConfig, '//127.0.0.1:4873/:_authToken=' + registrationResult.token + '\n', { flag: 'w' });
    const login = await runNpm(npmCli, ['whoami', '--userconfig', userConfig, '--registry', registryUrl], {
      cwd: temporaryRoot,
      env: loginEnvironment,
    });
    assert.ok(login.code === 0 && login.stdout.trim() === username, 'The npm CLI must authenticate with the real temporary account token.');
    const userConfigText = await readFile(userConfig, 'utf8');
    assert.match(userConfigText, /:_authToken=/, 'The login token must be written only to the OS temporary npm profile.');
    assert.equal(userConfigText.includes(password), false, 'The temporary npm profile must not contain the test password.');
    const capturedToken = /:_authToken=([^\s]+)/.exec(userConfigText)?.[1];
    assert.ok(capturedToken, 'The test login must create an npm token in the temporary profile.');

    for (const rejectedName of ['@not-allowed/contracts', 'not-allowed-contracts']) {
      const rejectedDirectory = path.join(temporaryRoot, 'scope-deny-' + rejectedName.replace(/[^a-z0-9]+/gi, '-'));
      await mkdir(rejectedDirectory, { recursive: true });
      await writeFile(path.join(rejectedDirectory, 'package.json'), JSON.stringify({ name: rejectedName, version: '1.0.0' }) + '\n', { flag: 'wx' });
      await writeFile(path.join(rejectedDirectory, 'index.js'), 'export const outsideSuite = true;\n', { flag: 'wx' });
      const outsideScopePublish = await runNpm(npmCli, [
        'publish', rejectedDirectory,
        '--userconfig', userConfig,
        '--registry', registryUrl,
      ], { cwd: rejectedDirectory, env: loginEnvironment });
      assert.notEqual(outsideScopePublish.code, 0, 'Authenticated publishing outside suite scopes must be denied by Verdaccio.');
    }

    const publisher = await runNode([
      publishScript,
      '--package', packageDirectory,
      '--registry', registryUrl,
      '--npmrc', userConfig,
    ], { cwd: checkoutRoot, env: loginEnvironment });
    assert.equal(publisher.code, 0, 'The allowlisted publisher must publish the real package through Verdaccio. ' + sanitizedNpmOutput(publisher, [username, password, capturedToken]));
    assert.equal((publisher.stdout + publisher.stderr).includes(password), false, 'Publisher output must not reveal the password.');
    assert.equal((publisher.stdout + publisher.stderr).includes(capturedToken), false, 'Publisher output must not reveal the token.');

    const duplicatePublisher = await runNode([
      publishScript,
      '--package', packageDirectory,
      '--registry', registryUrl,
      '--npmrc', userConfig,
    ], { cwd: checkoutRoot, env: loginEnvironment });
    assert.notEqual(duplicatePublisher.code, 0, 'The publisher must reject an existing exact version.');
    assert.equal((duplicatePublisher.stdout + duplicatePublisher.stderr).includes(password), false, 'Publisher error output must not reveal the password.');
    assert.equal((duplicatePublisher.stdout + duplicatePublisher.stderr).includes(capturedToken), false, 'Publisher error output must not reveal the token.');

    const consumerDirectory = path.join(temporaryRoot, 'consumer');
    await mkdir(consumerDirectory, { recursive: true });
    await writeFile(path.join(consumerDirectory, 'package.json'), JSON.stringify({ name: 'registry-x1-consumer', private: true, type: 'module' }, null, 2) + '\n', { flag: 'wx' });
    const install = await runNpm(npmCli, [
      'install', '--save-exact', packageName + '@' + version,
      '--userconfig', emptyUserConfig,
      '--registry', registryUrl,
    ], { cwd: consumerDirectory, env: unauthenticatedEnvironment });
    assert.equal(install.code, 0, 'A separate consumer must install the exact published version without authentication.');
    const verifyPath = path.join(consumerDirectory, 'verify.mjs');
    await writeFile(verifyPath, 'import { registryFixture } from "@j-auth/contracts";\nif (registryFixture !== "x1-package") process.exit(1);\n', { flag: 'wx' });
    const imported = await runNode([verifyPath], { cwd: consumerDirectory, env: unauthenticatedEnvironment });
    assert.equal(imported.code, 0, 'The installed package must import and expose the expected contract value.');

    const repeatedUpload = await runNpm(npmCli, [
      'publish', packageDirectory,
      '--userconfig', userConfig,
      '--registry', registryUrl,
    ], { cwd: packageDirectory, env: loginEnvironment });
    assert.notEqual(repeatedUpload.code, 0, 'Verdaccio must reject an overwrite of an immutable version.');

    const unpublish = await runNpm(npmCli, [
      'unpublish', packageName + '@' + version,
      '--force',
      '--userconfig', userConfig,
      '--registry', registryUrl,
    ], { cwd: temporaryRoot, env: loginEnvironment });
    const remains = await runNpm(npmCli, ['view', packageName + '@' + version, 'version', '--json', '--userconfig', emptyUserConfig, '--registry', registryUrl], {
      cwd: temporaryRoot,
      env: unauthenticatedEnvironment,
    });
    assert.equal(remains.code, 0, 'The package version must remain available after an unpublish attempt. npm returned code ' + String(unpublish.code) + ': ' + sanitizedNpmOutput(unpublish, [username, password, capturedToken]));
    assert.equal(unpublish.code, 1, 'Verdaccio 6.10.5 must reject unpublishing with npm exit code 1. ' + sanitizedNpmOutput(unpublish, [username, password, capturedToken]));

    const rejectedScopeDirectory = path.join(temporaryRoot, 'rejected-scope');
    await mkdir(rejectedScopeDirectory, { recursive: true });
    await writeFile(path.join(rejectedScopeDirectory, 'package.json'), JSON.stringify({ name: '@not-allowed/contracts', version: '1.0.0' }) + '\n', { flag: 'wx' });
    const rejectedScope = await runNode([publishScript, '--package', rejectedScopeDirectory, '--registry', registryUrl, '--npmrc', userConfig], {
      cwd: checkoutRoot,
      env: loginEnvironment,
    });
    assert.notEqual(rejectedScope.code, 0, 'A package outside the eight allowed scopes must be rejected before npm is called.');

    const rejectedRemote = await runNode([publishScript, '--package', packageDirectory, '--registry', 'https://registry.npmjs.org/', '--npmrc', userConfig], {
      cwd: checkoutRoot,
      env: loginEnvironment,
    });
    assert.notEqual(rejectedRemote.code, 0, 'A remote registry endpoint must be rejected.');
    const rejectedPort = await runNode([publishScript, '--package', packageDirectory, '--registry', 'http://127.0.0.1:3001/', '--npmrc', userConfig], {
      cwd: checkoutRoot,
      env: loginEnvironment,
    });
    assert.notEqual(rejectedPort.code, 0, 'Port 3001 must be rejected.');

    const externalScopeConfig = path.join(isolatedHome, 'external-scope.npmrc');
    await writeFile(externalScopeConfig, '@j-auth:registry=https://registry.npmjs.org/\n', { flag: 'wx' });
    const scopeRegistryQuery = await runNpm(npmCli, ['config', 'get', '@j-auth:registry', '--workspaces=false'], {
      cwd: packageDirectory,
      env: loginEnvironment,
      npmrc: externalScopeConfig,
      registry: registryUrl,
    });
    assert.equal(scopeRegistryQuery.code, 0, 'npm config must succeed for the selected workspace package.');
    assert.equal(scopeRegistryQuery.stdout.trim(), 'https://registry.npmjs.org/', 'npm must report the scope-specific external registry even when a global --registry is also supplied.');
    const rejectedScopeEndpoint = await runNode([publishScript, '--package', packageDirectory, '--registry', registryUrl, '--npmrc', externalScopeConfig], {
      cwd: checkoutRoot,
      env: loginEnvironment,
    });
    assert.ok(rejectedScopeEndpoint.code !== 0 && rejectedScopeEndpoint.stderr.includes('scope-specific registry points outside loopback'), 'The publisher must reject a scope-specific external endpoint before attempting publication.');

    const externalManifestDirectory = path.join(temporaryRoot, 'external-manifest');
    await mkdir(externalManifestDirectory, { recursive: true });
    await writeFile(path.join(externalManifestDirectory, 'package.json'), JSON.stringify({
      name: '@j-auth/contracts',
      version: '0.1.0-x1-external',
      publishConfig: { registry: 'https://registry.npmjs.org/' },
    }) + '\n', { flag: 'wx' });
    const rejectedManifestEndpoint = await runNode([publishScript, '--package', externalManifestDirectory, '--registry', registryUrl, '--npmrc', userConfig], {
      cwd: checkoutRoot,
      env: loginEnvironment,
    });
    assert.notEqual(rejectedManifestEndpoint.code, 0, 'An external publishConfig registry must be rejected.');

    const archivePath = path.join(temporaryRoot, 'registry-backup.tar.gz');
    const backup = await runNode([
      backupScript,
      '--storage', storagePath,
      '--auth', authPath,
      '--output', archivePath,
    ], { cwd: checkoutRoot, env: loginEnvironment });
    assert.equal(backup.code, 0, 'The backup tool must archive the fixture storage and auth file.');
    assert.ok(!isWithin(checkoutRoot, archivePath), 'The backup archive must remain outside the repository checkout.');
    assert.ok(!isWithin(runtimeRoot, archivePath), 'The backup archive must remain outside the registry runtime directory.');

    const serviceRepositoryNames = ['j-auth', 'j-groupware', 'j-messenger', 'j-mail', 'j-customer-auth-db', 'j-approval', 'j-talk', 'j-web'];
    for (const repositoryName of serviceRepositoryNames) {
      const forbiddenArchive = path.join(path.dirname(checkoutRoot), repositoryName, 'registry-backup-test.tar.gz');
      const forbidden = await runNode([
        backupScript,
        '--storage', storagePath,
        '--auth', authPath,
        '--output', forbiddenArchive,
      ], { cwd: checkoutRoot, env: loginEnvironment });
      assert.notEqual(forbidden.code, 0, 'Backup output must be rejected inside every service checkout.');
    }

    const existingArchive = path.join(temporaryRoot, 'existing-backup.tar.gz');
    await writeFile(existingArchive, 'preserve-existing-output', { flag: 'wx' });
    const overwriteBackup = await runNode([
      backupScript,
      '--storage', storagePath,
      '--auth', authPath,
      '--output', existingArchive,
    ], { cwd: checkoutRoot, env: loginEnvironment });
    assert.notEqual(overwriteBackup.code, 0, 'The backup tool must refuse to overwrite an existing archive.');
    assert.equal(await readFile(existingArchive, 'utf8'), 'preserve-existing-output', 'An existing output file must remain unchanged.');

    let junctionCreated = false;
    const junctionPath = path.join(temporaryRoot, 'repository-junction');
    try {
      await symlink(checkoutRoot, junctionPath, 'junction');
      junctionCreated = true;
    } catch {
      // Some managed Windows hosts disallow temporary junction creation.
    }
    if (junctionCreated) {
      const junctionOutput = await runNode([
        backupScript,
        '--storage', storagePath,
        '--auth', authPath,
        '--output', path.join(junctionPath, 'registry-backup-through-junction.tar.gz'),
      ], { cwd: checkoutRoot, env: loginEnvironment });
      assert.notEqual(junctionOutput.code, 0, 'The backup tool must reject an output path whose ancestor is a checkout junction.');
    }

    const tar = await findTarExecutable();
    const listing = await runProcess(tar, ['-tzf', archivePath], { cwd: temporaryRoot });
    assert.equal(listing.code, 0, 'The generated archive must be readable by tar.');
    const entries = listing.stdout.toString('utf8').split(/\r?\n/).filter(Boolean).map((entry) => entry.replace(/\\/g, '/'));
    assert.ok(entries.some((entry) => entry === 'htpasswd'), 'The archive must include the auth file.');
    assert.ok(entries.some((entry) => entry.startsWith('storage/')), 'The archive must include the package storage.');
    assert.equal(entries.some((entry) => entry.includes('npm-home') || entry.includes('user.npmrc')), false, 'The archive must not include npm login tokens.');

    const archivedAuth = await runProcess(tar, ['-xOf', archivePath, 'htpasswd'], { cwd: temporaryRoot });
    assert.equal(archivedAuth.code, 0, 'The archived auth file must be extractable for inspection.');
    assert.equal(sha256(archivedAuth.stdout), sha256(await readFile(authPath)), 'The archived auth file must match the source bytes.');

    const packageTarballs = await findFiles(storagePath, (file) => file.endsWith('.tgz'));
    assert.ok(packageTarballs.length > 0, 'Verdaccio storage must contain the published package tarball.');
    const selectedPackageTarball = packageTarballs[0];
    const archiveEntry = path.relative(runtimeRoot, selectedPackageTarball).replace(/\\/g, '/');
    const archivedPackage = await runProcess(tar, ['-xOf', archivePath, archiveEntry], { cwd: temporaryRoot });
    assert.equal(archivedPackage.code, 0, 'The archived package tarball must be extractable for inspection.');
    assert.equal(sha256(archivedPackage.stdout), sha256(await readFile(selectedPackageTarball)), 'The archived package tarball must match the published source bytes.');
    t.diagnostic('Observed: npm unpublish exit=1; npm view exact version exit=0; reserved username registration HTTP 409; 8 checkout paths rejected; junction ancestor check ' + (junctionCreated ? 'passed' : 'unavailable on this host') + '.');
  } finally {
    if (verdaccio) await stopVerdaccio(verdaccio);
    const resolvedTemporaryRoot = path.resolve(temporaryRoot);
    if (isWithin(path.resolve(os.tmpdir()), resolvedTemporaryRoot) && path.basename(resolvedTemporaryRoot).startsWith('jgw-registry-x1-')) {
      await rm(resolvedTemporaryRoot, { recursive: true, force: true });
    }
  }
});

async function findTarExecutable() {
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
  throw new Error('The system tar utility is required for backup inspection.');
}
