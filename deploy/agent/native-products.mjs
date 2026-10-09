import { NativeSystemdPlatform } from "./native-platform.mjs";
import { ProvisionError } from "./provision-error.mjs";

// Product auxiliaries share the native service/account lifecycle. Prepared
// bindings do not activate anything at construction time.
export class NativeProductsPlatform extends NativeSystemdPlatform {
  constructor({ web, mailpit, mailEgress, ...options }) {
    super(options);
    Object.assign(this, { web, mailpit, mailEgress });
  }
  auxiliary(service) {
    return service === "j-web"
      ? this.web
      : service === "j-mail"
        ? this.mailpit
        : undefined;
  }
  async preflight(service) {
    await super.preflight(service);
    if (service === "j-web") {
      if (!this.web)
        throw new ProvisionError("web_native_installation_unbound");
      await this.web.preflight();
    }
    if (service === "j-mail") {
      if (!this.mailpit) throw new ProvisionError("mailpit_adapter_unbound");
      if (!this.mailEgress) throw new ProvisionError("mail_egress_unbound");
      await this.mailEgress.preflight();
      await this.mailpit.image();
    }
  }
  async install(service) {
    await super.install(service);
    if (service === "j-web") await this.web.prepare();
    if (service === "j-mail") await this.mailEgress.prepare();
  }
  async start(service) {
    if (service === "j-mail") await this.mailEgress.start();
    await this.auxiliary(service)?.start();
    await super.start(service);
  }
  async ready(service) {
    if (service === "j-mail") await this.mailEgress.ready();
    await this.auxiliary(service)?.ready();
    await super.ready(service);
  }
  async stop(service, options) {
    const result = await super.stop(service, options);
    await this.auxiliary(service)?.stop();
    if (!(await this.stopped(service)))
      throw new ProvisionError("product_writer_active");
    return result;
  }
  async stopped(service) {
    if (!(await super.stopped(service))) return false;
    if (service === "j-web") return this.web ? this.web.stopped() : false;
    if (service === "j-mail")
      return this.mailpit ? !(await this.mailpit.inspect())?.running : false;
    return true;
  }
}
