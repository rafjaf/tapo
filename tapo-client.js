// Extend the factory shared by the library's KLAP and legacy transports.
// This runtime-only extension leaves node_modules untouched and survives npm ci.
const tapoDevice = require("tp-link-tapo-connect/dist/tapo-device");
const originalFactory = tapoDevice.TapoDevice;

tapoDevice.TapoDevice = (protocol) => ({
  ...originalFactory(protocol),
  getCountdownRules: () => protocol.send({
    method: "get_countdown_rules",
    params: { start_index: 0 },
  }),
  async setOffTimer(minutes) {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) {
      throw new Error("Timer must be an integer from 1 to 120 minutes");
    }
    // Devices hold one countdown. Replacing it also permits resetting a timer.
    // https://github.com/cB-Sigma/tplink/blob/main/taporules.go
    await protocol.send({
      method: "remove_countdown_rules",
      params: { remove_all: true },
    });
    // delay/remain are seconds; desired_states.on is the eventual power state.
    // https://github.com/fishbigger/TapoP100/blob/main/PyP100/PyP100.py
    const seconds = minutes * 60;
    return protocol.send({
      method: "add_countdown_rule",
      params: {
        delay: seconds,
        desired_states: { on: false },
        enable: true,
        remain: seconds,
      },
    });
  },
});

module.exports = require("tp-link-tapo-connect");
