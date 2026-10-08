import { spawn } from 'node:child_process';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const registryDir = resolve(scriptDir, '..');
const repositoryDir = resolve(registryDir, '../..');
const githubDir = resolve(repositoryDir, '..');
const command = process.argv[2];

if (command !== 'up' && command !== 'down') {
  console.error('사용법: npm run registry:up | npm run registry:down');
  process.exit(2);
}

const hostPortText = process.env.VERDACCIO_HOST_PORT ?? '4873';
if (!/^\d{1,5}$/.test(hostPortText)) {
  console.error('VERDACCIO_HOST_PORT는 1~65535 사이의 숫자여야 합니다.');
  process.exit(2);
}

const hostPort = Number(hostPortText);
if (hostPort < 1 || hostPort > 65535 || hostPort === 3001) {
  console.error('VERDACCIO_HOST_PORT는 1~65535 사이여야 하며 3001은 사용할 수 없습니다.');
  process.exit(2);
}

const runtimeOverride = process.env.VERDACCIO_RUNTIME_DIR;
if (runtimeOverride && !isAbsolute(runtimeOverride)) {
  console.error('VERDACCIO_RUNTIME_DIR를 지정할 때는 절대 경로를 사용하세요.');
  process.exit(2);
}

const runtimeDir = runtimeOverride
  ? resolve(runtimeOverride)
  : resolve(githubDir, '.suite-runtime', 'verdaccio');
const suiteRepositories = [
  'j-auth',
  'j-groupware',
  'j-messenger',
  'j-customer-auth-db',
  'j-mail',
  'j-approval',
  'j-talk',
  'j-web',
].map((name) => resolve(githubDir, name));

function isWithin(parent, candidate) {
  const relativePath = relative(parent, candidate);
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

if (suiteRepositories.some((repository) => isWithin(repository, runtimeDir))) {
  console.error('registry runtime 경로는 suite 저장소 checkout 밖이어야 합니다.');
  process.exit(2);
}

const composeFile = resolve(registryDir, 'compose.yaml');
const composeArgs = ['compose', '--file', composeFile];
if (command === 'up') {
  composeArgs.push('up', '-d');
} else {
  composeArgs.push('down');
}

const child = spawn('docker', composeArgs, {
  cwd: registryDir,
  env: process.env,
  shell: false,
  stdio: 'inherit',
});

child.on('error', (error) => {
  console.error(`Docker Compose를 실행하지 못했습니다: ${error.message}`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
