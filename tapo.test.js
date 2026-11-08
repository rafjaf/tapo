const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { main } = require("./tapo");
require("./tapo-client");
const { TapoDevice } = require("tp-link-tapo-connect/dist/tapo-device");

function fixture(t, extraConfig = "", device = {}) {
  const directory = mkdtempSync(join(tmpdir(), "tapo-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const configPath = join(directory, "tapo.env");
  writeFileSync(configPath, `EMAIL="user@example.com"\nPASSWORD="spaces and # symbols"\nDEVICE_IP="192.0.2.1"\n${extraConfig}`);
  const calls = [];
  const logs = [];
  const errors = [];
  const notifications = [];
  const options = {
    configPath,
    logger: { log: (text) => logs.push(text), error: (text) => errors.push(text) },
    loginDeviceByIp: async (...args) => {
      calls.push(["login", ...args]);
      return {
        turnOn: async () => calls.push(["on"]),
        turnOff: async () => calls.push(["off"]),
        getDeviceInfo: async () => {
          calls.push(["status"]);
          return { device_on: true };
        },
        getCountdownRules: async () => ({ rule_list: [] }),
        setOffTimer: async (minutes) => calls.push(["timer", minutes]),
        ...device,
      };
    },
    fetchImpl: async (url, request) => {
      notifications.push({ url: url.toString(), ...request });
      return { ok: true };
    },
  };
  return { options, calls, logs, errors, notifications };
}

const ntfyConfig = 'NTFY_URL="https://notify.example/base/"\nNTFY_TOPIC="lamp"\n';

test("on, off and the default perform the selected action and report it", async (t) => {
  for (const args of [[], ["off"], ["on"]]) {
    const f = fixture(t, ntfyConfig);
    assert.equal(await main(args, f.options), 0);
    const action = args[0] ?? "off";
    assert.deepEqual(f.calls, [["login", "user@example.com", "spaces and # symbols", "192.0.2.1"], [action]]);
    assert.deepEqual(f.logs, [`Lamp at 192.0.2.1 turned ${action}`]);
    assert.equal(f.notifications[0].body, f.logs[0]);
    assert.deepEqual(f.errors, []);
  }
});

test("status reads power state without switching the lamp", async (t) => {
  for (const device_on of [true, false]) {
    const f = fixture(t, ntfyConfig, { getDeviceInfo: async () => ({ device_on }) });
    assert.equal(await main(["status"], f.options), 0);
    assert.equal(f.calls.length, 1);
    assert.equal(f.logs[0], `Lamp at 192.0.2.1 is ${device_on ? "on" : "off"}\nNo running timer`);
    assert.equal(f.notifications[0].body, f.logs[0]);
  }
});

test("status reports active timers and remaining time to console and ntfy", async (t) => {
  const requests = [];
  const device = TapoDevice({ send: async (request) => {
    requests.push(request);
    return { enable: true, rule_list: [{ enable: true, remain: 1799 }] };
  } });
  const f = fixture(t, ntfyConfig, { getCountdownRules: device.getCountdownRules });
  assert.equal(await main(["STATUS"], f.options), 0);
  assert.equal(f.logs[0], "Lamp at 192.0.2.1 is on\nTimer running (29m 59s remaining)");
  assert.equal(f.notifications[0].body, f.logs[0]);
  assert.deepEqual(requests, [{ method: "get_countdown_rules", params: { start_index: 0 } }]);
  assert.equal(f.calls.length, 2); // Login and reading power state only.
});

test("status excludes disabled, expired and globally disabled countdowns", async (t) => {
  for (const countdown of [
    { rule_list: [] },
    { rule_list: [{ enable: false, remain: 120 }] },
    { rule_list: [{ enable: true, remain: 0 }] },
    { enable: false, rule_list: [{ enable: true, remain: 120 }] },
  ]) {
    const f = fixture(t, ntfyConfig, { getCountdownRules: async () => countdown });
    assert.equal(await main(["status"], f.options), 0);
    assert.match(f.logs[0], /\nNo running timer$/);
    assert.equal(f.notifications[0].body, f.logs[0]);
  }
});

test("failed or malformed timer queries report unavailable and preserve power status", async (t) => {
  for (const getCountdownRules of [
    async () => { throw new Error("Method not supported"); },
    async () => { throw new Error("Connection lost"); },
    async () => ({}),
    async () => ({ rule_list: [{ enable: true }] }),
  ]) {
    const f = fixture(t, ntfyConfig, { getCountdownRules });
    assert.equal(await main(["status"], f.options), 0);
    assert.match(f.logs[0], /^Lamp at 192.0.2.1 is on\nTimer status unavailable:/);
    assert.doesNotMatch(f.logs[0], /No running timer/);
    assert.equal(f.notifications[0].body, f.logs[0]);
    assert.equal(f.calls.length, 2);
  }
});

test("timer accepts both boundaries and does not turn the lamp on or off", async (t) => {
  for (const minutes of [1, 30, 120]) {
    const f = fixture(t, ntfyConfig);
    assert.equal(await main([String(minutes)], f.options), 0);
    assert.deepEqual(f.calls[1], ["timer", minutes]);
    assert.equal(f.calls.length, 2);
    assert.match(f.logs[0], /current state unchanged/);
    assert.equal(f.notifications[0].body, f.logs[0]);
  }
});

test("invalid arguments fail before login and notify about the error", async (t) => {
  for (const args of [["0"], ["121"], ["-1"], ["1.5"], ["1e2"], ["Infinity"], [""], ["unknown"], ["on", "off"]]) {
    const f = fixture(t, ntfyConfig);
    assert.equal(await main(args, f.options), 1);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.logs, []);
    assert.match(f.errors[0], /^Error:/);
    assert.equal(f.notifications[0].body, f.errors[0]);
  }
});

test("help works without configuration or device login", async (t) => {
  for (const command of ["help", "-h", "--help"]) {
    const f = fixture(t);
    rmSync(f.options.configPath);
    assert.equal(await main([command], f.options), 0);
    assert.match(f.logs[0], /^Usage: tapo.js/);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.errors, []);
  }
});

