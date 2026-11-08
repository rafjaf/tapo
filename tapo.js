#!/usr/local/bin/node
const { readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");
const { parseEnv } = require("node:util");

const configPath = join(homedir(), ".config", "tapo.env");

const usage = `Usage: tapo.js [help|off|on|status|1-120]

  help     Show this help (also -h or --help).
  off      Turn the lamp off (default).
  on       Turn the lamp on.
  status   Show the lamp's on/off state and any running countdown timer.
  1-120    Set an off timer in minutes, replacing any existing countdown.
           The lamp's current state is unchanged. The timer runs on the device.

Configuration: ~/.config/tapo.env
Required: EMAIL, PASSWORD, DEVICE_IP
Optional ntfy: NTFY_URL, NTFY_TOPIC, NTFY_USER, NTFY_PASSWORD`;

function parseCommand(args) {
  if (args.length > 1) throw new Error(`Expected one argument.\n${usage}`);
  const command = (args[0] ?? "off").toLowerCase();
  if (["help", "-h", "--help"].includes(command)) return "help";
  if (["on", "off", "status"].includes(command)) return command;
  if (/^\d+$/.test(command) && Number(command) >= 1 && Number(command) <= 120) {
    return Number(command);
  }
  throw new Error(`Expected help, off, on, status or an integer from 1 to 120.\n${usage}`);
}

async function getTimerStatus(device) {
  try {
    const countdown = await device.getCountdownRules();
    if (!Array.isArray(countdown?.rule_list)) {
      throw new Error("Device response did not include countdown rules");
    }
    if (countdown.enable === false || countdown.enable === 0) return "No running timer";
    const enabled = countdown.rule_list.filter((rule) => rule.enable === true || rule.enable === 1);
    if (enabled.some((rule) => !Number.isInteger(rule.remain) || rule.remain < 0)) {
      throw new Error("Device response did not include a valid remaining time");
    }
    const running = enabled.filter((rule) => rule.remain > 0);
    if (!running.length) return "No running timer";
    return running.map((rule) => `Timer running (${Math.floor(rule.remain / 60)}m ${rule.remain % 60}s remaining)`).join("\n");
  } catch (error) {
    return `Timer status unavailable: ${error.message}`;
  }
}

function createReporter(config, { fetchImpl = globalThis.fetch, logger = console } = {}) {
  return async (message, isError = false) => {
    logger[isError ? "error" : "log"](message);
    const { NTFY_URL, NTFY_TOPIC, NTFY_USER, NTFY_PASSWORD } = config;
    if (!NTFY_URL && !NTFY_TOPIC) return;

    try {
      if (!NTFY_URL || !NTFY_TOPIC) {
        throw new Error("both NTFY_URL and NTFY_TOPIC must be defined");
      }
      if (NTFY_PASSWORD && !NTFY_USER) {
        throw new Error("NTFY_PASSWORD requires NTFY_USER");
      }
      const url = new URL(`${NTFY_URL.replace(/\/+$/, "")}/${encodeURIComponent(NTFY_TOPIC)}`);
      if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error("NTFY_URL must use http or https");
      }
      const headers = {
        "Content-Type": "text/plain; charset=utf-8",
        Title: "Tapo",
        Tags: isError ? "warning" : "bulb",
      };
      if (NTFY_USER) {
        headers.Authorization = `Basic ${Buffer.from(`${NTFY_USER}:${NTFY_PASSWORD ?? ""}`).toString("base64")}`;
      }
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: message,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      // Notification failures must not hide the device result or cause a retry.
      logger.error(`Warning: ntfy notification failed: ${error.message}`);
    }
  };
}

async function main(args = process.argv.slice(2), options = {}) {
  const path = options.configPath ?? configPath;
  let config = {};
  let configError;
  try {
    config = parseEnv(readFileSync(path, "utf8"));
  } catch (error) {
    configError = error;
  }
  const report = createReporter(config, options);

  try {
    const command = parseCommand(args);
    if (command === "help") {
      await report(usage);
      return 0;
    }
    if (configError) {
      throw new Error(`Cannot read ${path}: ${configError.code ?? configError.message}`);
    }
    const { EMAIL, PASSWORD, DEVICE_IP } = config;
    const missing = Object.entries({ EMAIL, PASSWORD, DEVICE_IP })
      .filter(([, value]) => !value)
      .map(([key]) => key);
    if (missing.length) throw new Error(`Missing ${missing.join(", ")} in ${path}`);

    const login = options.loginDeviceByIp ?? require("./tapo-client").loginDeviceByIp;
    const device = await login(EMAIL, PASSWORD, DEVICE_IP);
    if (command === "status") {
      const info = await device.getDeviceInfo();
      if (typeof info.device_on !== "boolean") {
        throw new Error("Device response did not include an on/off state");
      }
      const timerStatus = await getTimerStatus(device);
      await report(`Lamp at ${DEVICE_IP} is ${info.device_on ? "on" : "off"}\n${timerStatus}`);
    } else if (typeof command === "number") {
      await device.setOffTimer(command);
      await report(`Lamp at ${DEVICE_IP}: off timer set for ${command} minute${command === 1 ? "" : "s"} (current state unchanged)`);
    } else {
      await device[command === "on" ? "turnOn" : "turnOff"]();
      await report(`Lamp at ${DEVICE_IP} turned ${command}`);
    }
    return 0;
  } catch (error) {
    await report(`Error: ${error.message}`, true);
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = { main, parseCommand, createReporter };
