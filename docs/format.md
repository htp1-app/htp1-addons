# Addon format

An addon is a directory installed at `/var/lib/olympia/addons/<id>/` by the
firmware's `addonctl`, and read by the firmware's addon registry, which turns
the manifest into an input, a switch on the Addons page and unit control.
Nothing in `/opt/olympia` is edited: the firmware reaches the addon through
the manifest and through symlinks it creates itself, so a firmware update
leaves an installed addon in place and removing the addon returns the unit
to stock.

Units find addons through a catalog: an `index.json` published by an addon
repository. The web UI's Addons page reads it through the unit, and installs
and removes with a click.

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

`tools/pack.sh` produces the tarball `addonctl install` takes: the runtime
files above under a single top-level directory named `<id>`. An addon with a
`package.json` is built first, so `www/` is never committed.

## Manifest

```json
{
  "id": "airplay",
  "version": "0.2.0",
  "label": "AirPlay",
  "summary": "AirPlay 2 receiver (shairport-sync 4.3.7 with nqptp)",
  "requires": { "capabilities": ["source/1"] },
  "units": { "airplay.service": "link", "nqptp.service": "link" },
  "service": { "unit": "airplay.service", "defaultOn": true },
  "input": { "code": "airplay", "label": "AirPlay", "routesTo": "i2s", "order": 215,
             "formatDetectOption": "biased", "release": "restart", "shield": true },
  "ui": { "switch": true, "page": null }
}
```

| Field | Meaning |
|---|---|
| `id` | Directory name and switch key. Lower-case letters, digits, hyphens. `catalog`, `install`, `remove`, `refresh` and `source` are taken by the endpoints. |
| `version` | Semantic version of the package. |
| `published` | `false` keeps a work-in-progress addon out of the catalog: `tools/index.sh` neither packs nor lists it, and a unit ignores such an entry if it meets one. Absent means published. |
| `label`, `summary` | Shown on the Addons page. |
| `requires.capabilities` | What the addon needs from the firmware beyond installation, such as `source/1` (below). A unit without one refuses the install and the Addons page says so. |
| `requires.addons` | Addons that must be installed first; removal is refused while a dependant remains. |
| `requires.firmware` | Constraint checked against `/var/lib/olympia/swver.txt` at install. Prefer a capability. |
| `units` | Unit file name to mode. `link`: registered, started and stopped by the firmware from the switch. `enable`: enabled and started at install, started by systemd at boot. A unit the system or another addon already provides is refused. |
| `service.unit` | The unit the switch controls; one of `units`. |
| `service.defaultOn` | Initial state of the switch the first time the registry sees the addon. |
| `input.code` | Code of the input the registry adds to the input table, marked with `addon: "<id>"`. Lower-case letters, digits, hyphens; a code the unit or another addon uses is refused. |
| `input.label`, `order`, `formatDetectOption` | Seeded into the input entry as for any other input. |
| `input.routesTo` | `i2s`: the addon plays into `default:I2S`, which one player at a time can open. |
| `input.release` | `restart`: restart `service.unit` when the input is deselected or the unit enters standby, ending the sender's session. |
| `input.shield` | `true`: raise the CPU shield while the input is selected and the unit is on. |
| `ui.switch` | Show an on/off switch on the Addons page. |
| `ui.page` | Path of a page the addon serves under `www/`, under `/addons/<id>/`, linked from the Addons page. |

A UI-only or service-only addon omits what it does not use. Every field is
type-checked before anything is installed, and an installed manifest that
fails the checks is shown with its error rather than acted on.

## Audio sources (`source/1`)

An addon whose player writes to `default:I2S` calls
`/opt/olympia/addon-source` from its player's hooks:

- `addon-source start <id>`, synchronously, just before the player opens the
  device for a stream or a resume. The unit selects the input, waking first
  if it has to, and the command returns once the device is free; another
  player holding it is restarted. The latest start wins.
- `addon-source volume <id> <fraction>` as the sender's volume changes, 0 to
  1 of its range. The unit moves its own volume by each change (60 dB for the
  whole range, within its calibrated limits), so starting playback never
  changes the level and a level set with the remote stays until the sender
  moves.
- `addon-source mute <id>` when the sender mutes; moving up again unmutes.

The command always exits 0. The receivers here show the three shapes:
shairport-sync's `sessioncontrol` hooks with `wait_for_completion`, librespot's
`--onevent` with `--emit-sink-events`, and gmediarender with a patched
`--gstout-start-command`. The firmware side is described in its
`docs/development/addon-sources.md`.

## Catalog

`index.json` at the root of the repository, regenerated by `tools/index.sh`
for each release:

```json
{
  "name": "htp1-addons",
  "updated": "2026-09-26T14:58:47Z",
  "addons": [
    {
      "id": "airplay", "version": "0.2.0", "label": "AirPlay",
      "summary": "AirPlay 2 receiver (shairport-sync 4.3.7 with nqptp)",
      "requires": { "capabilities": ["source/1"] },
      "url": "https://github.com/htp1-app/htp1-addons/releases/download/v0.2.0/htp1-addon-airplay-0.2.0.tar.gz",
      "sha256": "51870f63…", "size": 521665
    }
  ]
}
```

