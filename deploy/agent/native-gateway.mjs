import path from "node:path";
import { readControlFile } from "./control-files.mjs";
import { parseUnitObservation } from "./unit-observation.mjs";
import { protectedStoragePath } from "./product-storage.mjs";
import { execute, externalPath } from "../gateway/gateway.mjs";
import { ProvisionError } from "./provision-error.mjs";
const env = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" };
export function renderGatewayUnit() {
  return "[Unit]\nDescription=J Groupware Nginx gateway\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=forking\nPIDFile=/etc/nginx/nginx.pid\nExecStartPre=/usr/sbin/nginx -t -c /etc/nginx/nginx.conf\nExecStart=/usr/sbin/nginx -c /etc/nginx/nginx.conf\nExecReload=/usr/sbin/nginx -s reload -c /etc/nginx/nginx.conf\nExecStop=/bin/kill -s QUIT $MAINPID\nKillMode=mixed\nTimeoutStopSec=30\nUMask=0027\n\n[Install]\nWantedBy=multi-user.target\n";
}
// Own unit uses the gateway renderer's PID path. Never starts/replaces the
// distribution nginx.service or adopts another active Nginx instance.
export class NativeGateway {
  constructor({ unitRoot }) {
    externalPath(unitRoot);
    this.unitRoot = unitRoot;
  }
  async observe(name) {
    return parseUnitObservation(
      await execute(
        "/usr/bin/systemctl",
        [
          "show",
          name,
          "--all",
          "--no-pager",
          "--property=LoadState,FragmentPath,ActiveState",
        ],
        { env },
      ),
    );
  }
  async preflight() {
    if (process.getuid() !== 0) throw new ProvisionError("root_required");
    await protectedStoragePath("/usr/bin/systemctl", false);
    if (
      (await readControlFile(path.join(this.unitRoot, "jgw-gateway.service"), {
        privateFile: false,
      })) !== renderGatewayUnit()
    )
      throw new ProvisionError("gateway_unit_conflict");
    const distribution = await this.observe("nginx.service");
    if (!["inactive", "failed"].includes(distribution.ActiveState))
      throw new ProvisionError("unmanaged_gateway_active");
    const owned = await this.observe("jgw-gateway.service");
    if (
      owned.LoadState !== "loaded" ||
      owned.FragmentPath !== path.join(this.unitRoot, "jgw-gateway.service")
    )
      throw new ProvisionError("gateway_unit_conflict");
    return owned;
  }
  async ensureRunning() {
    if (this.unitRoot !== "/etc/systemd/system")
      throw new ProvisionError("invalid_activation_target");
    const observation = await this.preflight();
    if (observation.ActiveState !== "active")
      await execute(
        "/usr/bin/systemctl",
        ["enable", "--now", "jgw-gateway.service"],
        { env },
      );
  }
  async reload() {
    if (this.unitRoot !== "/etc/systemd/system")
      throw new ProvisionError("invalid_activation_target");
    const observation = await this.preflight();
    if (observation.ActiveState === "active")
      await execute("/usr/bin/systemctl", ["reload", "jgw-gateway.service"], {
        env,
      });
    else await this.ensureRunning();
  }
}
