import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DZ_CORE_SOURCE = 'Irixi installed DZ Skill: SKILL.md';
export const DZ_CORE_VERSION = '2026-10-25';
export const DZ_CORE_SOURCE_SHA256 = 'ae603ef89b5195af19424536cad7765d9630c4968f0a91b204f660b228af3a62';
const corePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dz-core-v20261025.md');
export const DZ_CORE_TEXT = fs.readFileSync(corePath, 'utf8');
if (crypto.createHash('sha256').update(DZ_CORE_TEXT, 'utf8').digest('hex') !== DZ_CORE_SOURCE_SHA256) {
  throw new Error('Bundled DZ core does not match its pinned source digest.');
}

// Host-specific mapping is kept separate from the complete frozen source text above.
export const DZ_HOST_ADAPTER = [
  'Host adapter (not part of the frozen DZ source): the current product uses the existing TaskStore as its only task ledger.',
  'References in the frozen source to .dz journals, local state scripts, snapshots, or repository commands are mapped to the trusted TaskStore snapshot and actual capability cards supplied below. Do not read or write the development repository .dz/ directory and do not create a second ledger or Harness.',
  'A model may propose a decision, plan, work item, or evidence summary. Only the existing Host action and its user-authored event can update accepted decisions or Host confirmation fields.',
].join('\n');
