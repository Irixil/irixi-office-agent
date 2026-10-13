# Contributing to AgentOffice

Thanks for your interest in contributing to AgentOffice! Whether it's fixing a bug, adding a feature, improving docs, or sharing an idea — all contributions are welcome.

---

## 🚀 Getting Started

### 1. Fork & Clone

```bash
git clone https://github.com/harishkotra/agent-office.git
cd agent-office
npm install
```

### 2. Build All Packages

```bash
npm run build
```

### 3. Run Locally

```bash
# Terminal 1: Server
npm run start --workspace=@agent-office/server

# Terminal 2: UI
npm run dev --workspace=@agent-office/ui
```

Open **http://localhost:5173** to see the office.

---

## 📦 Project Structure

```
packages/
├── core/       # Agent brain, Office grid, Memory, Tasks (no I/O)
├── adapters/   # LLM adapters (Ollama, OpenAI-compatible)
├── server/     # Colyseus room, ToolExecutor, MemoryStore (SQLite)
├── ui/         # Phaser.js game + React overlay components
└── cli/        # Scaffolding commands
```

When making changes, build in dependency order:

```bash
npm run build --workspace=@agent-office/core
npm run build --workspace=@agent-office/adapters
npm run build --workspace=@agent-office/server
```

---

## 🛠️ How to Contribute

### Bug Reports

Open an issue with:
- What you expected vs. what happened
- Steps to reproduce
- Your environment (OS, Node version, Ollama model)

### Feature Requests

Open an issue describing:
- The problem your feature solves
- How you'd like it to work
- Whether you're willing to implement it

### Pull Requests

1. **Fork** the repo and create a branch from `main`:
   ```bash
   git checkout -b feature/my-awesome-feature
   ```

2. **Make your changes.** Follow the existing code style (TypeScript, no semicolons in some files — match the file you're editing).

3. **Test your changes:**
   ```bash
   npm test
   ```

4. **Build everything** to make sure nothing breaks:
   ```bash
   npm run build
   ```

5. **Commit** with a clear message:
   ```bash
   git commit -m "Add: brief description of what you did"
   ```

6. **Push** and open a PR:
   ```bash
   git push origin feature/my-awesome-feature
   ```

---

## 💡 Good First Issues

Looking for where to start? Here are some beginner-friendly areas:

| Area | Ideas |
|------|-------|
| **Docs** | Fix typos, add examples, improve explanations |
| **UI** | New React components, styling improvements, accessibility |
| **Agents** | New personality profiles, better system prompts |
| **Tools** | Add new tools agents can use (APIs, file operations, etc.) |
| **Examples** | New example projects (classroom, hospital, game NPCs) |

---

## ✍️ Code Guidelines

- **TypeScript** — All code is typed. Avoid `any` where possible.
- **Naming** — Use camelCase for variables/functions, PascalCase for classes/components.
- **Imports** — Use the package name (`@agent-office/core`) for cross-package imports.
- **Comments** — Add comments for non-obvious logic. Don't comment obvious code.
- **Keep it small** — Smaller PRs are easier to review and merge.

---

## 🧪 Testing

```bash
# Run all tests
npm test

# Run tests for a specific package
npm test --workspace=@agent-office/core
npm test --workspace=@agent-office/adapters
```

If you add a new feature, please add tests where applicable.

---

## 📝 Commit Message Format

Use clear, descriptive commit messages:

```
Add: new web_search tool for agents
Fix: agents walking out of office bounds
Update: README with deployment instructions
Refactor: extract agent think loop into separate method
```

---

## 🤝 Code of Conduct

Be kind, be respectful, be constructive. We're all here to build cool things together.

---

## 📄 License

By contributing, you agree that your contributions will be licensed under the project's [MIT License](LICENSE).

---

Thanks for helping make AgentOffice better! 🏢✨