test("help is mirrored to ntfy when configured", async (t) => {
  const f = fixture(t, ntfyConfig);
  assert.equal(await main(["help"], f.options), 0);
  assert.equal(f.notifications[0].body, f.logs[0]);
  assert.deepEqual(f.calls, []);
});

test("missing configuration and required values prevent device access", async (t) => {
  const f = fixture(t, ntfyConfig);
  writeFileSync(f.options.configPath, ntfyConfig);
  assert.equal(await main([], f.options), 1);
  assert.match(f.errors[0], /Missing EMAIL, PASSWORD, DEVICE_IP/);
  assert.equal(f.notifications[0].body, f.errors[0]);
  assert.deepEqual(f.calls, []);
  rmSync(f.options.configPath);
  assert.equal(await main([], f.options), 1);
  assert.match(f.errors[1], /Cannot read .*ENOENT/);
  assert.deepEqual(f.calls, []);
});

test("login and device errors are notified without reporting success", async (t) => {
  for (const stage of ["login", "off", "timer", "status"]) {
    const fail = async () => { throw new Error(`${stage} failed`); };
    const device = { turnOff: fail, setOffTimer: fail, getDeviceInfo: fail };
    const f = fixture(t, ntfyConfig, device);
    if (stage === "login") f.options.loginDeviceByIp = fail;
    const args = stage === "timer" ? ["30"] : stage === "status" ? ["status"] : [];
    assert.equal(await main(args, f.options), 1);
    assert.deepEqual(f.logs, []);
    assert.equal(f.notifications[0].body, f.errors[0]);
    assert.match(f.errors[0], /failed/);
  }
});

