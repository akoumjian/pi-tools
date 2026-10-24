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
});
