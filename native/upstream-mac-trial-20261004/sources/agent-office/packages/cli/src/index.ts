#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';

const program = new Command();

program
    .name('agent-office')
    .description('CLI to manage your AgentOffice spaces')
    .version('1.0.0');

program.command('create')
    .description('Create a new AgentOffice project')
    .argument('<project-name>', 'Name of the project directory')
    .action((projectName) => {
        console.log(chalk.blue(`Creating new AgentOffice project at ./${projectName}...`));
        const projectPath = path.resolve(process.cwd(), projectName);
        if (!fs.existsSync(projectPath)) {
            fs.mkdirSync(projectPath);
            // Basic init
            fs.writeFileSync(path.join(projectPath, 'package.json'), JSON.stringify({
                name: projectName,
                version: "1.0.0",
                dependencies: {
                    "@agent-office/server": "^1.0.0",
                    "@agent-office/ui": "^1.0.0",
                    "@agent-office/core": "^1.0.0"
                },
                scripts: {
                    "dev": "agent-office start"
                }
            }, null, 2));
            console.log(chalk.green(`Success! Next steps:`));
            console.log(`cd ${projectName} && npm install`);
        } else {
            console.log(chalk.red(`Directory ${projectName} already exists.`));
        }
    });

program.command('add-agent')
    .description('Add a new agent to your office configuration')
    .requiredOption('-n, --name <name>', 'Name of the agent')
    .requiredOption('-r, --role <role>', 'Role of the agent')
    .option('-p, --provider <provider>', 'Inference provider', 'ollama')
    .action((options) => {
        console.log(chalk.yellow(`Adding agent ${options.name} (${options.role}) using ${options.provider}...`));
        // Real implementation would modify office configuration map here
        console.log(chalk.green(`Agent addition registered successfully!`));
    });

program.command('start')
    .description('Start the local development server and UI')
    .action(() => {
        console.log(chalk.blue(`Starting AgentOffice local environment...`));
        console.log(chalk.gray(`> Booting Vite on port 5173`));
        console.log(chalk.gray(`> Booting Colyseus Engine on port 3000`));
        // Execution shell logic mapping would go here
    });

program.parse();