test("status does not present missing power state as off", async (t) => {
  const f = fixture(t, ntfyConfig, { getDeviceInfo: async () => ({}) });
  assert.equal(await main(["status"], f.options), 1);
  assert.deepEqual(f.logs, []);
  assert.match(f.errors[0], /did not include an on\/off state/);
});

test("ntfy uses POST with optional Basic auth, a timeout and no redirects", async (t) => {
  for (const authenticated of [false, true]) {
    const auth = authenticated ? 'NTFY_USER="alice"\nNTFY_PASSWORD="secret:#"\n' : "";
    const f = fixture(t, ntfyConfig + auth);
    assert.equal(await main([], f.options), 0);
    const request = f.notifications[0];
    assert.equal(request.url, "https://notify.example/base/lamp");
    assert.equal(request.method, "POST");
    assert.equal(request.redirect, "error");
    assert.ok(request.signal instanceof AbortSignal);
    assert.equal(request.headers.Authorization, authenticated ? `Basic ${Buffer.from("alice:secret:#").toString("base64")}` : undefined);
  }
});

test("notification failures warn without losing successful device results", async (t) => {
  for (const failure of ["http", "network", "partial config"]) {
    const f = fixture(t, failure === "partial config" ? 'NTFY_URL="https://notify.example"\n' : ntfyConfig);
    f.options.fetchImpl = async () => {
      if (failure === "network") throw new Error("network unavailable");
      return { ok: false, status: 401 };
    };
    assert.equal(await main([], f.options), 0);
    assert.equal(f.calls[1][0], "off");
    assert.match(f.logs[0], /turned off/);
    assert.match(f.errors[0], /^Warning: ntfy notification failed:/);
  }
});

test("optional ntfy settings can be absent", async (t) => {
  const f = fixture(t);
  assert.equal(await main([], f.options), 0);
  assert.deepEqual(f.notifications, []);
  assert.deepEqual(f.errors, []);
});

test("runtime extension uses the real factory and schedules on the device", async () => {
  const requests = [];
  const device = TapoDevice({ send: async (request) => { requests.push(request); return { id: "timer-id" }; } });
  assert.deepEqual(await device.setOffTimer(30), { id: "timer-id" });
  assert.deepEqual(requests, [
    { method: "remove_countdown_rules", params: { remove_all: true } },
    { method: "add_countdown_rule", params: { delay: 1800, desired_states: { on: false }, enable: true, remain: 1800 } },
  ]);
  await device.turnOn();
  assert.equal(requests[2].method, "set_device_info");
  assert.equal(requests[2].params.device_on, true);
});

test("runtime timer validates values before removing an existing countdown", async () => {
  const requests = [];
  const device = TapoDevice({ send: async (request) => requests.push(request) });
  for (const minutes of [0, 121, 1.5, "30", NaN]) {
    await assert.rejects(device.setOffTimer(minutes), /integer from 1 to 120/);
  }
  assert.deepEqual(requests, []);
});

test("timer transport failures propagate and never schedule after removal fails", async () => {
  const requests = [];
  const device = TapoDevice({ send: async (request) => {
    requests.push(request);
    throw new Error("countdown unsupported");
  } });
  await assert.rejects(device.setOffTimer(30), /countdown unsupported/);
  assert.equal(requests.length, 1);
});

test("creating a countdown can fail after removal and is reported as an error", async (t) => {
  const requests = [];
  const device = TapoDevice({ send: async (request) => {
    requests.push(request);
    if (request.method === "add_countdown_rule") throw new Error("countdown rejected");
    return {};
  } });
  const f = fixture(t, ntfyConfig, device);
  assert.equal(await main(["30"], f.options), 1);
  assert.equal(requests.length, 2);
  assert.deepEqual(f.logs, []);
  assert.match(f.errors[0], /countdown rejected/);
  assert.equal(f.notifications[0].body, f.errors[0]);
});
