param(
  [string]$OutputPath = (Join-Path $PSScriptRoot '..\Documentation\Radar Validation Fixture Reusable Tool Documentation.docx')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = Split-Path -Parent $PSScriptRoot
$template = Join-Path $root 'Documentation\Whisker Radar Validation Fixture User Manual.docx'
$output = [IO.Path]::GetFullPath($OutputPath)
$tempOutput = [IO.Path]::GetTempFileName()
Remove-Item -LiteralPath $tempOutput -Force

function XmlEscape([string]$value) {
  if ($null -eq $value) { return '' }
  return [System.Security.SecurityElement]::Escape($value)
}

$body = [Text.StringBuilder]::new()

function Add-Raw([string]$value) {
  [void]$script:body.Append($value)
}

function Run-Xml {
  param(
    [string]$Text,
    [bool]$Bold = $false,
    [bool]$Italic = $false,
    [string]$Color = ''
  )
  $properties = ''
  if ($Bold) { $properties += '<w:b/>' }
  if ($Italic) { $properties += '<w:i/>' }
  if ($Color) { $properties += "<w:color w:val=""$Color""/>" }
  $escaped = XmlEscape $Text
  return "<w:r><w:rPr>$properties</w:rPr><w:t xml:space=""preserve"">$escaped</w:t></w:r>"
}

function Add-Paragraph {
  param(
    [string]$Text,
    [string]$Style = 'BodyText',
    [bool]$Bold = $false,
    [bool]$Italic = $false,
    [string]$Color = '',
    [string]$Shade = ''
  )
  $paragraphProperties = "<w:pStyle w:val=""$Style""/>"
  if ($Shade) { $paragraphProperties += "<w:shd w:val=""clear"" w:fill=""$Shade""/>" }
  Add-Raw "<w:p><w:pPr>$paragraphProperties</w:pPr>$(Run-Xml $Text $Bold $Italic $Color)</w:p>"
}

function Add-Heading1([string]$Text) { Add-Paragraph $Text 'Heading1' }
function Add-Heading2([string]$Text) { Add-Paragraph $Text 'Heading2' }
function Add-Bullet([string]$Text) { Add-Paragraph "- $Text" 'ListParagraph' }
function Add-Number([string]$Text, [int]$Number) { Add-Paragraph "$Number. $Text" 'ListParagraph' }
function Add-Note([string]$Text) { Add-Paragraph $Text 'BodyText' $true $false '173E50' 'E6F1F4' }
function Add-Code([string]$Text) { Add-Paragraph $Text 'CodeBlock' $false $false '172B36' 'F1F4F6' }
function Add-PageBreak() { Add-Raw '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' }

function Add-Table {
  param(
    [string[]]$Headers,
    [object[]]$Rows
  )
  $columnCount = $Headers.Count
  $grid = (1..$columnCount | ForEach-Object { '<w:gridCol w:w="2200"/>' }) -join ''
  Add-Raw "<w:tbl><w:tblPr><w:tblW w:w=""0"" w:type=""auto""/><w:tblLayout w:type=""fixed""/><w:tblBorders><w:top w:val=""single"" w:sz=""5"" w:color=""A8BBC4""/><w:left w:val=""single"" w:sz=""5"" w:color=""A8BBC4""/><w:bottom w:val=""single"" w:sz=""5"" w:color=""A8BBC4""/><w:right w:val=""single"" w:sz=""5"" w:color=""A8BBC4""/><w:insideH w:val=""single"" w:sz=""3"" w:color=""D7E0E7""/><w:insideV w:val=""single"" w:sz=""3"" w:color=""D7E0E7""/></w:tblBorders><w:tblCellMar><w:top w:w=""70"" w:type=""dxa""/><w:left w:w=""90"" w:type=""dxa""/><w:bottom w:w=""70"" w:type=""dxa""/><w:right w:w=""90"" w:type=""dxa""/></w:tblCellMar></w:tblPr><w:tblGrid>$grid</w:tblGrid>"
  $headerCells = foreach ($header in $Headers) {
    "<w:tc><w:tcPr><w:shd w:val=""clear"" w:fill=""2E809B""/></w:tcPr><w:p><w:pPr><w:pStyle w:val=""BodyText""/></w:pPr>$(Run-Xml $header $true $false 'FFFFFF')</w:p></w:tc>"
  }
  Add-Raw "<w:tr>$($headerCells -join '')</w:tr>"
  foreach ($row in $Rows) {
    $cells = @($row) | ForEach-Object {
      "<w:tc><w:p><w:pPr><w:pStyle w:val=""BodyText""/></w:pPr>$(Run-Xml ([string]$_))</w:p></w:tc>"
    }
    Add-Raw "<w:tr>$($cells -join '')</w:tr>"
  }
  Add-Raw '</w:tbl><w:p/>'
}

Add-Raw '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>'

Add-Paragraph 'Radar Validation Fixture' 'Title'
Add-Paragraph 'Reusable Fixture Documentation Package' 'Subtitle'
Add-Paragraph 'Build, operation, software, data, limitations, and maintenance reference' 'Subtitle' $false $true '607D8B'
Add-Paragraph 'Engineering reference | Revision date: August 2026' 'BodyText' $false $false '607D8B'
Add-Note 'Purpose: This document describes the fixture as a reusable engineering tool. It is intentionally broader than a product-specific test procedure: it explains what the fixture does, how it is assembled and commissioned, how operators use it, what it records, and what must still be verified for a particular installation.'
Add-Heading2 'Contents'
Add-Bullet '1. Purpose and scope'
Add-Bullet '2. What the fixture does'
Add-Bullet '3. System architecture'
Add-Bullet '4. Physical fixture and build description'
Add-Bullet '5. Software and configuration'
Add-Bullet '6. Build, installation, and commissioning'
Add-Bullet '7. Operator workflow'
Add-Bullet '8. Data produced'
Add-Bullet '9. Test modes and visual outputs'
Add-Bullet '10. Limitations and remaining next steps'
Add-Bullet '11. Maintenance and reuse procedure'
Add-Bullet 'Appendices: source map, handoff checklist, glossary'
Add-PageBreak

Add-Heading1 '1. Purpose and scope'
Add-Paragraph 'The Radar Validation Fixture is a repeatable motion-and-measurement platform for characterizing and validating radar detection behavior around a device under test (DUT). It moves a reflector or target through commanded X/Y/Z positions, triggers the commissioned reflector mechanism, samples radar detection output, and preserves the result as an auditable local run record.'
Add-Paragraph 'The fixture is reusable because the mechanical platform, control software, radar service, test-plan generator, and data format are separated from any one DUT. A new DUT or radar configuration should be represented through measured geometry, a named DUT location, commissioned limits, and a documented test plan rather than by changing the underlying measurement logic.'
Add-Heading2 'Audience'
Add-Bullet 'Fixture owners and technicians who assemble, wire, commission, or move the platform.'
Add-Bullet 'Operators who run characterization, formal validation, or campaign tests.'
Add-Bullet 'Developers who maintain the Electron application, Raspberry Pi service, Klipper configuration, and result artifacts.'
Add-Heading2 'Scope boundary'
Add-Paragraph 'This package documents the fixture and its control system. It does not establish the product-specific pass/fail requirements for a particular radar, DUT, customer, or regulatory program. Those requirements must be defined in the selected test plan and approved separately.'

Add-Heading1 '2. What the fixture does'
Add-Paragraph 'A normal measurement follows this sequence:'
Add-Number 'Home the fixture and establish a known motion reference.' 1
Add-Number 'Move along a collision-safe route to a planned X/Y/Z point.' 2
Add-Number 'Wait for the configured settle interval and confirm a fresh radar LOW baseline.' 3
Add-Number 'Execute the commissioned reflector trigger macro, normally REFLECTOR_SPIN.' 4
Add-Number 'Poll the active radar output until detection or timeout.' 5
Add-Number 'Record the commanded point, expected result, actual result, latency, motion time, settings, and validity.' 6
Add-Number 'Return the fixture to home at the end of the run or after a controlled abort.' 7
Add-Paragraph 'The application supports two electrical target modes. Dual mode treats Radar A and Radar B as one radar module in the DUT and combines their detection rule as A OR B. Single mode uses the standalone SINGLE radar channel only. The operator selects the layout in the GUI; the selected target controls settings verification, polling, campaign preparation, and report traceability.'
Add-Table @('Capability','Reusable-tool behavior') @(
  @('Motion','Commands X/Y/Z through Klipper and Moonraker with travel limits and collision-safe routing.'),
  @('Radar observation','Reads active OUT input(s), requires a fresh LOW baseline, and never converts an unavailable sample into a valid miss.'),
  @('Plan generation','Creates deterministic formal, characterization, custom, and campaign point plans.'),
  @('Operator safety','Blocks unsafe moves, unverified radar settings, invalid geometry, and runs without required logging.'),
  @('Traceability','Stores the configuration, plan, radar settings, observations, summary, and report together.'),
  @('Recovery','Keeps local HTML and CSV artifacts authoritative when a local background operation fails.')
)

Add-Heading1 '3. System architecture'
Add-Paragraph 'The fixture is a layered system. Hardware-specific privileges stay behind the appropriate boundary so the test semantics and data calculations remain portable.'
Add-Table @('Layer','Responsibilities','Primary assets') @(
  @('Mechanical fixture','Frame, linear axes, reflector/target mechanism, DUT reference, guards, end stops.','Fixture frame and approved mechanical drawings'),
  @('Radar and I/O','MS58-2020D20M4 UART settings, radar OUT signals, gain/threshold state.','Pi GPIO, /dev/serial0, pigpio, radar-settings service'),
  @('Klipper/Moonraker','Motion execution, homing, position reporting, reflector macro, GPIO buttons.','SKR controller, printer.cfg, Moonraker on port 7125'),
  @('Raspberry Pi service','Radar protocol transactions and active-target API.','pi-radar-service/radar_service.py'),
  @('Electron main process','IPC, configuration, Moonraker requests, logging, reports, campaign persistence.','main.js and preload.js'),
  @('Renderer and pure cores','Operator UI, plan generation, classification, visualization, campaign controls.','renderer.js, validation-core.js, campaign modules'),
  @('Artifacts','Raw observations, manifests, summaries, reports, radar snapshots, and local campaign history.','Documents/Radar Validation Logs')
)
Add-Heading2 'Control and measurement flow'
Add-Code 'Operator -> Electron renderer -> preload IPC -> Electron main -> Moonraker/Klipper -> motion and reflector
                                         \-> radar-settings HTTP service -> Pi UART/GPIO -> radar state
Measurement -> renderer observation model -> local CSV/JSON/report -> local campaign history'
Add-Paragraph 'The preload layer exposes a narrow radarAPI object and does not expose Node.js directly to the browser. validation-core.js and radar-settings-core.js are independent of Electron and can be tested without hardware.'

Add-Heading1 '4. Physical fixture and build description'
Add-Heading2 'Mechanical build'
Add-Bullet 'A rigid frame supports the X/Y motion system and the vertical Z or reflector assembly.'
Add-Bullet 'The reflector mechanism is an active, commissioned fixture component. The application expects a safe Klipper macro, normally named REFLECTOR_SPIN, and does not assume that a generic motor command is safe.'
Add-Bullet 'The DUT location is a no-go zone. Automated routing uses visibility-graph corner detours and the main process independently rejects endpoints or segments that enter the DUT footprint.'
Add-Bullet 'The fixture must have verified end stops, measured travel limits, an emergency-stop method, and a repeatable home reference before qualification use.'
Add-Heading2 'Reference geometry'
Add-Table @('Mode or location','Reference') @(
  @('Single sensor','Fixed stand-mounted sensor center defaults to X=875 mm, Y=1200 mm. The calibrated forward depth defaults to 304.8 mm and must be confirmed physically.'),
  @('Dual in-field DUT','DUT footprint X=744..1006 mm, Y=880..1200 mm; center X=875 mm, Y=1040 mm. Individual Radar A/B locations are not used for system-level acceptance geometry.'),
  @('Dual original DUT','Legacy rectangular location X=744..1006 mm, Y=1100..1420 mm; center X=875 mm, Y=1260 mm.'),
  @('Formal system bands','Detection required through 304.8 mm from the nearest DUT edge; intermediate band through 609.6 mm is optional/unscored; no detection is required beyond 609.6 mm.'),
  @('Characterization','The operator supplies an X/Y rectangle; the application generates an exact-count serpentine raster.')
)
Add-Heading2 'Electrical and radar wiring'
Add-Paragraph 'The following assignment is the current Pi 3 commissioning baseline. It uses the existing hardware UART for Radar A and pigpio software UARTs for Radar B and SINGLE, so no USB/UART adapter is required. Confirm that the installed radar TX and OUT levels are 3.3 V compatible before connecting them to Pi GPIO.'
Add-Table @('Physical pin','BCM GPIO','Direction','Connection') @(
  @('8','GPIO14/TXD','Pi -> radar','Radar A RX; hardware UART'),
  @('10','GPIO15/RXD','Radar -> Pi','Radar A TX; hardware UART'),
  @('12','GPIO18','Radar -> Pi','Radar A OUT'),
  @('18','GPIO24','Pi -> radar','Radar B RX; software UART TX'),
  @('22','GPIO25','Radar -> Pi','Radar B TX; software UART RX'),
  @('16','GPIO23','Radar -> Pi','Radar B OUT'),
  @('15','GPIO22','Pi -> radar','SINGLE RX; software UART TX'),
  @('13','GPIO27','Radar -> Pi','SINGLE TX; software UART RX'),
  @('37','GPIO26','Radar -> Pi','SINGLE OUT'),
  @('39','GND','Common','Common radar/Pi ground')
)
Add-Note 'Do not tie TX pins or OUT pins together. GPIO22/27/26 must be checked with gpioinfo and the active Klipper configuration. If the radar module uses a higher logic voltage, stop and obtain an approved level-shifting design before connecting it.'

Add-Heading1 '5. Software and configuration'
Add-Heading2 'Raspberry Pi'
Add-Bullet 'Raspberry Pi 3 runs Klipper/Moonraker and the radar-settings service.'
Add-Bullet 'Radar A uses /dev/serial0 at 9600 baud, 8N1. Radar B and SINGLE use pigpio DMA-timed software UARTs at 9600 baud.'
Add-Bullet 'The service exposes authenticated, narrowly scoped endpoints for query, apply, save, and factory reset. All writes are range-checked and verified by read-back.'
Add-Bullet 'The service configuration is in /etc/default/radar-settings after installation. The source template is pi-radar-service/radar-settings.default.'
Add-Heading2 'Klipper and Moonraker'
Add-Bullet 'Moonraker is the motion and state API used by the desktop application; the expected default port is 7125.'
Add-Bullet 'The printer configuration defines radar OUT signals as gcode_button objects. The current names are radar_sensor_a, radar_sensor_b, and radar_sensor_single.'
Add-Bullet 'The reflector macro is configurable in the GUI but must match the commissioned mechanism. The current expected macro is REFLECTOR_SPIN.'
Add-Heading2 'Desktop application'
Add-Bullet 'main.js owns configuration persistence, Moonraker communication, radar-service requests, logging, run-folder naming, report generation, and campaign persistence.'
Add-Bullet 'renderer.js owns operator state, test execution, plan generation, charts, campaign controls, and preflight display.'
Add-Bullet 'validation-core.js owns geometry, expected outcomes, plan validation, point generation, and summaries.'
Add-Bullet 'campaign-manager.js and campaign-ledger.js maintain configurable run matrices and durable local campaign state.'
Add-Heading2 'Important configuration values'
Add-Table @('Setting','Meaning','Commissioning rule') @(
  @('sensorLayout','dual or single active radar target.','Set to match the physically connected setup before reading or applying radar settings.'),
  @('motion.x/y/z limits','Allowed travel and timeout calculations.','Replace placeholder values with measured safe limits.'),
  @('trigger.macro','Klipper reflector macro name.','Verify the macro physically before qualification.'),
  @('trigger.delayMs / holdMsDefault','Baseline settle and post-trigger timing.','Tune from measured fixture behavior; do not hide failures with long timeouts.'),
  @('radarService.port / apiToken','Pi radar settings service connection.','Use the same port/token on the Pi and desktop configuration.'),
  @('logging.enabled','Whether scored tests may run and raw CSV is written.','Keep enabled for characterization and formal validation.'),
  @('DUT locations','Named footprints used for routing and dual-system geometry.','Use measured, approved dimensions only.')
)

Add-PageBreak
Add-Heading1 '6. Build, installation, and commissioning'
Add-Heading2 'Mechanical and electrical acceptance'
Add-Number 'Inspect the frame, belts, couplers, fasteners, end stops, reflector, cable routing, grounding, and emergency-stop path.' 1
Add-Number 'Record fixture, controller, Pi, radar, and cable identifiers.' 2
Add-Number 'Confirm each installed radar has independent UART and OUT connections; never parallel two TX or OUT signals.' 3
Add-Number 'Measure safe X/Y/Z travel and replace placeholder soft limits.' 4
Add-Number 'Verify GPIO ownership with gpioinfo. On Pi 3, disable the serial login console and commission the PL011 UART on GPIO14/15, normally using dtoverlay=disable-bt and disabling hciuart.' 5
Add-Number 'Verify common ground and 3.3 V logic before powering the radar harness.' 6
Add-Heading2 'Pi installation'
Add-Code 'cd pi-radar-service
python3 -m unittest -v test_radar_service.py
sudo sh ./install.sh
curl http://127.0.0.1:7130/v1/health
curl http://127.0.0.1:7130/v1/radars?target=dual
curl http://127.0.0.1:7130/v1/radars?target=single'
Add-Paragraph 'The install script installs pigpio and python3-pigpio, enables pigpiod, installs the radar service, and starts it through systemd. Mock mode is for GUI/network commissioning only and is never valid for physical qualification.'
Add-Heading2 'Klipper/Moonraker installation'
Add-Bullet 'Add the three gcode_button examples from printer-radar-inputs.cfg.example, or add only the physically installed target if the fixture is intentionally single-only.'
Add-Bullet 'Restart Klipper and query Moonraker to confirm the expected button objects appear.'
Add-Bullet 'Execute the reflector macro through the controlled Klipper interface and confirm reliable completion.'
Add-Heading2 'Radar physical acceptance'
Add-Number 'Query the active target 100 consecutive times without timeout or parse error.' 1
Add-Number 'Apply gain 0x53 and threshold 100, then confirm read-back.' 2
Add-Number 'Power-cycle without saving and observe persistence behavior.' 3
Add-Number 'Save the verified settings, power-cycle, and verify persistence again.' 4
Add-Number 'In dual mode, trigger A alone and B alone. In single mode, trigger SINGLE. Confirm the GUI indicator follows the active target.' 5
Add-Number 'Disconnect an active OUT wire and confirm preflight reports an unavailable input rather than a false LOW.' 6
Add-Heading2 'Desktop installation'
Add-Code 'install.cmd
launch.cmd
build.cmd'
Add-Paragraph 'Connect the application to Moonraker, confirm Pi/controller/axis indicators, enter measured motion limits and radar geometry, select the sensor layout, and run a short non-qualification characterization before production use.'

Add-Heading1 '7. Operator workflow'
Add-Heading2 'Before every run'
Add-Bullet 'Inspect the fixture and keep hands clear of motion.'
Add-Bullet 'Connect to the fixture and wait for Klipper ready.'
Add-Bullet 'Select Single sensor or Dual sensor system in the configuration/campaign controls.'
Add-Bullet 'Re-read radar settings. Apply Temporary only after values are confirmed; Save is optional and changes persistence.'
Add-Bullet 'Confirm the selected plan, geometry, point count, cycles, logging, and preflight checklist.'
Add-Heading2 'Running a test'
Add-Number 'Select Characterization, Test 10.1, Test 10.2, Custom, or an active campaign condition.' 1
Add-Number 'For formal tests, confirm the generated plan and the green/grey/red zone overlay in the spatial preview.' 2
Add-Number 'Press Run Test. The application homes, routes, establishes a LOW baseline, triggers, polls, records, and returns home.' 3
Add-Number 'Review the result, raw observations, spatial graph, latency view, report, and summary.' 4
Add-Heading2 'Campaigns'
Add-Paragraph 'A campaign is a reusable matrix of zones, gain values, thresholds, repeats, and cycles. The campaign form can generate conditions in a selected order, such as right zone, front zone, then left zone. Auto Run prepares the next condition, applies and verifies the active radar target, runs the normal guarded sequence, and advances only after report.html and observations.csv are durable.'
Add-Heading2 'Stopping and recovery'
Add-Bullet 'Use Emergency Stop when people or equipment may be at risk.'
Add-Bullet 'After an emergency stop, clear the cause, restore Klipper through the approved procedure, wait for ready, re-home, and start a new run.'
Add-Bullet 'Do not resume a qualification run after motion, reflector, radar, or logging integrity has been lost.'

Add-Heading1 '8. Data produced'
Add-Paragraph 'Every run is stored locally under the user Documents folder. The local finalized run folder is authoritative; cloud synchronization is an optional downstream copy.'
Add-Code 'Documents/Radar Validation Logs/<category>/<final run folder>/
  observations.csv
  manifest.json
  summary.json
  report.html
  radar-settings.json'
Add-Table @('Artifact','Contents','Use') @(
  @('observations.csv','Raw motion events and canonical observation rows, including X/Y/Z, expected/actual result, latency, validity, active target, radar channels, and settings.','Primary measurement record; preserve unchanged.'),
  @('manifest.json','Run ID, test definition, geometry, planned positions, configuration snapshot, cycles, DUT, and radar traceability.','Reconstruct the conditions under which the run was executed.'),
  @('summary.json','Counts, correct rate, TP/TN/FP/FN/invalid outcomes, cycle completion, and acceptance.','Quick result and machine-readable summary.'),
  @('report.html','Self-contained browser/print report with spatial graphs, overlays, latency/repeatability views, metadata, and raw observations.','Human review, signoff, and PDF printing.'),
  @('radar-settings.json','Independent read-back snapshot for the active target; dual includes A/B and single includes SINGLE.','Proves the range setting used for the run.'),
  @('Campaign history','Durable local campaign progress and completed-run records.','Resume campaigns and review local results without losing measurement data.')
)
Add-Heading2 'Observation semantics'
Add-Bullet 'TP and TN are correct results; FP and FN are incorrect results.'
Add-Bullet 'INVALID means the measurement could not be trusted, for example no fresh LOW baseline, stale radar data, motion failure, or reflector failure.'
Add-Bullet 'A radar miss retains a null latency; the application does not invent a timeout latency.'
Add-Bullet 'Repeated cycles are aggregated by physical point for all-cycle views. Invalid samples are excluded from voting; ties remain explicit.'
Add-Bullet 'The active radar target and independent channel states are retained for traceability. Dual system detection is A OR B; single detection is SINGLE.'

Add-Heading1 '9. Test modes and visual outputs'
Add-Table @('Mode','Purpose','Output behavior') @(
  @('Characterization','Map raw trigger behavior over a configured X/Y rectangle.','Exact-count raster; raw trigger map, latency, and repeatability views; not automatically a product qualification.'),
  @('Test 10.1','Evaluate required detection inside the configured activation zone.','Generated points and green required-detection overlay.'),
  @('Test 10.2','Evaluate required no-detection outside the configured boundary.','Generated negative-test points with grey unscored band and red required-no-detection region.'),
  @('Custom','Run an operator-supplied plan with optional per-point expectedDetected values.','Preserves raw results and applies the supplied expectations.'),
  @('Campaign','Run a matrix of zones, gains, thresholds, repeats, and cycles.','Each condition receives a durable run record and campaign progress entry.')
)
Add-Paragraph 'The graph overlays for formal dual-system validation use the existing zone geometry: green indicates the required-detection region, grey indicates the optional/unscored intermediate band, and red indicates the required-no-detection region. The DUT/module footprint is drawn separately at physical scale. Characterization remains an observation map; it should not be mistaken for a formal acceptance overlay unless a documented characterization-specific overlay is intentionally enabled.'

Add-Heading1 '10. Limitations and remaining next steps'
Add-Table @('Limitation or assumption','Impact','Recommended next step') @(
  @('GPIO22/27/26 are Pi 3 SINGLE assignments.','A conflict with another service or Klipper pin can make SINGLE unavailable.','Run gpioinfo and perform a physical pin audit during installation.'),
  @('Software UART depends on pigpio timing and daemon health.','Heavy Pi load or incorrect pigpiod setup can cause serial timeouts.','Keep pigpiod enabled, test 100 consecutive queries, and record the accepted result.'),
  @('Radar logic levels and supply variant are not auto-detected.','A 5 V TX/OUT signal can damage Pi GPIO or create invalid readings.','Confirm the module electrical specification and add approved level shifting if required.'),
  @('Z has no conventional home switch.','Zero Z is a commanded reference, not an independently verified physical datum.','Add a repeatable Z datum or document the approved zeroing method.'),
  @('Motion limits and geometry defaults require physical commissioning.','Placeholder limits or unmeasured centers can create unsafe or misleading plans.','Replace defaults with signed-off measurements for each fixture.'),
  @('Reflector behavior is delegated to a Klipper macro.','The application cannot prove the mechanism moved correctly unless the radar response and motion state are valid.','Commission the macro, add mechanical inspection, and consider an independent reflector position sensor.'),
  @('The service assumes the documented MoreSense HCI protocol.','Firmware variation or a different preamble can make writes unsafe or unreadable.','Use query-only acceptance and confirm the protocol profile before any write.'),
  @('Campaign history is local and does not require a network service.','Each completed run keeps report.html and observations.csv in its finalized output folder.','Treat those local artifacts as authoritative when reviewing or revising a run.'),
  @('Environmental conditions are not captured automatically.','Temperature, humidity, supply variation, and nearby objects may affect radar behavior.','Add environmental metadata if it matters to the qualification program.'),
  @('No automatic fixture identity discovery is implemented.','A desktop can connect to the wrong Pi or stale configuration.','Add fixture identity, serial number, and commissioning profile validation.')
)

Add-Heading1 '11. Maintenance and reuse procedure'
Add-Number 'Clone or install the approved software revision and preserve the existing configuration and run artifacts.' 1
Add-Number 'Inspect the fixture, harness, radar mounting, reflector, end stops, and emergency stop.' 2
Add-Number 'Reconfirm Pi GPIO ownership, UART mapping, Klipper button objects, and radar service health.' 3
Add-Number 'Re-measure the DUT location, sensor center, travel limits, and any changed mechanical offsets.' 4
Add-Number 'Run radar query, read-back, persistence, OUT isolation, reflector, homing, and short characterization checks.' 5
Add-Number 'Record software revision, Klipper revision, Pi identity, radar protocol profile, persistent settings, date, and approver.' 6
Add-Number 'Only then run a product-specific qualification plan or campaign.' 7
Add-Paragraph 'When changing a reusable fixture, update implementation, tests, operator instructions, commissioning records, and this package together. Historical analyses belong in Documentation/Reference and must be labeled non-normative.'

Add-PageBreak
Add-Heading1 'Appendix A. Source and file map'
Add-Table @('Path','Role') @(
  @('main.js','Electron main process, hardware/network IPC, persistence, logging, reports, campaign lifecycle.'),
  @('preload.js','Renderer-safe IPC boundary and exposed radarAPI.'),
  @('renderer.js','Operator UI, execution, preflight, plans, charts, campaigns.'),
  @('validation-core.js','Pure geometry, generators, classifications, summaries, acceptance.'),
  @('radar-settings-core.js','Pure gain/threshold validation and traceability helpers.'),
  @('campaign-core.js / campaign-manager.js / campaign-ledger.js','Campaign matrix, progress, and local records.'),
  @('pi-radar-service/','Pi radar protocol, HTTP service, settings template, Klipper input example, tests.'),
  @('Documentation/','Operator, commissioning, troubleshooting, campaign, and developer references.'),
  @('test/','Node regression and core behavior tests.'),
  @('tools/','Report generation, recovery, and documentation utilities.')
)

Add-Heading1 'Appendix B. Reusable-fixture handoff checklist'
Add-Bullet 'Mechanical frame and cable routing inspected.'
Add-Bullet 'Emergency stop verified and recovery procedure known.'
Add-Bullet 'X/Y/Z measured limits recorded; placeholder limits removed.'
Add-Bullet 'DUT footprint and single-sensor center physically measured.'
Add-Bullet 'Pi 3 UART and GPIO ownership checked with gpioinfo.'
Add-Bullet 'Radar supply and logic levels confirmed as Pi-compatible.'
Add-Bullet 'Radar service health, query, read-back, save, and reset safeguards checked.'
Add-Bullet 'Klipper gcode_button objects and reflector macro verified.'
Add-Bullet 'Desktop connection, homing, radar target selection, and preflight checked.'
Add-Bullet 'Short characterization completed and all five local artifacts inspected.'
Add-Bullet 'Software revision, hardware identity, commissioning date, and approver recorded.'

Add-Heading1 'Appendix C. Glossary'
Add-Table @('Term','Meaning') @(
  @('DUT','Device under test; the fixture may treat a dual-radar module as part of the DUT footprint.'),
  @('OUT','Radar detection output sampled by Klipper/Moonraker as a gcode_button state.'),
  @('Active target','The radar setup currently selected in the GUI: dual A/B or single SINGLE.'),
  @('Characterization','Exploratory mapping of raw trigger behavior; not automatically a qualification result.'),
  @('Formal plan','A generated test plan with defined geometry and expected outcomes, such as Test 10.1 or Test 10.2.'),
  @('Campaign','A matrix of repeated conditions that changes gain, threshold, angular zone, or run number while preserving local traceability.'),
  @('Fresh LOW baseline','A recent successful sample proving the active radar input was LOW before the reflector trigger.'),
  @('Invalid observation','A measurement that cannot be trusted and must not be silently converted into pass/fail data.'),
  @('Local authoritative artifact','The finalized run folder written by the application before any optional synchronization.')
)

$sourceZip = [IO.Compression.ZipFile]::OpenRead((Resolve-Path $template))
$documentEntry = $sourceZip.GetEntry('word/document.xml')
$reader = [IO.StreamReader]::new($documentEntry.Open())
$sourceDocument = $reader.ReadToEnd()
$reader.Dispose()
$sourceZip.Dispose()
$sectionMatch = [regex]::Match($sourceDocument, '(?s)<w:sectPr.*?</w:sectPr>')
if (-not $sectionMatch.Success) { throw 'Template document is missing section properties.' }
Add-Raw $sectionMatch.Value
Add-Raw '</w:body></w:document>'
$documentXml = $body.ToString()

$outputDirectory = Split-Path -Parent $output
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
$sourceZip = [IO.Compression.ZipFile]::OpenRead((Resolve-Path $template))
$destinationZip = [IO.Compression.ZipFile]::Open($tempOutput, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($entry in $sourceZip.Entries) {
    if ($entry.FullName -eq 'word/document.xml') { continue }
    $newEntry = $destinationZip.CreateEntry($entry.FullName, [IO.Compression.CompressionLevel]::Optimal)
    $inStream = $entry.Open()
    $outStream = $newEntry.Open()
    try { $inStream.CopyTo($outStream) } finally { $outStream.Dispose(); $inStream.Dispose() }
  }
  $document = $destinationZip.CreateEntry('word/document.xml', [IO.Compression.CompressionLevel]::Optimal)
  $stream = $document.Open()
  $writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false))
  try { $writer.Write($documentXml) } finally { $writer.Dispose(); $stream.Dispose() }
} finally {
  $destinationZip.Dispose()
  $sourceZip.Dispose()
}

if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Force }
Move-Item -LiteralPath $tempOutput -Destination $output
Write-Output "Created $output"
