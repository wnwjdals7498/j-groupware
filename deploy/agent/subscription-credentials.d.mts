export class FileSubscriptionCredentials {
  constructor(file: string);
  read(): Promise<{ bearer: string; serviceKey: string }>;
}
