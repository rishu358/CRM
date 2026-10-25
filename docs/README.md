# Documentation

Start with the row that matches what you are doing.

| I want to...                                  | Read                                                                |
| --------------------------------------------- | ------------------------------------------------------------------- |
| Take over this codebase                       | [HANDOVER.md](HANDOVER.md), then [ARCHITECTURE.md](ARCHITECTURE.md) |
| Run it on my laptop                           | [SETUP.md](SETUP.md)                                                |
| Understand how it is built                    | [ARCHITECTURE.md](ARCHITECTURE.md)                                  |
| Deploy it                                     | [DEPLOYMENT.md](DEPLOYMENT.md), then [RUNBOOK.md](RUNBOOK.md)       |
| Run it day to day, or handle an incident      | [RUNBOOK.md](RUNBOOK.md)                                            |
| Find what a setting does                      | [CONFIGURATION.md](CONFIGURATION.md) (generated)                    |
| Choose or switch an email or storage provider | [PROVIDERS.md](PROVIDERS.md)                                        |
| Rotate a secret, or respond to a leak         | [SECRETS.md](SECRETS.md)                                            |
| Change the code                               | [CONTRIBUTING.md](../CONTRIBUTING.md) and [CLAUDE.md](../CLAUDE.md) |
| Report a security problem                     | [SECURITY.md](../SECURITY.md)                                       |
| See what changed                              | [CHANGELOG.md](../CHANGELOG.md)                                     |
| Find why something is the way it is           | [Architecture decision records](adr/README.md)                      |

## Reference

| Document                                 | What it is                                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [MVP_SPEC.md](MVP_SPEC.md)               | The product and technical specification: what it does and why. The source of truth.                |
| [openapi.json](openapi.json)             | The API, generated from the code. CI fails if it is stale.                                         |
| [PERF.md](PERF.md)                       | The load test at a million contacts: method, results, caveats.                                     |
| [ACCESSIBILITY.md](ACCESSIBILITY.md)     | The accessibility review and what is enforced.                                                     |
| [SECURITY_REVIEW.md](SECURITY_REVIEW.md) | The security review of the hardening passes.                                                       |
| [legal/](legal/README.md)                | Draft terms, privacy policy and data-processing agreement. **Unreviewed: read the warning first.** |
| [design/](design)                        | Design notes and before/after screenshots.                                                         |

## Keeping it true

`node scripts/check-docs.mjs` checks every Markdown file in the repository: each link must point at a file (and
a heading, where it names one) that exists, and each `pnpm` command quoted in code must be a real script. CI runs
it, so a renamed file or script cannot silently leave a document wrong. The generated documents
([CONFIGURATION.md](CONFIGURATION.md), `openapi.json`) are checked separately (`pnpm config:check`,
`pnpm openapi:check`) and are never edited by hand.
