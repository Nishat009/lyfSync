import type { Config } from "./config";
import type { Mailer } from "./services/mailer";
import type { PushSender } from "./services/push";

/** Dependencies shared by all routers. */
export interface AppContext {
  config: Config;
  mailer: Mailer;
  push: PushSender;
  log: (msg: string, err?: unknown) => void;
}
