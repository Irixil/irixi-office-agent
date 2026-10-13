import type { RiskLevel } from "@office/shared";

interface PolicyCheck {
  needsApproval: boolean;
  title: string;
  summary: string;
  riskLevel: RiskLevel;
}

const SENSITIVE_PATHS = ["~/.ssh", "/etc", "/Library", "~/.gnupg", "~/.aws"];
const DANGEROUS_COMMANDS = [
  { pattern: /\bgit\s+push\b/, title: "Git Push", risk: "med" as RiskLevel },
  { pattern: /\b(npm|pnpm|yarn|bun)\s+install\b/, title: "Package Install", risk: "med" as RiskLevel },
  { pattern: /\bbrew\s+install\b/, title: "Brew Install", risk: "med" as RiskLevel },
  { pattern: /\brm\s+-rf?\b/, title: "File Deletion", risk: "high" as RiskLevel },
  { pattern: /\brm\s+.*-r/, title: "Recursive Delete", risk: "high" as RiskLevel },
];

export function checkPolicy(commandText: string): PolicyCheck {
  // Check sensitive paths
  for (const path of SENSITIVE_PATHS) {
    if (commandText.includes(path) || commandText.includes(path.replace("~", "$HOME"))) {
      return {
        needsApproval: true,
        title: "Sensitive Path Access",
        summary: `Attempting to access ${path}`,
        riskLevel: "high",
      };
    }
  }

  // Check dangerous commands
  for (const rule of DANGEROUS_COMMANDS) {
    if (rule.pattern.test(commandText)) {
      return {
        needsApproval: true,
        title: rule.title,
        summary: commandText.slice(0, 200),
        riskLevel: rule.risk,
      };
    }
  }

  return { needsApproval: false, title: "", summary: "", riskLevel: "low" };
}
