/**
 * Tests for core/lib/skills.mjs
 *
 * Uses temp directories for the project / home skill roots so no real
 * filesystem state leaks in. Run: node tests/skills.test.mjs
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseSkillFrontmatter,
  collectAvailableSkills,
  clearSkillsCache,
} from '../scripts/lib/skills.mjs';

const roots = [];

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'nudge-skills-'));
  roots.push(root);
  return root;
}

function writeSkill(base, ...segments) {
  const content = segments.pop();
  const dir = join(base, ...segments);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), content);
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('parseSkillFrontmatter', () => {
  it('extracts name and description', () => {
    const fm = parseSkillFrontmatter(
      '---\nname: unit-test\ndescription: Run Jest tests\n---\n\nBody',
    );
    assert.deepEqual(fm, { name: 'unit-test', description: 'Run Jest tests' });
  });

  it('strips surrounding quotes', () => {
    const fm = parseSkillFrontmatter("---\nname: 'deploy'\n---\n");
    assert.equal(fm.name, 'deploy');
  });

  it('returns empty object without frontmatter', () => {
    assert.deepEqual(parseSkillFrontmatter('# Just markdown'), {});
    assert.deepEqual(parseSkillFrontmatter('---\nunterminated'), {});
    assert.deepEqual(parseSkillFrontmatter(undefined), {});
  });
});

describe('collectAvailableSkills', () => {
  let cwd;
  let home;

  beforeEach(() => {
    clearSkillsCache();
    cwd = makeRoot();
    home = makeRoot();
  });

  it('collects project, global, and plugin skills with origins', () => {
    writeSkill(cwd, '.claude', 'skills', 'deploy', '---\nname: deploy\ndescription: Ship it\n---\n');
    writeSkill(home, '.claude', 'skills', 'review', '---\nname: review\ndescription: Review code\n---\n');
    writeSkill(
      home, '.claude', 'plugins', 'cache', 'mp', 'codex', '1.0.0', 'skills', 'rescue',
      '---\nname: rescue\ndescription: Second pass\n---\n',
    );

    const skills = collectAvailableSkills({ cwd, home, env: {} });
    assert.deepEqual(skills, [
      { name: 'deploy', description: 'Ship it', origin: 'project' },
      { name: 'review', description: 'Review code', origin: 'global' },
      { name: 'rescue', description: 'Second pass', origin: 'plugin' },
    ]);
  });

  it('falls back to the directory name and omits missing descriptions', () => {
    writeSkill(cwd, '.claude', 'skills', 'no-meta', '---\nauthor: yu\n---\n');
    const skills = collectAvailableSkills({ cwd, home, env: {} });
    assert.deepEqual(skills, [{ name: 'no-meta', origin: 'project' }]);
  });

  it('skips directories without SKILL.md', () => {
    mkdirSync(join(cwd, '.claude', 'skills', 'empty-dir'), { recursive: true });
    assert.deepEqual(collectAvailableSkills({ cwd, home, env: {} }), []);
  });

  it('dedupes by name with project precedence', () => {
    writeSkill(cwd, '.claude', 'skills', 'deploy', '---\nname: deploy\ndescription: Project one\n---\n');
    writeSkill(home, '.claude', 'skills', 'deploy', '---\nname: deploy\ndescription: Global one\n---\n');
    const skills = collectAvailableSkills({ cwd, home, env: {} });
    assert.equal(skills.length, 1);
    assert.equal(skills[0].description, 'Project one');
    assert.equal(skills[0].origin, 'project');
  });

  it('caps the list at 24 and truncates long descriptions', () => {
    for (let i = 0; i < 30; i++) {
      writeSkill(
        cwd, '.claude', 'skills', `skill-${String(i).padStart(2, '0')}`,
        `---\nname: skill-${i}\ndescription: ${'x'.repeat(400)}\n---\n`,
      );
    }
    const skills = collectAvailableSkills({ cwd, home, env: {} });
    assert.equal(skills.length, 24);
    assert.equal(skills[0].description.length, 300);
  });

  it('returns [] when NUDGE_DISABLE_SKILLS is set', () => {
    writeSkill(cwd, '.claude', 'skills', 'deploy', '---\nname: deploy\n---\n');
    const skills = collectAvailableSkills({
      cwd, home, env: { NUDGE_DISABLE_SKILLS: '1' },
    });
    assert.deepEqual(skills, []);
  });

  it('returns [] for missing roots without throwing', () => {
    assert.deepEqual(
      collectAvailableSkills({ cwd: '/nonexistent-a', home: '/nonexistent-b', env: {} }),
      [],
    );
  });

  it('serves cached results until cleared', () => {
    writeSkill(cwd, '.claude', 'skills', 'deploy', '---\nname: deploy\n---\n');
    const first = collectAvailableSkills({ cwd, home, env: {} });
    assert.equal(first.length, 1);

    writeSkill(cwd, '.claude', 'skills', 'second', '---\nname: second\n---\n');
    assert.equal(collectAvailableSkills({ cwd, home, env: {} }).length, 1);

    clearSkillsCache();
    assert.equal(collectAvailableSkills({ cwd, home, env: {} }).length, 2);
  });
});
