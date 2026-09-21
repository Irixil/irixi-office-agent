import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { activeGoal } from './core.mjs';

const CODEX_TIMEOUT_MS = 180_000;
const MAX_PROVIDER_OUTPUT = 2_000_000;

function taskContext(task) {
  const goal = activeGoal(task);
  return {
    type: task.type,
    goal: goal.statement,
    successCriteria: goal.successCriteria,
    boundaries: goal.boundaries,
    materials: task.materials.map((material) => ({
      name: material.name,
      source: material.source,
      status: material.status,
      text: material.status === 'ready' ? material.text : `[读取失败：${material.error || '未知原因'}]`,
    })),
  };
}

function demoResult(task) {
  const context = taskContext(task);
  const ready = context.materials.filter((item) => item.status === 'ready');
  const sourceNames = ready.map((item) => item.name);
  const materialNotes = ready.length
    ? ready.map((item, index) => `${index + 1}. ${item.name}：${item.text.slice(0, 260).replaceAll(/\s+/g, ' ')}`).join('\n')
    : '尚未加入材料。以下内容只用于体验流程，不能当作基于事实的正式成果。';

  if (task.type === 'email') {
    return {
      title: `${task.title}｜邮件草稿`,
      summary: '演示提供者生成的邮件结构草稿，需人工补全收件人和事实。',
      content: `主题：${context.goal.slice(0, 48)}\n\n您好，\n\n围绕“${context.goal}”，我整理了以下事项：\n\n${materialNotes}\n\n建议下一步：\n1. 核对事实与收件人。\n2. 补充明确截止时间。\n3. 确认后再从邮件客户端发送。\n\n此致\n`,
      sources: sourceNames,
    };
  }
  if (task.type === 'calendar') {
    return {
      title: `${task.title}｜日程草稿`,
      summary: '演示提供者生成的日程说明，时间和参与者仍待确认。',
      content: `# ${context.goal}\n\n## 目的\n${context.goal}\n\n## 待确认\n- 开始与结束时间\n- 参与者\n- 地点或会议链接\n\n## 参考材料\n${materialNotes}\n`,
      sources: sourceNames,
    };
  }
  return {
    title: `${task.title}｜候选稿`,
    summary: `演示提供者根据 ${ready.length} 份可读材料生成结构化候选稿。`,
    content: `# ${context.goal}\n\n> 演示模式候选内容。它用于验证 Irixi 的目标、版本、审阅与确认流程，不代表真实模型研究结果。\n\n## 目标\n${context.goal}\n\n## 成功条件\n${context.successCriteria.length ? context.successCriteria.map((item) => `- ${item}`).join('\n') : '- 尚未填写，建议补充。'}\n\n## 材料摘记\n${materialNotes}\n\n## 初步结论\n当前材料已经被整理到同一目标之下。正式使用前，应切换真实模型提供者，并在审阅台逐项核对事实、缺口与边界。\n\n## 边界\n${context.boundaries.length ? context.boundaries.map((item) => `- ${item}`).join('\n') : '- 不自动发送、发布、覆盖或创建外部事项。'}\n`,
    sources: sourceNames,
  };
}

function providerPrompt(task) {
  const context = taskContext(task);
  const outputKinds = {
    document: '一份可直接审阅的 Markdown 办公文档',
    research: '一份区分事实、推断、缺口与来源的 Markdown 研究简报',
    email: '一封不虚构收件人、事实或承诺的纯文本邮件草稿',
    calendar: '一份明确标出待确认时间、参与者和地点的 Markdown 日程草稿',
  };
  return [
    '你是 Irixi 办公 Agent 的写作角色。只基于下方目标和材料生成候选成果。',
    '目标优先：不得把补充建议悄悄替换成新目标。材料缺失时明确写“待确认”，不得编造。',
    `成果类型：${outputKinds[task.type]}.`,
    '请严格按所给 JSON Schema 返回 title、summary、content、sources。sources 只能列出实际使用的材料名称或明确 URL。',
    '',
    JSON.stringify(context, null, 2),
  ].join('\n');
}

function reviewPrompt(task, artifact) {
  const goal = activeGoal(task);
  return [
    '你是独立审阅角色，不继承起草者的完成结论。逐项检查目标符合度、完整性、来源可追溯、边界遵守和文件可用性。',
    '每项检查必须给出证据。事实或关键材料不足时应失败。严格按 JSON Schema 返回。',
    '',
    `目标：${goal.statement}`,
    `成功条件：${JSON.stringify(goal.successCriteria)}`,
    `边界：${JSON.stringify(goal.boundaries)}`,
    `材料名称：${JSON.stringify(task.materials.map((item) => `${item.name}(${item.status})`))}`,
    `候选成果标题：${artifact.title}`,
    `候选成果：\n${artifact.content}`,
  ].join('\n');
}

async function executableExists(executable) {
  if (executable.includes('/')) {
    try { await fs.access(executable); return true; } catch { return false; }
  }
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/which', [executable], { stdio: 'ignore' });
    child.once('close', (code) => resolve(code === 0));
    child.once('error', () => resolve(false));
  });
}

