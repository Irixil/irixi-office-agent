# What the workbench has been used for

## Make a command-line tool, then use it

A local expense-calculation task was created through the conversation workbench. The agent wrote the project, checked it, and delivered a runnable tool. Entering total `100` and count `4` returned `25.00` through the product's tool runner.

The example demonstrates a complete project outcome rather than a code snippet. It does not establish success for every command-line project.

## Continue an existing web app

An existing focus-recording webpage was modified through its project conversation. Its output was used to set a target, add a record, refresh, and delete a record. A later request added target clearing; after that action and refresh, the existing record and 25-minute total remained.

This exercised modifying existing files, checking the result, opening the working output, and continuing with another requirement.

## Carry context across conversations

A second conversation in the same project read relevant project history and actual files. Cross-conversation quotes preserved their source. A chat branch inherited history only up to its selected completed turn, while an edited message created a revision branch without rewriting the original record.

Inherited branch materials were checked for visible records, removal, persistence after refresh, and preservation in the source conversation. Actual read-only child-agent work and history cards were exercised separately.

## The office

![iRIXI office idle and rest recording](media/irixi-office.gif)

The office, map, and colleagues provide entry points to projects and conversations. The map has connected floors, keyboard and click-to-walk movement, and local animation. The recording above shows idle/rest behavior. The current workbench's tools and child-agent activity come from actual execution records.

The examples describe selected local acceptance work. The public snapshot excludes the original task records and generated runtime worktrees. [Current scope](../STAGE_STATUS.md) · [Run from source](getting-started.md)
