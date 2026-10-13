import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Document, HeadingLevel, HeightRule, LineRuleType, Packer, Paragraph, Table, TableCell, TableLayoutType, TableRow, TextRun, WidthType } from 'docx';
import { Presentation, PresentationFile, SpreadsheetFile, Workbook } from '@oai/artifact-tool';

const requestPath = process.argv[2];
if (!requestPath) throw new Error('缺少制品请求文件。');
const request = JSON.parse(await fs.readFile(requestPath, 'utf8'));
const outputPath = path.resolve(request.outputPath);
await fs.mkdir(path.dirname(outputPath), { recursive: true });
let receiptDetails = {};
const documentFont = 'Noto Sans SC';
const documentFontPath = process.env.IRIXI_DOCUMENT_FONT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'third_party', 'fonts', 'NotoSansSC-Regular.ttf');

function inlineRuns(value, options = {}) {
  const parts = String(value).split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((part) => new TextRun({ text: part.startsWith('**') && part.endsWith('**') ? part.slice(2, -2) : part, font: documentFont, bold: options.bold || (part.startsWith('**') && part.endsWith('**')), size: options.size, color: options.color }));
}

function paragraphForLine(line) {
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) return new Paragraph({ children: inlineRuns(heading[2], { bold: true }), heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][heading[1].length - 1], keepNext: true, spacing: { before: 240, after: 100 } });
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) return new Paragraph({ children: inlineRuns(bullet[1]), bullet: { level: 0 }, spacing: { after: 70 } });
    return new Paragraph({ children: inlineRuns(line || ' ', { size: 22, color: '202020' }), spacing: { after: 120, line: 320 } });
}

function tableCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function markdownBlocks(content) {
  const lines = String(content || '').split(/\r?\n/);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const separator = lines[index + 1];
    if (line.includes('|') && separator && /^\s*\|?\s*:?-{3,}/.test(separator)) {
      const rows = [tableCells(line)];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      index -= 1;
      const width = Math.max(...rows.map((row) => row.length));
      blocks.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        layout: TableLayoutType.AUTOFIT,
        rows: rows.map((row, rowIndex) => new TableRow({ tableHeader: rowIndex === 0, cantSplit: true, height: { value: 360, rule: HeightRule.ATLEAST }, children: Array.from({ length: width }, (_, columnIndex) => new TableCell({
          margins: { top: 60, bottom: 60, left: 70, right: 70 },
          children: [new Paragraph({
            children: inlineRuns(row[columnIndex] || '', { bold: rowIndex === 0, size: width > 6 ? 17 : 20 }),
            spacing: { before: 0, after: 0, line: 240, lineRule: LineRuleType.AUTO },
          })],
        })) })),
      }));
      continue;
    }
    if (line.trim()) blocks.push(paragraphForLine(line));
  }
  return blocks;
}

async function buildDocument() {
  const fontData = await fs.readFile(documentFontPath);
  const firstMeaningful = String(request.content || '').split(/\r?\n/).find((line) => line.trim()) || '';
  const titleBlock = /^#\s+/.test(firstMeaningful) ? [] : [new Paragraph({ children: inlineRuns(request.title, { bold: true }), heading: HeadingLevel.TITLE, spacing: { after: 320 } })];
  const document = new Document({
    fonts: [{ name: documentFont, data: fontData }],
    sections: [{ properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 } } }, children: [
      ...titleBlock,
      ...markdownBlocks(request.content),
    ] }],
    styles: { default: { document: { run: { font: documentFont, size: 22, color: '202020' }, paragraph: { spacing: { line: 320 } } } } },
  });
  await fs.writeFile(outputPath, await Packer.toBuffer(document));
}

function parsedSheets() {
  try {
    const parsed = JSON.parse(request.content);
    if (Array.isArray(parsed.sheets) && parsed.sheets.length) return parsed.sheets;
  } catch { /* CSV/plain table fallback below */ }
  return null;
}

function typedCell(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return value;
}

