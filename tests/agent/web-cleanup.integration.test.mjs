import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { hostingRuntime } from "/workspace/j-web/tests/hosting/runtime.mjs";
import { WebServiceCleanup } from "../../deploy/agent/web-cleanup.mjs";
import { execute } from "../../deploy/gateway/gateway.mjs";

let fixture;
const id = randomUUID(),
  account = "jw-" + randomBytes(6).toString("hex"),
  password = randomBytes(24).toString("base64url");
before(async () => {
  if (process.env.JGW_AGENT_TEST_RUNTIME !== "isolated-cloud")
    throw new Error("Explicit isolated root helper test required; no skip.");
  fixture = await hostingRuntime("agent-web-cleanup");
  await execute("docker", [
    "cp",
    process.execPath,
    fixture.container + ":/run/jgw-test-node",
  ]);
  await fixture.exec(["chown", "root:root", "/run/jgw-test-node"]);
  await fixture.exec(["chmod", "0555", "/run/jgw-test-node"]);
  await fixture.exec(["mv", "/run/jgw-test-node", "/usr/local/bin/node"]);
  assert.equal(
    (await fixture.exec(["/usr/bin/node", "--version"])).output.trim(),
    process.version,
  );
  await execute("docker", [
    "cp",
    "/workspace/j-web/deploy/jweb-helper.mjs",
    fixture.container + ":/usr/local/sbin/jweb-helper",
  ]);
  await fixture.exec(["chown", "root:root", "/usr/local/sbin/jweb-helper"]);
  await fixture.exec(["chmod", "0555", "/usr/local/sbin/jweb-helper"]);
  await execute("docker", [
    "cp",
    "/workspace/j-groupware/deploy/agent/provision-error.mjs",
    fixture.container + ":/run/provision-error.mjs",
  ]);
  await execute("docker", [
    "cp",
    "/workspace/j-groupware/deploy/agent/web-cleanup.mjs",
    fixture.container + ":/run/web-cleanup.mjs",
  ]);
  await fixture.exec([
    "chown",
    "root:root",
    "/run/provision-error.mjs",
    "/run/web-cleanup.mjs",
  ]);
  await fixture.exec([
    "chmod",
    "0600",
    "/run/provision-error.mjs",
    "/run/web-cleanup.mjs",
  ]);
});
after(async () => {
  await fixture?.close();
});
const run = async () =>
  JSON.parse(
    (
      await fixture.exec([
        "/usr/bin/node",
        "--input-type=module",
        "-e",
        "import {WebServiceCleanup} from '/run/web-cleanup.mjs'; process.env.NODE_OPTIONS='--import=/run/malicious.mjs'; process.stdout.write(JSON.stringify(await new WebServiceCleanup().run('j-web')));",
      ])
    ).output,
  );
