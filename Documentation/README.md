# Whisker Radar Fixture Documentation

This directory is the maintained technical context for the current source
tree. The implementation and configuration files are authoritative when a
document and the code disagree.

## Choose a document

| Document | Owns |
|---|---|
| [Developer Handoff](Developer%20Handoff.md) | Setup, verification, boundaries, release checks |
| [Code Guide](Code%20Guide.md) | Runtime architecture, data flow, and file map |
| [User Manual](Radar%20Validation%20Fixture%20User%20Manual.md) | Operator workflow, safety, results, and shutdown |
| [Installation and Commissioning](Installation%20and%20Commissioning.md) | Fixture installation and acceptance |
| [Radar Settings Integration](Radar%20Settings%20Integration.md) | Radar targets, wiring, Pi service, and read-back acceptance |
| [Campaign Automation](Campaign%20Automation.md) | Local campaign plans and run history |
| [Troubleshooting](Troubleshooting.md) | Fault isolation and recovery |

## Authority rules

1. Approved test method and released engineering requirements
2. Measured and accepted physical fixture values
3. Current source and configuration
4. These procedures

All radar profiles in this source tree are experimental. A profile is not
qualified merely because the UI or mock service can select it.

Historical pilot data, old configuration snapshots, and DOCX copies were
removed from the source package. If historical evidence is needed, keep it in
a separately controlled archive rather than mixing it with current context.
