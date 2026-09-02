# Addon format

An addon is a directory installed at `/var/lib/olympia/addons/<id>/` by the
firmware's `addonctl`, and read by the firmware's addon registry, which turns
the manifest into an input, a Services switch and unit control. Nothing in
`/opt/olympia` is edited: the firmware reaches the addon through the manifest
and through symlinks it creates itself, so a firmware update leaves an
installed addon in place and removing the addon returns the unit to stock.

## Layout

```
<id>/
  addon.json      manifest
  bin/            executables; made executable on install
  etc/            configuration read by bin/
  units/          systemd units, registered by absolute path
  units/<unit>.d/ drop-ins for units the addon does not own
  debs/           exact .deb packages, installed offline when not already present
  flows/          Node-RED flow yaml, linked into node-red/flows/ as addon-<id>-<file>
  www/            browser bundle, served at /addons/<id>/
  hooks/          install, uninstall, pre-upgrade, post-update, boot (bash, optional)
  state/          the addon's runtime state; kept when the addon is upgraded
```

`tools/pack.sh` produces the tarball `addonctl install` takes: the directory
above, minus `build/` and `tests/`, under a single top-level directory named
`<id>`.

## Manifest

```json
{
  "id": "airplay",
  "version": "0.1.0",
  "label": "AirPlay",
  "summary": "AirPlay 2 receiver (shairport-sync 4.3.7 with nqptp)",
  "requires": { "firmware": ">=2.1.3", "addons": ["receiver-core"] },
  "units": { "airplay.service": "link", "nqptp.service": "link" },
  "service": { "unit": "airplay.service", "process": "shairport-sync", "defaultOn": true },
  "input": { "code": "airplay", "label": "AirPlay", "routesTo": "i2s", "order": 215, "formatDetectOption": "biased" },
  "ui": { "switch": true, "page": null }
}
```

| Field | Meaning |
|---|---|
| `id` | Directory name and switch key. Lower-case letters, digits, hyphens. |
| `version` | Semantic version of the package. |
| `label`, `summary` | Shown on the Addons page and the Services section. |
| `requires.firmware` | Constraint checked against `/var/lib/olympia/swver.txt` at install. |
| `requires.addons` | Addons that must be installed first; removal is refused while a dependant remains. |
| `units` | Unit file name to mode. `link`: registered, started and stopped by the firmware from the switch. `enable`: enabled and started at install, started by systemd at boot. |
| `service.unit` | The unit the switch controls. |
| `service.process` | Process name the session arbiter checks for liveness, matched with `pgrep -x`. |
| `service.defaultOn` | Initial state of the switch the first time the registry sees the addon. |
| `input.code` | Code of the input the registry adds to the input table, marked with `addon: "<id>"`. |
| `input.label`, `order`, `formatDetectOption` | Seeded into the input entry as for any other input. |
| `input.routesTo` | `i2s` for anything that plays into `default:I2S`. Such inputs share one path, so one plays at a time; the arbiter handles that. |
| `ui.switch` | Show a switch on the Services section. |
| `ui.page` | Path of a page the addon serves under `www/`, linked from the Addons page. |

Addons without `service` or `input` (`receiver-core`, a UI-only addon) omit
those fields.

## What the firmware does with it

- Install: unpack, install `debs/` that are not already present, install
  drop-ins, register `units/`, create the `flows/` and `www/` symlinks, run
  `hooks/install`, start `enable` units, then run an MSO fixup so the input
  and switch appear.
- Boot: recreate the symlinks if missing, run `hooks/boot`.
- After a firmware update: re-register units and drop-ins, recreate the
  symlinks, run `hooks/post-update`.
- Remove: run `hooks/uninstall`, stop and unregister units, remove drop-ins
  and symlinks, remove packages no other addon ships, delete the directory.
  The next fixup drops the input and switch.

Hooks receive `ADDON_ID`, `ADDON_DIR`, `ADDONS_DIR` and `OLYMPIA` in the
environment.

## Constraints

- Node-RED runs on Node 9.5.0; anything under `flows/` is bound by that.
- Binaries are armv7 against Debian 9 (glibc 2.24). `build/` holds the
  Docker recipe that produced each one.
- `/var/log` is a 50 MB log2ram partition. Log to the journal or rotate.
- All unit control is `--no-block`; a unit that fails to start must not
  stall the firmware.