async function buildSpreadsheet() {
  const sheets = parsedSheets();
  if (sheets && sheets.length > 12) throw new Error('电子表格超过 12 个工作表上限，请拆分成多个交付物。');
  const workbook = sheets ? Workbook.create() : await Workbook.fromCSV(String(request.content || ''), { sheetName: 'Results' });
  const normalized = sheets || workbook.worksheets.items.map((sheet) => ({ name: sheet.name, imported: true }));
  for (const [index, source] of normalized.entries()) {
    const sheet = source.imported ? workbook.worksheets.getItem(source.name) : workbook.worksheets.add(String(source.name || `Sheet ${index + 1}`).slice(0, 31));
    sheet.showGridLines = false;
    const importedRange = source.imported ? sheet.getUsedRange() : null;
    const rawRows = importedRange ? importedRange.values : (Array.isArray(source.rows) ? source.rows : []);
    if (rawRows.length > 5000) throw new Error(`工作表“${source.name || index + 1}”超过 5000 行上限，请拆分。`);
    if (rawRows.some((row) => (Array.isArray(row) ? row.length : 1) > 80)) throw new Error(`工作表“${source.name || index + 1}”超过 80 列上限，请拆分。`);
    const rows = rawRows.map((row) => (Array.isArray(row) ? row : [row]).map(typedCell));
    if (!rows.length) rows.push(['Result'], [request.content]);
    const columns = Math.max(...rows.map((row) => row.length));
    const matrix = rows.map((row) => [...row, ...Array(Math.max(0, columns - row.length)).fill(null)]);
    if (!source.imported) sheet.getRangeByIndexes(0, 0, matrix.length, columns).values = matrix;
    else {
      const formulas = importedRange.formulas;
      for (let row = 0; row < matrix.length; row += 1) for (let column = 0; column < columns; column += 1) {
        if (!formulas[row]?.[column] && typeof matrix[row][column] === 'number') sheet.getCell(row, column).values = [[matrix[row][column]]];
      }
    }
    const used = sheet.getRangeByIndexes(0, 0, matrix.length, columns);
    used.format.font = { name: 'Arial', size: 10, color: '#202020' };
    used.format.verticalAlignment = 'center'; used.format.wrapText = true; used.format.autofitColumns();
    for (let column = 0; column < columns; column += 1) {
      const range = sheet.getRangeByIndexes(0, column, matrix.length, 1);
      if (range.format.columnWidth > 34) range.format.columnWidth = 34;
    }
    used.format.autofitRows();
    const header = sheet.getRangeByIndexes(0, 0, 1, columns);
    header.format.fill = '#214C3D'; header.format.font = { bold: true, color: '#FFFFFF', name: 'Arial', size: 10 };
    header.format.horizontalAlignment = 'center'; header.format.verticalAlignment = 'center';
    if (matrix.length > 12) sheet.freezePanes.freezeRows(1);
  }
  workbook.recalculate();
  const validation = [];
  for (const [index, source] of normalized.entries()) {
    const sheetName = String(source.name || `Sheet ${index + 1}`).slice(0, 31);
    const sheet = workbook.worksheets.getItem(sheetName);
    const used = sheet.getUsedRange();
    const formulas = used?.formulas || [];
    const values = used?.values || [];
    let formulaCount = 0;
    const formulaErrors = [];
    for (let row = 0; row < formulas.length; row += 1) for (let column = 0; column < (formulas[row]?.length || 0); column += 1) {
      if (!formulas[row][column]) continue;
      formulaCount += 1;
      const value = String(values[row]?.[column] ?? '');
      if (/^#(?:REF|VALUE|DIV\/0|NAME|N\/A|NUM|NULL)!?$/i.test(value)) formulaErrors.push({ row: row + 1, column: column + 1, value });
    }
    validation.push({ sheetName, rows: values.length, columns: Math.max(0, ...values.map((row) => row?.length || 0)), formulaCount, formulaErrors });
    const preview = await workbook.render({ sheetName, autoCrop: 'all', scale: 1.5, format: 'png' });
    await fs.writeFile(`${outputPath}.sheet-${index + 1}.png`, new Uint8Array(await preview.arrayBuffer()));
  }
  if (validation.some((sheet) => sheet.formulaErrors.length)) throw new Error('电子表格公式计算出错，已阻止候选文件进入审阅。');
  const exported = await SpreadsheetFile.exportXlsx(workbook);
  await exported.save(outputPath);
  receiptDetails = { validation: { sheetCount: validation.length, sheets: validation } };
}

function parsedSlides() {
  try {
    const parsed = JSON.parse(request.content);
    if (Array.isArray(parsed.slides) && parsed.slides.length) return parsed.slides;
  } catch { /* Markdown fallback below */ }
  return String(request.content || '').split(/\n\s*---\s*\n/).filter(Boolean).map((block, index) => {
    const lines = block.split(/\r?\n/).filter(Boolean);
    return { title: lines[0]?.replace(/^#+\s*/, '') || `${request.title} ${index + 1}`, body: lines.slice(1).join('\n') };
  });
}

async function buildPresentation() {
  const skillDir = process.env.IRIXI_PRESENTATION_SKILL;
  const runtimePython = process.env.IRIXI_RUNTIME_PYTHON;
  const { resolvePresentationFont, finalizePresentation } = await import(pathToFileURL(path.join(skillDir, 'container_tools/artifact_tool_utils.mjs')).href);
  const family = resolvePresentationFont();
  const presentation = Presentation.create({ slideSize: { width: 1280, height: 720 } });
  const slides = parsedSlides();
  if (!slides.length) throw new Error('演示文稿没有可生成的幻灯片。');
  if (slides.length > 40) throw new Error('演示文稿超过 40 页上限，请拆分或精简后重试。');
  for (const [index, source] of slides.entries()) {
    const slide = presentation.slides.add(); slide.background.fill = index === 0 ? '#F4EBD5' : '#FFFDF7';
    const title = slide.shapes.add({ geometry: 'textbox', position: { left: 72, top: 54, width: 1136, height: 92 }, fill: 'none', line: { fill: 'none', width: 0 } });
    title.text = String(source.title || `${request.title} ${index + 1}`); title.text.style = { typeface: family, fontSize: index === 0 ? 44 : 34, bold: true, color: '#173B32', autoFit: 'shrinkText' };
    const lines = String(source.body || source.content || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const tableIndexes = lines.map((line, lineIndex) => line.includes('｜') ? lineIndex : -1).filter((lineIndex) => lineIndex >= 0);
    const tableLines = tableIndexes.map((lineIndex) => lines[lineIndex]);
    if (tableLines.length >= 3) {
      if (tableIndexes.some((lineIndex, position) => position > 0 && lineIndex !== tableIndexes[position - 1] + 1)) {
        throw new Error(`幻灯片 ${index + 1} 的表格行之间夹有正文，固定布局无法在不改变顺序的情况下安全排版。`);
      }
      if (tableLines.length > 10) throw new Error(`幻灯片 ${index + 1} 的原生表格超过 10 行，请在保持页数的前提下精简或拆分内容。`);
      const values = tableLines.map((line) => line.split('｜').map((cell) => cell.trim()));
      const columns = Math.max(...values.map((row) => row.length));
      if (columns > 8) throw new Error(`幻灯片 ${index + 1} 的原生表格超过 8 列，不能在不丢内容的情况下保证可读性。`);
      const beforeTable = lines.slice(0, tableIndexes[0]);
      const afterTable = lines.slice(tableIndexes.at(-1) + 1);
      if (beforeTable.length > 2 || afterTable.length > 2) throw new Error(`幻灯片 ${index + 1} 的表格前后说明超过可读布局上限，已阻止静默截断。`);
      const matrix = values.map((row) => [...row, ...Array(columns - row.length).fill('')]);
      const hasHeader = matrix[0].some((cell) => /^(编号|负责人|期限|状态|项目|来源|结论|指标)$/.test(String(cell).trim()));
      const columnWeights = Array.from({ length: columns }, (_, column) => Math.max(5, Math.min(28, Math.max(...matrix.map((row) => String(row[column] || '').length)))));
      const weightTotal = columnWeights.reduce((sum, weight) => sum + weight, 0);
      const columnWidths = columnWeights.map((weight) => 1172 * weight / weightTotal);
      const noteHeight = 58;
      const tableTop = beforeTable.length ? 214 : 158;
      const tableBottom = afterTable.length ? 584 : 650;
      if (beforeTable.length) {
        const before = slide.shapes.add({ geometry: 'textbox', position: { left: 70, top: 154, width: 1140, height: noteHeight }, fill: 'none', line: { fill: 'none', width: 0 } });
        before.text = beforeTable.join('\n'); before.text.style = { typeface: family, fontSize: 15, color: '#51483E', autoFit: 'shrinkText' };
      }
      if (afterTable.length) {
        const after = slide.shapes.add({ geometry: 'textbox', position: { left: 70, top: 590, width: 1140, height: noteHeight }, fill: 'none', line: { fill: 'none', width: 0 } });
        after.text = afterTable.join('\n'); after.text.style = { typeface: family, fontSize: 15, color: '#51483E', autoFit: 'shrinkText' };
      }
      const table = slide.tables.add({ rows: matrix.length, columns, left: 54, top: tableTop, width: 1172, height: tableBottom - tableTop, values: matrix, columnWidths });
      table.styleOptions = { headerRow: hasHeader, bandedRows: true };
      table.borders.assign({ style: 'solid', fill: '#D7CDB8', width: 1 });
      if (hasHeader) table.cells.block({ row: 0, column: 0, rowCount: 1, columnCount: columns }).assign({ fill: '#214C3D', textStyle: { typeface: family, bold: true, color: '#FFFFFF', fontSize: columns > 6 ? 11 : 15 }, margins: { left: 6, right: 6, top: 4, bottom: 4 } });
      const bodyRow = hasHeader ? 1 : 0;
      if (matrix.length > bodyRow) table.cells.block({ row: bodyRow, column: 0, rowCount: matrix.length - bodyRow, columnCount: columns }).assign({ fill: '#FFFDF7', textStyle: { typeface: family, color: '#2D2923', fontSize: columns > 6 ? 10 : columns > 4 ? 13 : 15 }, margins: { left: 6, right: 6, top: 4, bottom: 4 }, anchor: 'middle' });
    } else {
      const blocks = [];
      let current = null;
      for (const line of lines) {
        const bullet = line.match(/^[•●▪·*-]\s*(.+)$/);
        const headingLike = !bullet && line.length <= 18 && !/[。；：，,:[\]]/.test(line);
        if (headingLike) {
          current = { heading: line, lines: [] };
          blocks.push(current);
        } else if (bullet) {
          if (!current) { current = { heading: '', lines: [] }; blocks.push(current); }
          current.lines.push(bullet[1]);
        } else {
          if (!current) { current = { heading: '', lines: [] }; blocks.push(current); }
          current.lines.push(line);
        }
      }
      const expanded = blocks.length === 1 && blocks[0].lines.length >= 4 && blocks[0].lines.length <= 6
        ? blocks[0].lines.map((line, itemIndex) => ({ heading: itemIndex === 0 ? blocks[0].heading : '', lines: [line] }))
        : blocks;
      if (expanded.length > 6) throw new Error(`幻灯片 ${index + 1} 含 ${expanded.length} 个内容块，固定页数内无法在不丢内容的情况下保持可读，请重新编排。`);
      const visible = expanded;
      const columns = visible.length > 3 ? 2 : 1;
      const rows = Math.ceil(visible.length / columns);
      const cardWidth = columns === 2 ? 532 : 1096;
      const cardHeight = visible.length === 1 ? 462 : Math.min(210, (462 - Math.max(0, rows - 1) * 16) / Math.max(1, rows));
      visible.forEach((block, blockIndex) => {
        const column = blockIndex % columns;
        const row = Math.floor(blockIndex / columns);
        const card = slide.shapes.add({ geometry: 'roundRect', position: { left: 82 + column * 564, top: 164 + row * (cardHeight + 16), width: cardWidth, height: cardHeight }, fill: '#FFFFFF', line: { fill: '#DED3BE', width: 1 } });
        card.text = `${block.heading}${block.lines.length ? `${block.heading ? '\n' : ''}${block.lines.map((line) => `•\u2060${line}`).join('\n')}` : ''}`;
        card.text.style = { typeface: family, fontSize: visible.length > 4 ? 16 : 18, color: '#2D2923', autoFit: 'shrinkText', margin: 14 };
      });
    }
    if (source.notes) slide.speakerNotes.textFrame.setText(String(source.notes));
    const preview = await presentation.export({ slide, format: 'png', scale: 1 });
    await fs.writeFile(`${outputPath}.slide-${index + 1}.png`, new Uint8Array(await preview.arrayBuffer()));
  }
  const stagingDir = `${outputPath}.staging`;
  await fs.mkdir(stagingDir, { recursive: true });
  const candidatePath = path.join(stagingDir, 'candidate.pptx');
  const workspaceDir = path.resolve(request.workspaceDir || path.dirname(path.dirname(outputPath)));
  const validationRoot = path.join(workspaceDir, '.artifact-validation');
  await fs.mkdir(validationRoot, { recursive: true });
  const validationDir = await fs.mkdtemp(path.join(validationRoot, `${path.basename(path.dirname(outputPath))}-${path.basename(outputPath)}-`));
  const validatedPath = path.join(stagingDir, `validated-${Date.now()}-${process.pid}.pptx`);
  await (await PresentationFile.exportPptx(presentation)).save(candidatePath);
  await finalizePresentation({
    workspaceDir, candidatePath, finalPath: validatedPath, pythonExecutable: runtimePython,
    integrityValidatorPath: path.join(skillDir, 'container_tools/inspect_presentation_package_integrity.py'),
    layoutValidatorPath: path.join(skillDir, 'container_tools/inspect_presentation_layout_geometry.py'),
    layoutArgs: ['--expected-slide-size-emu', '12192000,6858000', '--validate-bullet-geometry', '--validate-heading-fit'],
    explicitTotalSlideCount: slides.length, requiredNativeTableOwnerSlides: [], requiredNativeChartOwnerSlides: [],
    fontPolicy: { basis: 'design', families: [family] }, verifyArtifactToolImport: true,
    receiptPath: path.join(validationDir, 'validation.json'),
  });
  await fs.rename(validatedPath, outputPath);
}

if (request.kind === 'document') await buildDocument();
else if (request.kind === 'spreadsheet') await buildSpreadsheet();
else if (request.kind === 'presentation') await buildPresentation();
else throw new Error(`不支持制品类型 ${request.kind}。`);

const stat = await fs.stat(outputPath);
await fs.writeFile(`${outputPath}.receipt.json`, `${JSON.stringify({ kind: request.kind, outputPath, bytes: stat.size, contentSha256: request.contentSha256 || null, generatorRevision: request.generatorRevision || null, createdAt: new Date().toISOString(), ...receiptDetails }, null, 2)}\n`);
