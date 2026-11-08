`tapo.js` controls a TP-Link Tapo lamp on your local network from the command line.
Use it to turn the lamp on or off, check its power and timer status, or schedule it
to turn off after 1–120 minutes. It can also send its messages to ntfy.

Requires Node.js 20.12 or newer and a Tapo lamp already configured in the Tapo app,
reachable on your local network. Use your TP-Link account credentials and the
lamp's local IP address in the configuration file below.

```sh
git clone https://github.com/rafjaf/tapo.git
cd tapo
npm ci
```

Copy `tapo.env.example` to `~/.config/tapo.env` and fill in the Tapo credentials
and device IP:

```sh
mkdir -p ~/.config
cp tapo.env.example ~/.config/tapo.env
chmod 600 ~/.config/tapo.env
```

```sh
node tapo.js help
node tapo.js          # Turn off (default)
node tapo.js off
node tapo.js on
node tapo.js status   # Current on/off state and any running countdown
node tapo.js 30       # Turn off in 30 minutes; leave the current state unchanged
```

Timers accept whole minutes from 1 through 120. The countdown runs on the device,
so the script exits once it is set. Setting a timer replaces an existing countdown.
If the device rejects creating the new countdown after the old one was removed,
the command reports an error and the old countdown is no longer active.

The small runtime extension in `tapo-client.js` adds countdown support through the
library's existing authenticated transport; it changes no installed library files.
It follows [PyP100's countdown request](https://github.com/fishbigger/TapoP100/blob/main/PyP100/PyP100.py)
and [tplink's countdown replacement](https://github.com/cB-Sigma/tplink/blob/main/taporules.go).
The dependency is pinned to 2.0.15 because the extension uses its internal device
factory. Timer support depends on the device/firmware.

`status` reads the device's countdown rules and reports any enabled timer with its
remaining minutes and seconds, or `No running timer`. Disabled and expired timers
are excluded. If the query fails or the firmware does not support it, the power
state is still shown alongside `Timer status unavailable` and the reason.
This uses the read-only `get_countdown_rules` request, also used by
[python-kasa](https://github.com/python-kasa/python-kasa/blob/master/devtools/helpers/smartrequests.py).

To mirror script messages (including help and errors) to ntfy, set `NTFY_URL`
(the server base URL, e.g. `https://ntfy.sh`) and `NTFY_TOPIC` in the same env file.
Optionally set `NTFY_USER` and `NTFY_PASSWORD` for
[HTTP Basic authentication](https://docs.ntfy.sh/publish/#authentication).
Leaving both URL and topic blank disables notifications. Publishing failures or
incomplete ntfy settings produce a console warning without changing the device
command's exit code. Requests time out after 10 seconds.

Run `npm test` for tests using mocked device and notification calls.

Released under the [ISC license](LICENSE).
