import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { execute } from "../../deploy/gateway/gateway.mjs";
const name = "jgw-tls-" + randomUUID().slice(0, 8),
  source = fileURLToPath(new URL("../../", import.meta.url));
let owned = false;
const invoke = promisify(execFile);
const run = async (script, user = "root") => {
  try {
    return (
      await invoke(
        "docker",
        [
          "exec",
          "--user",
          user,
          name,
          "/usr/local/bin/node",
          "--input-type=module",
          "-e",
          script,
        ],
        { timeout: 10000, maxBuffer: 65536 },
      )
    ).stdout;
  } catch (error) {
    throw new Error(
      "Isolated credential command failed: " +
        String(error.stderr ?? "").slice(-2000),
    );
  }
};
before(async () => {
  if (process.env.JGW_AGENT_TEST_RUNTIME !== "isolated-cloud")
    throw new Error("Explicit isolated container required; no skip.");
  await execute("docker", [
    "run",
    "--detach",
    "--name",
    name,
    "--mount",
    `type=bind,src=${source},dst=/code,readonly`,
    "--mount",
    `type=bind,src=${process.execPath},dst=/test-node/node,readonly`,
    "--tmpfs",
    "/etc/jgw:rw,size=8m,mode=0700",
    "--tmpfs",
    "/run/credentials:rw,size=8m,mode=0755",
    "--tmpfs",
    "/opt/jgw:rw,size=8m,mode=0755",
    "--entrypoint",
    "/bin/sleep",
    "jweb-isolated-hosting:20261008",
    "300",
  ]);
  owned = true;
  await execute("docker", [
    "exec",
    name,
    "/test-node/node",
    "--input-type=module",
    "-e",
    "import {copyFile,chmod} from 'node:fs/promises';await copyFile('/test-node/node','/usr/local/bin/node');await chmod('/usr/local/bin/node',0o555);",
  ]);

  await execute("docker", [
    "exec",
    name,
    "/usr/sbin/useradd",
    "--system",
    "--user-group",
    "--no-create-home",
    "--home-dir",
    "/var/lib/jgw-talk",
    "--shell",
    "/usr/sbin/nologin",
    "jgw-talk",
  ]);
  await execute("docker", [
    "exec",
    name,
    "/usr/sbin/useradd",
    "--system",
    "--user-group",
    "--no-create-home",
    "--home-dir",
    "/var/lib/jgw-mail",
    "--shell",
    "/usr/sbin/nologin",
    "jgw-mail",
  ]);
  await run(`import {mkdir,writeFile,chmod,cp} from 'node:fs/promises';import {execFileSync} from 'node:child_process';
    await mkdir('/opt/jgw/test-agent/deploy/agent',{recursive:true});await mkdir('/opt/jgw/test-agent/deploy/gateway',{recursive:true});await mkdir('/opt/jgw/test-agent/node_modules/@j-auth',{recursive:true});
    for(const file of ['tls-credentials.mjs','launch-service.mjs','control-files.mjs','provision-error.mjs'])await cp('/code/deploy/agent/'+file,'/opt/jgw/test-agent/deploy/agent/'+file);
    await cp('/code/deploy/gateway/gateway.mjs','/opt/jgw/test-agent/deploy/gateway/gateway.mjs');await cp('/code/node_modules/@j-auth/contracts','/opt/jgw/test-agent/node_modules/@j-auth/contracts',{recursive:true});execFileSync('/usr/bin/chmod',['-R','a+rX','/opt/jgw/test-agent']);
    await mkdir('/etc/jgw/services',{mode:0o700});await mkdir('/etc/jgw/private',{mode:0o700});
    execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout','/etc/jgw/private/ca.key','-out','/etc/jgw/private/ca.crt','-subj','/CN=Fixture CA','-days','1'],{stdio:'ignore'});
    execFileSync('/usr/bin/openssl',['req','-new','-newkey','rsa:2048','-nodes','-keyout','/etc/jgw/private/tls.key','-out','/etc/jgw/private/tls.csr','-subj','/CN=localhost'],{stdio:'ignore'});
    await writeFile('/etc/jgw/private/leaf.ext','basicConstraints=critical,CA:FALSE\\nkeyUsage=critical,digitalSignature,keyEncipherment\\nsubjectAltName=DNS:localhost,IP:127.0.0.1\\n');
    execFileSync('/usr/bin/openssl',['x509','-req','-in','/etc/jgw/private/tls.csr','-CA','/etc/jgw/private/ca.crt','-CAkey','/etc/jgw/private/ca.key','-CAcreateserial','-out','/etc/jgw/private/tls.crt','-days','1','-extfile','/etc/jgw/private/leaf.ext'],{stdio:'ignore'});
    await chmod('/etc/jgw/private/ca.key',0o600);
    await chmod('/etc/jgw/private/tls.key',0o600);
    await writeFile('/etc/jgw/services/j-talk.env','JT_TLS_CERTIFICATE=/etc/jgw/private/tls.crt\\nJT_TLS_KEY=/etc/jgw/private/tls.key\\nNODE_EXTRA_CA_CERTS=/etc/jgw/private/ca.crt\\n',{mode:0o600});`);
});
after(async () => {
  if (owned) await execute("docker", ["rm", "--force", "--volumes", name]);
});
test("root stages only validated TLS/public CA material, preserves idempotency and refuses foreign or changed files", async () => {
  const result = JSON.parse(
    await run(`import assert from 'node:assert/strict';import {NativeTlsCredentials} from '/opt/jgw/test-agent/deploy/agent/tls-credentials.mjs';import {readFile,writeFile,chmod,mkdir,symlink,rm} from 'node:fs/promises';
    const value=new NativeTlsCredentials({environmentRoot:'/etc/jgw/services'});assert.equal((await value.prepare('j-talk')).changed,true);assert.equal((await value.prepare('j-talk')).changed,false);
    const key=await readFile('/etc/jgw/services/j-talk.credentials/tls-key','utf8');await writeFile('/etc/jgw/services/j-talk.credentials/tls-key','tampered');await assert.rejects(value.prepare('j-talk'),{code:'credentials_conflict'});await writeFile('/etc/jgw/services/j-talk.credentials/tls-key',key);
    await chmod('/etc/jgw/private/tls.key',0o644);await assert.rejects(value.prepare('j-talk'),{code:'unsafe_control_file'});await chmod('/etc/jgw/private/tls.key',0o600);
    await writeFile('/etc/jgw/services/j-mail.env','JML_TLS_CERTIFICATE=/etc/jgw/private/tls.crt\\nJML_TLS_KEY=/etc/jgw/private/tls.key\\nNODE_EXTRA_CA_CERTS=/etc/jgw/private/ca.crt\\n',{mode:0o600});
    await assert.rejects(value.require('j-mail'),{code:'credentials_not_prepared'});
    await mkdir('/etc/jgw/services/j-mail.credentials',{mode:0o700});await writeFile('/etc/jgw/services/j-mail.credentials/foreign','preserve');await assert.rejects(value.prepare('j-mail'),{code:'credentials_conflict'});assert.equal(await readFile('/etc/jgw/services/j-mail.credentials/foreign','utf8'),'preserve');
    await symlink('/etc/jgw/private/tls.crt','/etc/jgw/private/link.crt');const env=await readFile('/etc/jgw/services/j-talk.env','utf8');await writeFile('/etc/jgw/services/j-talk.env',env.replaceAll('/etc/jgw/private/tls.crt','/etc/jgw/private/link.crt'));await assert.rejects(value.prepare('j-talk'));await writeFile('/etc/jgw/services/j-talk.env',env);
    const cert=await readFile('/etc/jgw/private/tls.crt','utf8');await writeFile('/etc/jgw/private/tls.crt',cert+key);await assert.rejects(value.prepare('j-talk'),{code:'invalid_tls_credentials'});await writeFile('/etc/jgw/private/tls.crt',cert);
    await writeFile('/etc/jgw/services/j-talk.env',env.replace('JT_TLS_CERTIFICATE=/etc/jgw/private/tls.crt','JT_TLS_CERTIFICATE=/etc/jgw/private/ca.crt').replace('JT_TLS_KEY=/etc/jgw/private/tls.key','JT_TLS_KEY=/etc/jgw/private/ca.key'));await assert.rejects(value.prepare('j-talk'),{code:'invalid_tls_credentials'});await writeFile('/etc/jgw/services/j-talk.env',env);
    await writeFile('/etc/jgw/services/j-customer-auth-db.env','JCADB_TLS_CERTIFICATE=/etc/jgw/private/tls.crt\\nJCADB_TLS_KEY=/etc/jgw/private/tls.key\\nJCADB_CA_CERTIFICATE=/etc/jgw/private/ca.crt\\nJCADB_GUEST_SIGNING_KEY=/etc/jgw/private/ca.key\\n',{mode:0o600});await assert.rejects(value.prepare('j-customer-auth-db'),{code:'invalid_tls_credentials'});
    await assert.rejects(value.prepare('__proto__'),{code:'invalid_service'});
    console.log(JSON.stringify({idempotent:true,tamperedRejected:true,worldReadableKeyRejected:true,foreignPreserved:true,symlinkRejected:true,privateCAAppendRejected:true}));`),
  );
  assert(Object.values(result).every((value) => value === true));
});
test("distinct service users can read only their own runtime credentials while root sources remain private", async () => {
  await run(`import {mkdir,copyFile,chown,chmod} from 'node:fs/promises';import {execFileSync} from 'node:child_process';
    const uid=Number(execFileSync('/usr/bin/id',['-u','jgw-talk'],{encoding:'utf8'}).trim()),gid=Number(execFileSync('/usr/bin/id',['-g','jgw-talk'],{encoding:'utf8'}).trim());
    await mkdir('/run/credentials/jgw-talk.service',{mode:0o700});await chown('/run/credentials/jgw-talk.service',uid,gid);
    for(const file of ['tls-certificate','tls-key','ca-certificate']){await copyFile('/etc/jgw/services/j-talk.credentials/'+file,'/run/credentials/jgw-talk.service/'+file);await chown('/run/credentials/jgw-talk.service/'+file,uid,gid);await chmod('/run/credentials/jgw-talk.service/'+file,0o400);}`);
  assert.equal(
    await run(
      `import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {credentialEnvironment} from '/opt/jgw/test-agent/deploy/agent/launch-service.mjs';await assert.rejects(readFile('/etc/jgw/private/tls.key'));const env=await credentialEnvironment('j-talk',{CREDENTIALS_DIRECTORY:'/run/credentials/jgw-talk.service',NODE_OPTIONS:'--invalid-loader',LD_PRELOAD:'/invalid'});assert.equal(env.JT_TLS_KEY,'/run/credentials/jgw-talk.service/tls-key');assert.equal(env.NODE_EXTRA_CA_CERTS,'/run/credentials/jgw-talk.service/ca-certificate');assert.equal(env.NODE_OPTIONS,undefined);assert.equal(env.LD_PRELOAD,undefined);await assert.rejects(credentialEnvironment('j-mail',{CREDENTIALS_DIRECTORY:'/run/credentials/jgw-talk.service'}));console.log('isolated');`,
      "jgw-talk",
    ),
    "isolated\n",
  );
  assert.equal(
    await run(
      `import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';await assert.rejects(readFile('/run/credentials/jgw-talk.service/tls-key'));await assert.rejects(readFile('/etc/jgw/private/tls.key'));console.log('denied');`,
      "jgw-mail",
    ),
    "denied\n",
  );
});
test("launcher replaces the process and makes a fresh Node trust the credential CA over real HTTPS", async () => {
  await run(`import {mkdir,writeFile} from 'node:fs/promises';await mkdir('/opt/jgw/bundles/j-talk/apps/server/dist',{recursive:true,mode:0o755});
    await writeFile('/opt/jgw/bundles/j-talk/apps/server/dist/main.js',\`const https=require('node:https'),fs=require('node:fs');const s=https.createServer({cert:fs.readFileSync(process.env.JT_TLS_CERTIFICATE),key:fs.readFileSync(process.env.JT_TLS_KEY)},(_q,r)=>r.end('trusted'));s.listen(55074,'127.0.0.1',async()=>{try{const r=await fetch('https://127.0.0.1:55074');if(await r.text()!=='trusted')throw Error();console.log(JSON.stringify({pid:process.pid,freshCA:true}));s.close();}catch{process.exitCode=1;s.close();}});\`,{mode:0o644});`);
  const output = await run(
    `import {launchService} from '/opt/jgw/test-agent/deploy/agent/launch-service.mjs';process.env.CREDENTIALS_DIRECTORY='/run/credentials/jgw-talk.service';const original=process.pid;process.stdout.write(JSON.stringify({original})+'\\n');await launchService('j-talk','/opt/jgw/bundles');`,
    "jgw-talk",
  );
  const [before, after] = output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(before.original, after.pid);
  assert.equal(after.freshCA, true);
});
