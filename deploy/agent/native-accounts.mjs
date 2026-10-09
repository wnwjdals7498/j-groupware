import { spawn } from "node:child_process";
import { writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { readControlJson } from "./control-files.mjs";
import { privateDirectory } from "./private-files.mjs";
import { protectedStoragePath } from "./product-storage.mjs";
import { externalPath } from "../gateway/gateway.mjs";
import { serviceDatabase, ProvisionError } from "./service-database.mjs";

const fail = (code) => {
  throw new ProvisionError(code);
};
const name = (service) =>
  service === "j-web" ? "jweb" : "jgw-" + service.slice(2);
const comment = (service) => "J Groupware managed " + service;
async function command(binary, args, allowed = [0]) {
  await protectedStoragePath(binary, false);
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      shell: false,
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "",
      size = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size <= 65536) out += chunk;
      else child.kill("SIGKILL");
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(new ProvisionError("account_command_failed"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (size <= 65536 && allowed.includes(code))
        resolve({ code, out: out.trim() });
      else reject(new ProvisionError("account_command_failed"));
    });
  });
}
async function entry(database, value) {
  const result = await command("/usr/bin/getent", [database, value], [0, 2]);
  if (result.code === 2) {
    if (result.out) fail("invalid_account_observation");
    return null;
  }
  const rows = result.out.split("\n");
  if (rows.length !== 1) fail("invalid_account_observation");
  return rows[0].split(":");
}
function actor(service, row, receipt) {
  if (
    !row ||
    row.length !== 7 ||
    row[0] !== name(service) ||
    !/^[1-9][0-9]*$/.test(row[2]) ||
    !/^[1-9][0-9]*$/.test(row[3]) ||
    row[4] !== comment(service) ||
    row[5] !== "/var/lib/" + name(service) ||
    row[6] !== "/usr/sbin/nologin" ||
    (receipt.uid !== null &&
      (Number(row[2]) !== receipt.uid || Number(row[3]) !== receipt.gid))
  )
    fail("unmanaged_service_account");
  return { uid: Number(row[2]), gid: Number(row[3]) };
}
function group(service, row, gid) {
  if (
    !row ||
    row.length !== 4 ||
    row[0] !== name(service) ||
    Number(row[2]) !== gid ||
    row[3] !== ""
  )
    fail("unmanaged_service_group");
}
export class NativeServiceAccounts {
  constructor({ root, stopped }) {
    externalPath(root);
    if (typeof stopped !== "function") fail("account_stop_check_required");
    Object.assign(this, { root, stopped });
  }
  file(service) {
    serviceDatabase(service);
    return path.join(this.root, service + ".account.json");
  }
  async read(service) {
    try {
      const value = await readControlJson(this.file(service), 4096);
      if (
        !value ||
        Object.keys(value).sort().join(",") !==
          "format,gid,name,phase,service,uid" ||
        value.format !== 1 ||
        value.service !== service ||
        value.name !== name(service) ||
        !["creating", "ready", "removing", "removed"].includes(value.phase) ||
        !(value.phase === "creating"
          ? value.uid === null && value.gid === null
          : Number.isSafeInteger(value.uid) &&
            value.uid > 0 &&
            Number.isSafeInteger(value.gid) &&
            value.gid > 0)
      )
        fail("invalid_account_receipt");
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  async write(service, value) {
    await privateDirectory(this.root);
    const file = this.file(service),
      tmp = file + "." + randomUUID() + ".partial";
    try {
      await writeFile(tmp, JSON.stringify(value) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      await rename(tmp, file);
    } finally {
      await rm(tmp, { force: true });
    }
  }
  async ensure(service) {
    serviceDatabase(service);
    if (process.getuid() !== 0) fail("root_required");
    await protectedStoragePath(this.root, true);
    let receipt = await this.read(service),
      existing = await entry("passwd", name(service));
    if (!receipt) {
      if (existing || (await entry("group", name(service))))
        fail("unmanaged_service_account");
      receipt = {
        format: 1,
        service,
        name: name(service),
        uid: null,
        gid: null,
        phase: "creating",
      };
      // Intent precedes useradd; crash recovery accepts only the exact managed comment/home/shell.
      await this.write(service, receipt);
    }
    if (!["creating", "ready"].includes(receipt.phase))
      fail("removed_account_requires_review");
    if (!existing) {
      if (receipt.phase !== "creating" || (await entry("group", name(service))))
        fail("service_account_drift");
      await command("/usr/sbin/useradd", [
        "--system",
        "--user-group",
        "--no-create-home",
        "--home-dir",
        "/var/lib/" + name(service),
        "--shell",
        "/usr/sbin/nologin",
        "--comment",
        comment(service),
        "--",
        name(service),
      ]);
      existing = await entry("passwd", name(service));
    }
    const identity = actor(service, existing, receipt);
    group(service, await entry("group", name(service)), identity.gid);
    receipt = { ...receipt, ...identity, phase: "ready" };
    await this.write(service, receipt);
    return identity;
  }
  async remove(service) {
    serviceDatabase(service);
    if (service === "j-groupware") fail("invalid_action");
    if (process.getuid() !== 0) fail("root_required");
    if ((await this.stopped(service)) !== true) fail("account_writer_active");
    const receipt = await this.read(service),
      existing = await entry("passwd", name(service));
    if (!receipt) {
      if (existing || (await entry("group", name(service))))
        fail("unmanaged_service_account");
      return { account: "absent" };
    }
    if (receipt.phase === "removed") {
      if (existing || (await entry("group", name(service))))
        fail("unmanaged_service_account");
      return { account: "removed" };
    }
    if (!["ready", "removing"].includes(receipt.phase))
      fail("incomplete_account_requires_review");
    if (existing) actor(service, existing, receipt);
    const observedGroup = await entry("group", name(service));
    if (observedGroup) group(service, observedGroup, receipt.gid);
    const all = await command("/usr/bin/getent", ["passwd"]);
    for (const row of all.out.split("\n").map((line) => line.split(":"))) {
      if (row.length !== 7) fail("invalid_account_observation");
      if (
        row[0] !== name(service) &&
        (Number(row[2]) === receipt.uid || Number(row[3]) === receipt.gid)
      )
        fail("shared_service_identity");
    }
    const processes = await command(
      "/usr/bin/pgrep",
      ["-u", String(receipt.uid)],
      [0, 1],
    );
    if (processes.code !== 1 || processes.out) fail("account_processes_active");
    if ((await this.stopped(service)) !== true) fail("account_writer_active");
    await this.write(service, { ...receipt, phase: "removing" });
    if (existing) await command("/usr/sbin/userdel", ["--", name(service)]);
    const remaining = await entry("group", name(service));
    if (remaining) {
      group(service, remaining, receipt.gid);
      await command("/usr/sbin/groupdel", ["--", name(service)]);
    }
    if (
      (await entry("passwd", name(service))) ||
      (await entry("group", name(service)))
    )
      fail("account_removal_incomplete");
    await this.write(service, { ...receipt, phase: "removed" });
    // No userdel -r: compiled bundles, data and private backup bytes are retained.
    return { account: "removed" };
  }
}
