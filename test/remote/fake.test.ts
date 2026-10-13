import { FakeStorage } from "../../src/remote/fake.ts";
import { storageContract } from "./contract.ts";

storageContract("fake", async (clock) => ({ storage: new FakeStorage({ now: clock.now }), cleanup: async () => {} }));