function runProcess(command, args, { cwd, input, timeoutMs = CODEX_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { if (stdout.length < MAX_PROVIDER_OUTPUT) stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (stderr.length < MAX_PROVIDER_OUTPUT) stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (killed) return reject(new Error('真实模型运行超时，任务已安全停止。'));
      if (code !== 0) return reject(new Error(`Codex CLI 运行失败：${stderr.trim().slice(-900) || `退出码 ${code}`}`));
      resolve({ stdout, stderr });
    });
    child.stdin.end(input);
  });
}

export function createProviders({ projectRoot, store }) {
  const schemaRoot = path.join(projectRoot, 'app', 'schemas');
  const codexPath = process.env.IRIXI_CODEX_PATH || '/Users/irxi/.local/bin/codex';
  const connectionFile = path.join(store.root, '.connections.json');

  async function readConnectionState() {
    try { return JSON.parse(await fs.readFile(connectionFile, 'utf8')); }
    catch { return {}; }
  }

  async function writeConnectionState(value) {
    await fs.mkdir(path.dirname(connectionFile), { recursive: true });
    const temp = `${connectionFile}.${Date.now()}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temp, connectionFile);
  }

  async function runCodex(task, schemaName, prompt, label) {
    if (!(await executableExists(codexPath))) throw new Error('没有找到 Codex CLI，请先在连接中心检查真实模型。');
    const runRoot = path.join(store.taskDir(task.id), 'runs', `${Date.now()}-${label}`);
    await fs.mkdir(runRoot, { recursive: true });
    const outputPath = path.join(runRoot, 'result.json');
    const schemaPath = path.join(schemaRoot, schemaName);
    const args = [
      'exec', '-', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check',
      '--ignore-user-config', '--ignore-rules', '--output-schema', schemaPath,
      '--color', 'never', '-o', outputPath, '-C', runRoot,
    ];
    await fs.writeFile(path.join(runRoot, 'request.txt'), prompt, { mode: 0o600 });
    await runProcess(codexPath, args, { cwd: runRoot, input: prompt });
    const raw = await fs.readFile(outputPath, 'utf8');
    if (raw.length > MAX_PROVIDER_OUTPUT) throw new Error('真实模型返回内容超过安全上限。');
    try { return JSON.parse(raw); } catch { throw new Error('真实模型没有返回符合结构的结果。'); }
  }

  return {
    async status() {
      const saved = await readConnectionState();
      return {
        demo: { id: 'demo', available: true, verified: true, label: '演示提供者', boundary: '本地生成固定结构，仅用于体验流程；不是智能模型。' },
        codex: {
          id: 'codex-cli', available: await executableExists(codexPath), verified: Boolean(saved.codexCli?.verified),
          label: 'Codex CLI', boundary: '选用后，当前任务目标与选定材料会发送给 Codex 服务；在隔离只读目录运行。',
          verifiedAt: saved.codexCli?.verifiedAt || null,
          version: saved.codexCli?.version || null,
        },
      };
    },
    async verifyCodex() {
      const available = await executableExists(codexPath);
      if (!available) return { ok: false, message: '没有找到 Codex CLI。' };
      try {
        const { stdout } = await runProcess(codexPath, ['--version'], { cwd: projectRoot, input: '', timeoutMs: 10_000 });
        const version = stdout.trim() || 'Codex CLI 可运行。';
        await writeConnectionState({ ...(await readConnectionState()), codexCli: { verified: true, verifiedAt: new Date().toISOString(), version } });
        return { ok: true, message: version };
      } catch (error) {
        return { ok: false, message: error.message };
      }
    },
    async generate(task) {
      if (task.provider === 'codex-cli') return runCodex(task, 'generate.json', providerPrompt(task), 'generate');
      return demoResult(task);
    },
    async review(task, artifact) {
      if (task.provider === 'codex-cli') {
        const result = await runCodex(task, 'review.json', reviewPrompt(task, artifact), 'review');
        return { ...result, provider: 'codex-cli-independent-review' };
      }
      const goal = activeGoal(task);
      const readyMaterials = task.materials.filter((item) => item.status === 'ready');
      const hasSourceGap = task.materials.some((item) => item.status === 'failed');
      const checks = [
        { name: '目标符合度', passed: artifact.goalVersionId === goal.id && artifact.content.includes(goal.statement), evidence: '成果绑定当前目标版本，正文包含目标表述。', blocking: true },
        { name: '完整性', passed: artifact.content.trim().length >= 120, evidence: `正文长度 ${artifact.content.trim().length} 字符。`, blocking: true },
        { name: '来源可追溯', passed: readyMaterials.length === 0 || artifact.sources.length > 0, evidence: readyMaterials.length ? `记录 ${artifact.sources.length} 条来源。` : '没有提供事实材料，成果已标注演示限制。', blocking: true },
        { name: '材料读取', passed: !hasSourceGap, evidence: hasSourceGap ? '至少一份材料读取失败，需处理后再确认。' : '选定材料均处于可读状态。', blocking: true },
        { name: '边界遵守', passed: true, evidence: '没有执行发送、发布、覆盖或创建外部事项。', blocking: true },
        { name: '文件可用性', passed: Boolean(artifact.title && artifact.content), evidence: '标题与正文均存在，可生成新文件。', blocking: true },
      ];
      return { summary: checks.every((item) => item.passed) ? '演示审阅通过，可等待用户确认。' : '演示审阅发现阻塞项。', checks, provider: 'deterministic-independent-review' };
    },
  };
}

export const __test = { demoResult, providerPrompt, reviewPrompt };