test("prepares native Web helper, supplied host/TLS keys and inactive SFTP/FTPS units on the real separate fixture disk", async () => {
  await fixture.exec([
    "/bin/sh",
    "-c",
    "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nftables=1.0.6-2+deb12u2 >/dev/null && rm -rf /var/lib/apt/lists/*",
  ]);
  await execute("docker", [
    "cp",
    "/workspace/j-groupware/deploy",
    fixture.container + ":/opt/jgw-native-deploy",
  ]);
  await execute("docker", [
    "cp",
    "/workspace/j-groupware/node_modules/@j-auth/contracts",
    fixture.container + ":/opt/jgw-auth-contracts",
  ]);
  await execute("docker", [
    "cp",
    "/workspace/j-web/deploy",
    fixture.container + ":/opt/jweb-source-deploy",
  ]);
  await execute("docker", [
    "cp",
    "/workspace/j-web/apps/server/dist",
    fixture.container + ":/opt/jweb-source-server",
  ]);
  await fixture.exec(["groupdel", "jweb-sftp"]);
  const script = `process.on('uncaughtException',e=>{process.stdout.write(JSON.stringify({code:e.code,message:e.code==='ERR_MODULE_NOT_FOUND'?e.message:undefined,actual:e.actual?.code,where:e.stack?.split('\\n').slice(1,7)}));process.exitCode=1;});import assert from 'node:assert/strict';import {mkdir,cp,copyFile,chmod,chown,rm,writeFile,readFile,lstat} from 'node:fs/promises';import {createHash} from 'node:crypto';
    await mkdir('/opt/jgw-native/deploy',{recursive:true});await cp('/opt/jgw-native-deploy','/opt/jgw-native/deploy',{recursive:true});
    await mkdir('/opt/jgw-native/node_modules/@j-auth',{recursive:true});await cp('/opt/jgw-auth-contracts','/opt/jgw-native/node_modules/@j-auth/contracts',{recursive:true});
    const {NativeWebHosting}=await import('/opt/jgw-native/deploy/agent/native-web.mjs');
    const base='/opt/jgw-native-bundles/j-web';await mkdir(base+'/apps/server',{recursive:true});await cp('/opt/jweb-source-server',base+'/apps/server/dist',{recursive:true});
    const names=['deploy/jweb-helper.mjs','deploy/hosting/jweb.sudoers','deploy/hosting/sshd_config','deploy/hosting/vsftpd.conf','apps/server/dist/disk-cli.js','apps/server/dist/disk.js'],sourceFiles=[];
    for(const name of names){await mkdir(base+'/'+name.substring(0,name.lastIndexOf('/')),{recursive:true});await copyFile(name.startsWith('deploy/')?'/opt/jweb-source-deploy/'+name.slice(7):'/opt/jweb-source-server/'+name.slice(17),base+'/'+name);await chmod(base+'/'+name,0o644);await chown(base+'/'+name,0,0);sourceFiles.push({path:name,sha256:createHash('sha256').update(await readFile(base+'/'+name)).digest('hex')});}
    await writeFile(base+'/jgw-bundle-files.json',JSON.stringify({service:'j-web',sourceFiles}),{mode:0o644});
    await mkdir('/opt/jgw-web-input',{mode:0o700});
    for(const name of ['ca.crt','ca.key','ftps.crt','ftps.key'])await copyFile('/etc/jweb/tls/'+name,'/opt/jgw-web-input/'+name);
    await copyFile('/etc/ssh/ssh_host_ed25519_key','/opt/jgw-web-input/ssh-key');await chmod('/opt/jgw-web-input/ssh-key',0o600);
    const profile={caCertificate:'/opt/jgw-web-input/ca.crt',caKey:'/opt/jgw-web-input/ca.key',ftpsCertificate:'/opt/jgw-web-input/ftps.crt',ftpsKey:'/opt/jgw-web-input/ftps.key',sshHostKey:'/opt/jgw-web-input/ssh-key',sftpPort:2222,ftpsPort:21,passiveMin:56110,passiveMax:56119,backupMaxBytes:1048576,backupMaxEntries:100};
    const adapter=new NativeWebHosting({tenant:'agent-web-cleanup',bundleRoot:'/opt/jgw-native-bundles',unitRoot:'/run/jgw-native-units',stateRoot:'/run/jgw-native-state',profile});
    process.umask(0o077);await adapter.preflight();await assert.rejects(adapter.prepare(),{code:'installation_file_conflict'});
    // Remove only this fixture's original sshd config. Its already-running daemon
    // keeps the same supplied key; source preparation enables no unit or timer.
    await rm('/etc/jweb/sshd_config');
    assert.equal((await adapter.prepare()).activation,'pending');await adapter.validatePrepared();
    assert.equal((await adapter.prepare()).phase,'web_hosting_prepared');await assert.rejects(adapter.start(),{code:'invalid_activation_target'});
    assert.equal((await lstat('/etc/jweb/ssh_host_ed25519_key')).mode&0o777,0o600);
    const previous=await readFile('/etc/jweb/sshd_config');await writeFile('/etc/jweb/sshd_config','changed');await assert.rejects(adapter.validatePrepared(),{code:'web_installation_conflict'});await writeFile('/etc/jweb/sshd_config',previous);
    process.stdout.write('native-web-prepared-with-real-daemons-and-disk');`;
  assert.equal(
    (await fixture.exec(["/usr/bin/node", "--input-type=module"], script, true))
      .output,
    "native-web-prepared-with-real-daemons-and-disk",
  );
});
test("requires root and a fixed managed Web helper and refuses unrelated cleanup before OS work", async () => {
  await assert.rejects(new WebServiceCleanup().run("j-mail"), {
    code: "cleanup_adapter_unbound",
  });
  await assert.rejects(new WebServiceCleanup().run("j-web"), {
    code: "root_required",
  });
  await fixture.exec(["chmod", "0777", "/usr/local/sbin/jweb-helper"]);
  try {
    const result = await fixture.exec([
      "/usr/bin/node",
      "--input-type=module",
      "-e",
      "import {WebServiceCleanup} from '/run/web-cleanup.mjs'; try {await new WebServiceCleanup().run('j-web'); process.exit(1);} catch(e) {process.stdout.write(e.code);}",
    ]);
    assert.equal(result.output, "unsafe_web_helper");
  } finally {
    await fixture.exec(["chmod", "0555", "/usr/local/sbin/jweb-helper"]);
  }
});
test("removes real fixture accounts and site routes through the installer adapter, preserves manual files in private backups, gateway and idempotence", async () => {
  assert.equal(
    (
      await fixture.helper("site-create", {
        siteId: id,
        domain: "agent-cleanup.jgw.test",
      })
    ).ok,
    true,
  );
  assert.equal(
    (await fixture.helper("account-create", { siteId: id, account, password }))
      .ok,
    true,
  );
  assert.equal((await fixture.helper("nginx-apply", { siteId: id })).ok, true);
  await fixture.protocols({
    action: "ftps-upload",
    account,
    password,
    name: "manual.txt",
    data: "manual-upload-backup-proof",
  });
  await fixture.exec([
    "/usr/bin/node",
    "-e",
    "require('fs').writeFileSync('/run/malicious.mjs',\"import {writeFileSync} from 'node:fs'; writeFileSync('/run/loader-injected','unsafe');\")",
  ]);
  assert.deepEqual(await run(), { service: "j-web", removed: 1 });
  const state = JSON.parse(
    (await fixture.exec(["cat", "/var/lib/jweb/" + id + ".json"])).output,
  );
  assert.equal(
    (
      await fixture.exec([
        "cat",
        "/srv/jweb/backups/" + state.backupId + "/site/public/manual.txt",
      ])
    ).output,
    "manual-upload-backup-proof",
  );
  await fixture.protocols({ action: "ftps-deny", account, password });
  await fixture.protocols({
    action: "https",
    domain: "fixture.jgw.test",
    target: "/",
    data: "gateway-preserved",
  });
  assert.notEqual(
    (await fixture.exec(["test", "-e", "/run/loader-injected"], "", true)).code,
    0,
  );
  assert.deepEqual(await run(), { service: "j-web", removed: 0 });
});

