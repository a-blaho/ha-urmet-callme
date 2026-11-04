// The pieces of the camera pipeline that both video services (video.ts for Ipercom, twoVoiceStation.ts for
// 2Voice) share: the per-camera FIFO pair the media helper writes and stream.sh's ffmpeg reads, and the
// loopback HTTP control endpoint stream.sh and the helper call back into. The per-family call control
// stays in the services; only one of them runs at a time (index.ts).
import { execFileSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { logger } from "./logger.js";

const log = logger("camera");

export type ControlHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

/** (Re)create the given paths as real FIFOs. The helper opens them O_RDWR|O_CREAT, so without a FIFO
 *  already there O_CREAT would make a plain file; a stale FIFO from a previous run is replaced. */
export function makeFifos(...paths: string[]): void {
  for (const p of paths) {
    try {
      unlinkSync(p);
    } catch {
      /* not there */
    }
    execFileSync("mkfifo", [p]);
  }
}

/** Bind the control endpoint on 127.0.0.1 and an EPHEMERAL port (0): the OS picks a free one, so a
 *  host-network clash on a fixed port (8099 was taken by Zigbee2MQTT on a real install) can't happen.
 *  The port is handed to stream.sh (argv $3) and the helper (RECV_*_URL). Resolves once listening. */
export function listenControl(
  handler: ControlHandler,
  tag: string,
): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => void handler(req, res));
  // Without an 'error' handler an EADDRINUSE (e.g. a respawn race) is an unhandled 'error' event
  // that crashes the process.
  server.on("error", (e) => log.error(`${tag} error: ${(e as Error).message}`));
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      log.info(`${tag} on 127.0.0.1:${port}`);
      resolve({ server, port });
    });
  });
}
