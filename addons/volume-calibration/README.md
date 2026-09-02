# volume-calibration

The Volume Calibration wizard as an addon: a page served by the HTP-1 at
`/addons/volume-calibration/`, opened from the Addons page. It derives
Reference Output Voltage, Maximum Digital Headroom, Maximum Volume and Zero
Point from the user's amplifier and measured chain demand, keeps a
calibration record at `/cal/vcal` in the MSO, and flags drift when the Dirac
filter or processing chain changes. Nothing is written without explicit user
action.

| | |
|---|---|
| `src/calibration/` | The solver, gain model, BEQ allowance, tone schedule and sweep engine, with their specs |
| `src/use/` | `useVolumeCalibration` (wizard state, the record, drift) and `useSweep` (the engine wired to the unit) |
| `src/components/` | The status panel, the wizard and its steps, and Sweep Lab |
| `www/` | The built page; produced by `npm run build`, not committed |

Routes on the page: `#/` the status panel, `#/wizard` the wizard,
`#/sweep-lab` the sweep engine's development harness.

## Shared code

The page talks to the unit through the same composables as the main UI:
`useMso` (the `/ws/controller` connection and MSO patching), `useSpeakerGroups`,
`useLocalStorage` (the dark mode choice carries over) and the Peak Monitor's
`vuDecode`, plus its `main.css`. They are not copied here: the controller
repository is a pinned dependency, and `@/` resolves into it. `~/` resolves to
this addon's own source. Bump the pin in `package.json` when the controller
changes something the wizard relies on.

The controller repository is private, so `npm install` needs git access to
it; the release tarballs are built where that access exists.

## Build and test

```
npm install
npm test
npm run build
```

`tools/pack.sh volume-calibration` runs the build and packs `www/` with the
manifest. For development against a unit, `HTP1_HOST=<address> npm run dev`
proxies the websocket and `config.json` to it.