test("retained Web cleanup repairs a lost installer receipt from public helper state and refuses a changed backup or active auxiliary writer", async () => {
  const script =
    "import assert from 'node:assert/strict';import {readFile,writeFile,rm,chmod} from 'node:fs/promises';import {WebServiceCleanup} from '/run/web-cleanup.mjs';const options={tenant:'agent-web-cleanup',stateRoot:'/run/jgw-web-retained',maxBytes:1048576,maxEntries:100,stopped:async()=>true};const adapter=new WebServiceCleanup(options);const first=await adapter.run('j-web');assert.equal(first.data,'retained');await adapter.verifyRetained('j-web',{storageBackup:first.storageBackup});await rm(first.storageBackup);const recovered=await adapter.run('j-web');assert.equal(recovered.storageBackup,first.storageBackup);const receipt=JSON.parse(await readFile(first.storageBackup,'utf8'));const target='/srv/jweb/backups/'+receipt.entries.find(row=>row.path.endsWith('/manual.txt')).path;const bytes=await readFile(target);await writeFile(target,'tampered');await assert.rejects(adapter.verifyRetained('j-web',{storageBackup:first.storageBackup}),{code:'web_retention_conflict'});await writeFile(target,bytes);await adapter.verifyRetained('j-web',{storageBackup:first.storageBackup});await assert.rejects(new WebServiceCleanup({...options,stopped:async()=>false}).verifyRetained('j-web',{storageBackup:first.storageBackup}),{code:'web_writer_active'});process.stdout.write('retention-repair-and-drift-guarded');";
  assert.equal(
    (await fixture.exec(["/usr/bin/node", "--input-type=module", "-e", script]))
      .output,
    "retention-repair-and-drift-guarded",
  );
});