The unit's Addons page keeps a list of repositories at
`/svronly/addonRepos`, empty until the user adds one; the firmware suggests
none. A GitHub repository URL means the `index.json` on its main branch; any
other URL is fetched as the index itself. When more than one repository
offers an addon id, the first added wins, and an entry's repository is the
one it came from. Entries with malformed fields are not offered. The unit
fetches the index and the tarballs with its own `curl`, verifies `sha256`
before installing, refuses an entry without one, and refuses a tarball that
is not the id and version its entry names. Dependencies listed in
`requires.addons` are installed first, and an installed dependency older
than the catalog's version is updated on the way.

The unit exposes the catalog and the actions to the web UI:

| Endpoint | Does |
|---|---|
| `GET /addons/catalog` | Fetches every added repository (or only `?repo=`) and returns `{repos: [{repo, url, name, updated, error, addons}]}`, one entry per repository, each with its own error. Each addon carries `installed`, `update` and `missing` (capabilities this firmware lacks). |
| `POST /addons/install` `{"id", "repo", "version", "sha256", "request"}` | Installs the addon and its dependencies from the repository the page showed at the version and checksum it showed; any of the three may be omitted, and a mismatch is refused. `request` is the page's own token for the click: a retry with it is answered with the same operation. Responds at once; progress is published at `/svronly/addonJobs/<id>` as `{state, detail, at, op, finished}` with states `starting`, `downloading`, `installing`, `done`, `error`, kept half a minute after finishing. One install or removal runs at a time; another request meanwhile gets 409. |
| `POST /addons/remove` `{"id", "request"}` | Removes the addon; states `removing`, `removed`, `error`. |
| `GET /addons/operations` | Every recorded install and removal with its state, for a page that reconnects. |
| `POST /addons/refresh` | Brings the MSO's addon entries and inputs in line with the installed manifests, broadcast to every UI, and starts or stops units whose switch changed. Called by `addonctl` after every install or removal. |

## What the firmware does with it

- Install: the unit records the operation, and a runner outside Node-RED
  downloads and verifies the packages and installs them: unpack into a
  staging directory, install `debs/` that are not already present
  (recording which ones in `state/packages`), install drop-ins, register
  `units/`, create the `flows/` and `www/` symlinks, run `hooks/install`,
  start `enable` units. The outcome is recorded before Node-RED is refreshed,
  or restarted for a package that carries `flows/`, since Node-RED reads its
  flows directory only at start.
- Upgrade: the old version's units are stopped (a unit that will not stop
  aborts the upgrade), it is taken out of the system and set aside with its
  `state/` carried over; if the new one fails to activate, the old one is put
  back. Each step is journalled, so an interruption is finished or undone the
  next time `addonctl` runs, at the latest at boot.
- Boot: before the firmware's services start, finish or undo an interrupted
  change and recreate the symlinks if missing, within three minutes. Then,
  alongside the firmware's startup rather than before it, run `hooks/boot`;
  nothing the firmware starts waits for it.
- After a firmware update: re-register units and drop-ins, recreate the
  symlinks, run `hooks/post-update`. If the firmware now provides one of the
  addon's unit names, the firmware's unit wins: the addon's registration
  comes out and the addon is left alone, with the reason on the Addons page,
  until an update or reinstall clears the conflict.
- Flows are checked before they are linked, at install, boot and after a
  firmware update: every node type must be one the unit's Node-RED has,
  every `subflow:` must be defined, and no node id may be used by another
  flow file (ids are one namespace). Node-RED starts no flow at all when one
  type is missing, so failing flows refuse the install, or later stay
  unlinked, with the reason on the Addons page.
- Each `flows/<file>.yaml` is one tab labelled `addon-<id>-<file>` with every
  node on it: config nodes scoped to that flow, no subflow definitions. A tab
  edited in the unit's Node-RED editor (`/admin`) then saves back into the
  addon's file; copy it out of `/var/lib/olympia/addons/<id>/flows/` into the
  package.
- Remove: stop the units (or refuse), run `hooks/uninstall`, unregister the
  units, remove drop-ins and symlinks, purge the packages the addon installed
  unless another installed addon's record lists them, delete the directory.
  The next fixup drops the input and switch.

Hooks receive `ADDON_ID`, `ADDON_DIR`, `ADDONS_DIR` and `OLYMPIA` in the
environment. Each hook gets two minutes; after that it is killed with its
whole process group, which fails an `install` or `pre-upgrade` hook. Under `node_in_ram` the links are made in the RAM copy of the
Node-RED tree as well as the firmware's.

Versions follow SemVer: `major.minor.patch`, a prerelease such as
`1.0.0-beta.2` sorts below `1.0.0`, and build metadata after `+` is
ignored. The unit decides what counts as an update; the page shows what it
says.

## Constraints

- Node-RED runs on Node 9.5.0; anything under `flows/` is bound by that.
- Binaries are armv7 against Debian 9 (glibc 2.24). `build/` holds the
  Docker recipe that produced each one.
- `/var/log` is a 50 MB log2ram partition. Log to the journal or rotate.
- Unit starts and restarts are `--no-block`; a unit that fails to start must
  not stall the firmware. The one wait is a source's stop when a stock
  player (USB, Bluetooth, Roon) takes the I2S device next, bounded at five
  seconds, so stop promptly on the unit's stop signal.
