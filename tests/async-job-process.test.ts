import assert from "node:assert/strict";
import test from "node:test";
import { probeAsyncJobProcessIdentity } from "../extensions/_shared/async-job-process.js";

const identity = { pid: 4242, processToken: "owned-token", processStartToken: "darwin:expected" };

test("exact process identity probe distinguishes alive, dead, and ambiguous observations", () => {
  assert.equal(probeAsyncJobProcessIdentity(identity, {
    probePid: () => "alive",
    readStartToken: () => identity.processStartToken,
    ownedProcessIds: () => [identity.pid]
  }), "alive");
  assert.equal(probeAsyncJobProcessIdentity(identity, {
    probePid: () => "dead",
    readStartToken: () => { throw new Error("must not read"); },
    ownedProcessIds: () => { throw new Error("must not enumerate"); }
  }), "dead");
  assert.equal(probeAsyncJobProcessIdentity(identity, {
    probePid: () => "alive",
    readStartToken: () => undefined,
    ownedProcessIds: () => [identity.pid]
  }), "unknown", "a transient ps/start-token failure while the pid exists is not proof of death");
  assert.equal(probeAsyncJobProcessIdentity(identity, {
    probePid: () => "alive",
    readStartToken: () => identity.processStartToken,
    ownedProcessIds: () => { throw new Error("transient token enumeration failure"); }
  }), "unknown");
  assert.equal(probeAsyncJobProcessIdentity(identity, {
    probePid: () => "alive",
    readStartToken: () => "darwin:replacement",
    ownedProcessIds: () => [identity.pid]
  }), "dead", "a reused pid with another start token is not the exact supervisor");

  assert.equal(probeAsyncJobProcessIdentity(identity, {
    probePid: () => "unknown",
    readStartToken: () => "darwin:replacement",
    ownedProcessIds: () => { throw new Error("must not enumerate a reused pid"); }
  }), "dead", "an EPERM-like PID probe still compares the start token and rejects a stale cross-user identity");
  assert.equal(probeAsyncJobProcessIdentity(identity, {
    probePid: () => "unknown",
    readStartToken: () => identity.processStartToken,
    ownedProcessIds: () => { throw new Error("cross-user environment remains unreadable"); }
  }), "unknown", "a matching start token with unreadable ownership evidence remains recovery-required");
});
