// Child-process helpers shared by the services that supervise liblinphone helpers / go2rtc.

/** The slice of ChildProcess these helpers read: a test's fake child implements it too. */
export interface ChildLike {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  once(event: "exit", cb: () => void): unknown;
}

/** True while the child is running (spawned and not yet exited). */
export function isAlive<T extends ChildLike>(child?: T): child is T {
  return !!child && child.exitCode === null && child.signalCode === null;
}

/** Resolve true when the child exits, false if it is still running after `timeoutMs`. Used at
 *  shutdown so a helper that is sending its in-dialog BYE (recv/station do that on SIGTERM) gets
 *  to finish before the container is torn down -- otherwise the panel keeps the call "busy" until
 *  its own session timer. Resolves immediately for a child that already exited. */
export function waitForExit(
  child: ChildLike | undefined,
  timeoutMs: number,
): Promise<boolean> {
  if (!isAlive(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
