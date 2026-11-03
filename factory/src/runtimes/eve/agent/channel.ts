// The HTTP API the runner talks to. eve fails closed outside `eve dev`, so the built server needs
// an authenticator: HTTP Basic with the password the runner makes per run, on loopback only.
import { httpBasic } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

import { secrets } from "./secrets.ts";

export default eveChannel({
  auth: [httpBasic({ username: "stage", password: secrets().password })],
});
